# Regression Eval Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bun run eval` — deterministic extraction + retrieval regression harness with JSONL history, per spec `docs/superpowers/specs/2026-07-11-regression-eval-design.md`.

**Architecture:** `eval/match.ts` (pure matcher/scoring) + `eval/run.ts` (runner with injectable LLM, tmp-index retrieval, scorecard, results.jsonl) + curated real fixtures. Reuses distiller modules (`transcripts`, `extract`, `llm`, `ledger`, `store`) and `mcp-server/query` (searchMemory) — the eval exercises the REAL pipeline code paths.

**Tech Stack:** unchanged; zero new dependencies.

## Global Constraints

- The judge is deterministic — no LLM grading anywhere in scoring.
- An eval run NEVER touches `~/.agent-memory` (fixtures read from the repo; retrieval index built in a per-run tmp dir; extraction skips reconcile/commit entirely).
- LLM output that fails parse/validation = fixture status `"error"` (distinct from `"fail"`), still fails the run — that is the schema-fidelity signal.
- Expectations must be chosen for cross-model robustness: match on the strongest content signals (min 1, generous `max_extra`), not on exact counts of a specific model's output.
- Unit tests use FakeLlm only; `bun test` must not invoke any real LLM and must not read `eval/results.jsonl`.
- Tests: per-test tmp dirs; poll never sleep.
- Commits: conventional + the standard trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01ALAk5sCENNGXZyy6mSg8tF`

---

### Task 1: fixtures, cases, golden store, queries (data curation)

**Files:**
- Create: `eval/fixtures/ppa-timing-closure.md`, `eval/fixtures/noise-chitchat.md`, `eval/fixtures/monetary-decimal.md`, `eval/cases.json`, `eval/retrieval/store/memories/...` (4 entries), `eval/retrieval/queries.json`

**Steps:**

- [ ] **Step 1: Copy the three real transcripts** (verify each parses with `parseTranscript` via a throwaway script; run `scanSecrets` from distiller/extract.ts over each body — must return `[]`):
  - `~/.agent-memory/transcripts/tmp/ses_0b46ff7bfffe11gFC1EsTOEGBF.md` → `eval/fixtures/ppa-timing-closure.md` (the 3-turn PPA timing-closure session)
  - `~/.agent-memory/transcripts/tmp/ses_0b487b2abffeCvJd8jSiSugIwr.md` → `eval/fixtures/noise-chitchat.md` (the padded chit-chat session)
  - the transcript in `~/.agent-memory/transcripts/test_folder/` whose session id appears in the `evidence` frontmatter of `~/.agent-memory/store/memories/test_folder/mem_20260710_624036.md` (the Decimal-for-monetary session) → `eval/fixtures/monetary-decimal.md`
  Copies are verbatim (frontmatter incl. content_hash stays as-is; the eval parses them like any spool transcript).

- [ ] **Step 2: Write `eval/cases.json`** (expectations reflect behavior already OBSERVED on these exact sessions — see the distilled memories under `~/.agent-memory/store/memories/` for ground truth; keywords must appear in the actual extracted titles/lessons AND in the transcript's obvious content so they are model-robust):

```json
[
  {
    "fixture": "ppa-timing-closure.md",
    "expect": [
      { "type": "decision", "keywords": ["useful skew"] },
      { "type": "pitfall", "keywords": ["synthesis"] },
      { "keywords": ["retiming"] }
    ],
    "forbid": [
      { "keywords": ["lunch"] },
      { "keywords": ["joke"] }
    ],
    "max_extra": 8
  },
  {
    "fixture": "monetary-decimal.md",
    "expect": [
      { "keywords": ["Decimal"] }
    ],
    "forbid": [],
    "max_extra": 8
  },
  {
    "fixture": "noise-chitchat.md",
    "expect": [],
    "max_total": 0
  }
]
```

- [ ] **Step 3: Golden retrieval store** — copy these real entries into `eval/retrieval/store/memories/<project>/` preserving their project subdirs:
  - `tmp/mem_20260710_8cd55e.md` (useful-skew ban, decision)
  - `tmp/mem_20260710_95cd04.md` (synthesis-vs-PnR pitfall)
  - `test_folder/mem_20260710_624036.md` (Decimal monetary decision)
  Plus ONE hand-written CJK entry `eval/retrieval/store/memories/tmp/mem_20260711_cjk001.md` — build it WITH `serializeEntry` (throwaway script) so it round-trips: type `know_how`, title `"時序收斂前先跑 retiming"`, trigger `"當 block 在 PnR 後 setup 時序不收斂時"`, lesson `"在慢角優先修 hold，時序收斂前先跑 retiming，再做選擇性 LVT swap。"`, domain `["timing-closure"]`, project `tmp`, confidence 0.65, status active, evidence citing session `ses_manual_cjk` anchor `msg_manual`, `supersedes: null`. Verify it parses with `readEntry`.

- [ ] **Step 4: `eval/retrieval/queries.json`:**

```json
[
  { "query": "useful skew setup timing", "expect_id": "mem_20260710_8cd55e", "within_top": 3 },
  { "query": "Decimal monetary float", "expect_id": "mem_20260710_624036", "within_top": 1 },
  { "query": "synthesis slack multiplier", "expect_id": "mem_20260710_95cd04", "within_top": 3 },
  { "query": "時序收斂", "expect_id": "mem_20260711_cjk001", "within_top": 3 }
]
```

- [ ] **Step 5: Sanity + commit** — throwaway script: all 3 fixtures `parseTranscript` OK + `scanSecrets` clean; all 4 golden entries `readEntry` OK. `bun test && bun run typecheck` untouched-green. Commit: `feat(eval): golden fixtures, cases, and retrieval store from real sessions`

---

### Task 2: eval/match.ts — deterministic matcher and scoring

**Files:**
- Create: `eval/match.ts`
- Test: `eval/match.test.ts`

**Interfaces:**
```ts
import type { Candidate } from "../distiller/extract"

export interface ExpectRule { type?: string; keywords: string[]; min?: number }
export interface ForbidRule { type?: string; keywords: string[] }
export interface ExtractionCase {
  fixture: string; salience_min?: number
  expect: ExpectRule[]; forbid?: ForbidRule[]
  max_extra?: number; max_total?: number
}
export interface CaseScore {
  fixture: string
  status: "pass" | "fail"
  expectationsMet: number; expectationsTotal: number
  forbiddenHits: string[]        // "matched forbid {keywords} : <candidate title>"
  extras: number                 // valid candidates matched by NO expect rule
  failures: string[]             // human-readable reasons
}
export function candidateMatches(c: Candidate, rule: { type?: string; keywords: string[] }): boolean
export function scoreCase(kase: ExtractionCase, candidates: Candidate[]): CaseScore
```
- `candidateMatches`: type equal when rule.type given; every keyword lowercase-substring of `${title} ${trigger} ${lesson}`.lowercase.
- `scoreCase`: each expect rule met iff `count(matching candidates) >= (min ?? 1)`; forbidden hits collected per candidate×rule; `extras` = candidates matching no expect rule; fail reasons: unmet rule (`expect[i] {type,keywords} matched 0 < 1`), forbidden hit, `extras N > max_extra M`, `total N > max_total M`. `max_extra` default Infinity, `max_total` default Infinity.

- [ ] **Step 1: Write the failing tests** — `eval/match.test.ts` covering: keyword case-insensitivity + all-keywords-required; type filter; min counts (2 required, 1 found → fail); forbid hit fails with reason; extras counted only for non-matching candidates and capped by max_extra; max_total 0 passes on empty and fails on 1 candidate; a fully-passing PPA-like case.
- [ ] **Step 2: FAIL** (`bun test eval/match.test.ts` — module missing).
- [ ] **Step 3: Implement** (pure functions, ~60 lines).
- [ ] **Step 4: PASS** + `bun run typecheck` + full `bun test`.
- [ ] **Step 5: Commit** `feat(eval): deterministic extraction matcher and case scoring`

---

### Task 3: eval/run.ts — runner, scorecard, history, exit codes

**Files:**
- Create: `eval/run.ts`
- Modify: `package.json` (script `"eval": "bun eval/run.ts"`)
- Test: `eval/run.test.ts`

**Interfaces:**
```ts
export interface EvalOptions {
  evalDir: string                       // dir containing fixtures/, cases.json, retrieval/
  mode?: "all" | "extraction" | "retrieval"
  llm?: LlmClient                       // default clientFromEnv()
  out?: (line: string) => void          // default console.log
  resultsPath?: string | null           // default `${evalDir}/results.jsonl`; null = no history write
  now?: Date
}
export interface EvalRunSummary {
  pass: boolean
  extraction?: { fixturesPass: number; fixturesTotal: number; expectationsMet: number; expectationsTotal: number; forbiddenHits: number; extras: number; errors: number }
  retrieval?: { pass: number; total: number }
}
export async function runEval(opts: EvalOptions): Promise<EvalRunSummary>
// import.meta.main guard: parse --extraction-only/--retrieval-only, runEval with repo eval/ dir, process.exit(summary.pass ? 0 : 1)
```
Behavior:
- **Extraction**: for each case in `cases.json`: read + `parseTranscript` the fixture; `buildExtractPrompt`; `llm.complete({system: system + salience line, prompt, schema: EXTRACT_SCHEMA})` (same shape as pipeline.ts); `validateCandidates(raw, meta, salience_min ?? 6)`; `scoreCase(kase, validated.valid)`. Any throw (LLM error, parse error) → fixture status `"error"` counted in `errors` and failing the run; print the error line. Per-fixture output line: `✓/✗ <fixture> — expectations a/b, forbidden n, extras m` (or `! <fixture> — error: …`).
- **Retrieval**: build `MemoryIndex` at `<tmpdir>/index.db`, `rebuildFrom(`${evalDir}/retrieval/store`)`, then per query in `queries.json`: `searchMemory(index, { query })` (from mcp-server/query) → pass iff `expect_id` within first `within_top` hits. Output line per query. Close index; tmp dir per run.
- **Scorecard totals + history**: print totals; unless `resultsPath === null`, append one JSON line: `{ ts: now.toISOString(), model: llm.describe(), extraction, retrieval, pass }`.

- [ ] **Step 1: Write the failing tests** — `eval/run.test.ts` builds a MINI eval dir in tmp (one tiny fixture transcript written with the same shape as Task 3 of the distiller plan's test transcripts; a cases.json with one expect; a retrieval store with one entry written via `writeEntry` + queries.json):
  - FakeLlm returning a matching candidate → `runEval` pass true, extraction 1/1, retrieval 1/1; results.jsonl gets exactly one line with `model: "fake"` and `pass: true`.
  - FakeLlm returning `[]` → pass false (expectation unmet), status counted as fail not error.
  - FakeLlm throwing → extraction errors 1, pass false.
  - `mode: "retrieval"` → no LLM call (FakeLlm with a call counter asserts 0), summary has no `extraction`.
  - `resultsPath: null` → no file written.
  - bad query id (expect_id not in store) → retrieval fail, pass false.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: Implement** + package.json script.
- [ ] **Step 4: PASS** + typecheck + full `bun test`.
- [ ] **Step 5: Commit** `feat(eval): regression runner with scorecard, history, and ci exit codes`

---

### Task 4: docs + VERIFY + baseline run

**Files:**
- Modify: `README.md`, `LLM_WIKI.md`, `.gitignore` (nothing to ignore — results.jsonl is tracked; confirm)
- Create: `docs/superpowers/VERIFY-eval.md`

**Steps:**

- [ ] **Step 1: README** — "Regression eval" section: what it guards (model/prompt/ranking changes), commands, cases.json/queries.json schema summary, how to add a fixture, results.jsonl diff workflow for model switches (`AGENT_MEMORY_LLM=vllm … bun run eval --extraction-only`).
- [ ] **Step 2: LLM_WIKI（繁中）** — 回歸評測章節：兩套評測的角色、確定性判分原則（為何不用 LLM judge）、fixture 增補流程、換模型驗收 SOP（跑兩次確認穩定 → diff results.jsonl）。
- [ ] **Step 3: `docs/superpowers/VERIFY-eval.md`:**

```markdown
# VERIFY — regression eval

Status: PENDING

Headless (executor MUST run):
1. bun test — all green.  2. bun run typecheck — clean.
3. bun run eval --retrieval-only → 4/4 queries pass (incl. the CJK query), <1s, exit 0.
4. bun run eval (opencode backend) → full scorecard; extraction fixtures 3/3
   (noise fixture MUST report 0 candidates); results.jsonl gains a baseline line.
5. Run item 4's extraction a SECOND time → still 3/3 (expectation robustness
   across LLM nondeterminism). If a case flakes, loosen its keywords (that is
   fixture tuning, not code change) and note it here.

Interactive (user):
6. When the company vLLM endpoint is available: AGENT_MEMORY_LLM=vllm … bun run
   eval → compare the new results.jsonl line against the baseline.
```

- [ ] **Step 4: Gates + baseline** — `bun test && bun run typecheck`; execute VERIFY items 3-5 for real (this machine, opencode backend), record results in VERIFY-eval.md.
- [ ] **Step 5: Commit** `docs: regression eval usage, verification, and baseline results`
