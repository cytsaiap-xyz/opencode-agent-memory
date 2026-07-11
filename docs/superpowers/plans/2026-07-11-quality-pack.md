# Extraction Quality Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM triage, extraction self-consistency (N-run union + deterministic pool dedup), multi-judge salience voting, and eval multi-run averaging — per spec `docs/superpowers/specs/2026-07-11-quality-pack-design.md`. Quality-first: all features default ON.

**Architecture:** new pure modules `distiller/pool.ts` (dedup/merge) and `distiller/judge.ts` (median consensus) + `distiller/triage.ts` (LLM gate); pipeline order becomes INGEST → TRIAGE(llm) → EXTRACT×N → VALIDATE(per run) → POOL-DEDUP → JUDGE → RECONCILE → COMMIT → PUBLISH. All LLM variance stays in triage/extract/judge calls; everything between is pure and unit-tested.

## Global Constraints

- Fail-open on gate hiccups: triage LLM error → extract anyway; all judges fail → extractor self-score stands; ONE extraction run erroring is tolerated (logged), ALL runs erroring fails the transcript (counted in `errors`, not ledgered — retries next run).
- Pipeline reads NO env vars — new options `{ triage: "llm"|"heuristic", extractRuns: number, judges: number }` with defaults ("llm", 2, 3) resolved at the CLI layer from `AGENT_MEMORY_TRIAGE` / `AGENT_MEMORY_EXTRACT_RUNS` / `AGENT_MEMORY_JUDGES` (validated: runs 1-5, judges 0-5).
- Deterministic pool-dedup rule EXACTLY per spec §2: same `type` AND (title token-set Jaccard ≥ 0.6 OR identical trigger) → merge keeping longer lesson, union evidence (dedup by message_id), salience = max.
- Judge consensus = median; even N uses lower-middle; abstentions shrink the panel; provenance annotated `judges: k/N median m`.
- Governance and existing counters unchanged; new counters additive (`poolRaw`, `triagedLlm`, `triagedHeuristic` — `triagedOut` remains as their sum for backward compat).
- FakeLlm only in `bun test`; existing 196 tests stay green (pipeline tests updated ONLY where they must pass new options to keep old behavior: use `{ triage: "heuristic", extractRuns: 1, judges: 0 }` to pin legacy semantics in old tests, then new tests cover the new defaults).
- Commits: conventional + standard trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01ALAk5sCENNGXZyy6mSg8tF`

---

### Task 1: distiller/pool.ts — self-consistency pool (pure)

**Files:** Create `distiller/pool.ts`; Test `distiller/pool.test.ts`

**Interfaces:**
```ts
import type { Candidate } from "./extract"
export function titleJaccard(a: string, b: string): number   // unicode token sets, same split regex as elsewhere
export function isDuplicate(a: Candidate, b: Candidate): boolean  // spec rule
export function mergeCandidates(a: Candidate, b: Candidate): Candidate  // longer lesson wins, evidence union (dedup message_id), salience max, volatile OR, domain union
export function dedupPool(pool: Candidate[]): { candidates: Candidate[]; merged: number }
```
`dedupPool`: greedy left-to-right — each candidate merges into the first existing pool member it duplicates, else appends. Tests: Jaccard boundary cases (0.6 exactly passes ≥, CJK titles tokenize), identical-trigger shortcut, different-type never merges, merge field rules each pinned, 3-way chain merge, empty pool, `merged` count.

Commit: `feat(distiller): deterministic candidate pool dedup for self-consistency`

---

### Task 2: distiller/judge.ts — multi-judge salience (pure consensus + LLM calls)

**Files:** Create `distiller/judge.ts`; Test `distiller/judge.test.ts`

**Interfaces:**
```ts
import type { Candidate } from "./extract"
import type { LlmClient } from "./llm"
export const JUDGE_SCHEMA: Record<string, unknown>   // {salience: number, reason: string}
export function buildJudgePrompt(c: Candidate): { system: string; prompt: string }
export function medianConsensus(scores: number[]): number   // sorted, odd→middle, even→lower-middle
export interface JudgeVerdict { salience: number; panel: number; voted: number; selfScore: number; usedFallback: boolean }
export async function judgeCandidate(c: Candidate, llm: LlmClient, judges: number): Promise<JudgeVerdict>
```
`judgeCandidate`: N sequential calls (strict JSON parse via stripFences; out-of-range/NaN salience or throw = abstain); `voted === 0` → fallback to `c.salience` (`usedFallback: true`); else median. System prompt: the 6-type criteria + the six-months bar + "score 0-10, reply ONLY {\"salience\": n, \"reason\": \"…\"}". Tests (FakeLlm scripted): median odd/even/lower-middle pinned; abstention shrinks panel; all-abstain fallback; range clamp/reject; judges=0 short-circuits (no LLM calls, fallback verdict).

Commit: `feat(distiller): multi-judge salience with median consensus`

---

### Task 3: distiller/triage.ts + pipeline wiring of all three features

**Files:** Create `distiller/triage.ts`; Modify `distiller/pipeline.ts`, `distiller/cli.ts`; Tests `distiller/triage.test.ts` + `distiller/pipeline.test.ts` additions

**triage.ts:**
```ts
export const TRIAGE_SCHEMA: Record<string, unknown>
export function buildTriagePrompt(meta: TranscriptMeta): { system: string; prompt: string }
export interface TriageResult { worth: boolean; why: string; failedOpen: boolean }
export async function llmTriage(meta: TranscriptMeta, llm: LlmClient): Promise<TriageResult>  // error/bad JSON → { worth: true, failedOpen: true }
```
**pipeline.ts:** new `PipelineOptions` fields `{ triage?: "llm" | "heuristic"; extractRuns?: number; judges?: number }` defaults ("llm", 2, 3); hard floor `body.length < 80` always heuristic-skips; heuristic mode keeps the 400 floor; llm mode calls llmTriage above the 80 floor (worth=false → ledger 0-candidates + `triagedLlm++`; failedOpen → stderr note, proceed). EXTRACT loop: `extractRuns` sequential `extractFromTranscript` calls, each validated; per-run error logged + tolerated, all-error → `errors++` continue (not ledgered); union valid candidates + secrets across runs → `dedupPool` (secrets deduped by title via same isDuplicate) → judges (when > 0): `judgeCandidate` each pooled candidate, drop `salience < salienceMin` after consensus, annotate provenance string. Summary: `poolRaw`, `triagedLlm`, `triagedHeuristic` (with `triagedOut` = sum), judges reflected in extractor label (`… judges:3`).
**cli.ts:** parse the three envs with validation (bad values → friendly error exit 1), pass options.
**Tests:** triage unit (worth/not/fail-open); pipeline scripted FakeLlm: llm-triage-out ledgered; 80-floor bypasses LLM; runs=2 union visible (run1 misses a candidate run2 has → both in pool); one-run-error tolerated / all-error not ledgered; judges drop a low-median candidate and keep a high one; legacy pinning: old tests updated with `{triage:"heuristic",extractRuns:1,judges:0}` stay byte-identical in behavior.

Commit: `feat(distiller): llm triage, n-run extraction, and judge gating in the pipeline`

---

### Task 4: eval --runs N + pass-rate

**Files:** Modify `eval/run.ts`; Test `eval/run.test.ts` additions

- `EvalOptions` gains `runs?: number` (default 1) and `passRate?: number` (default 1.0); CLI flags `--runs N` / `--pass-rate 0.8` (extraction suite only).
- Per fixture: N independent extraction runs (each = LLM call + validate + scoreCase); fixture `rate = passes/N`; passes iff `rate ≥ passRate`. Errors count against rate (an error run is a failed run) but are still tallied in `errors` separately.
- Scorecard per fixture: `✓/✗ <fixture> — pass-rate 3/3` (or `2/3 < required`); results.jsonl extraction object gains `runs`, and per-run aggregate `fixturePassRates: { [fixture]: rate }`.
- Tests (FakeLlm scripted sequences): runs=3 with 2 pass + 1 fail → rate 0.67, passes at --pass-rate 0.6, fails at default 1.0; error run counted into rate; runs=1 default identical to old behavior (regression pin); retrieval unaffected by --runs.

Commit: `feat(eval): multi-run extraction averaging with pass-rate thresholds`

---

### Task 5: docs + VERIFY + real-machine validation

**Files:** Modify `README.md`, `LLM_WIKI.md`, `scripts/run-distill.sh` (no change needed unless envs documented there — document envs in README cron example); Create `docs/superpowers/VERIFY-quality-pack.md`

- README: Quality pack section — the three distiller envs + defaults, pipeline order diagram update, eval --runs/--pass-rate, model-switch SOP updated (`AGENT_MEMORY_LLM=vllm … bun run eval --extraction-only --runs 3`).
- LLM_WIKI（繁中）: 品質包章節（triage fail-open 語義、pool dedup 規則、judge 中位數、與治理/計數器的關係）、管線順序圖更新、環境變數表。
- VERIFY-quality-pack.md:
  ```markdown
  # VERIFY — quality pack
  Status: PENDING
  Headless (executor MUST run):
  1. bun test — green. 2. bun run typecheck — clean.
  3. Real quality-pack distill (opencode backend, scratch HOME, 2 real
     transcripts copied from ~/.agent-memory/transcripts/tmp/): defaults
     (llm triage, runs 2, judges 3) → memories produced; run log shows triage
     verdicts, pool merge count, judge medians in provenance; compare entry
     count/quality vs the same transcripts with legacy options.
  4. bun run eval --extraction-only --runs 3 (opencode backend) → per-fixture
     pass-rates recorded to results.jsonl as the new stability baseline.
  5. Idempotency unchanged: rerun item 3 → already-done.
  Interactive (user): 6. company vLLM: rerun items 3-4, compare.
  ```
- Execute headless 1-5 for real; record results.
- Commit: `docs: quality pack usage, pipeline order, and verification baseline`
