# Regression Eval Set — Design Spec

**Date:** 2026-07-11
**Status:** DRAFT — pending user approval
**Extends:** `2026-07-10-agent-memory-design.md`; motivated by research report QC #7
("agents strongly follow whatever memory is retrieved — store quality dominates;
measure what's served") and the empirical finding that agents follow retrieved
memories including wrong ones.

## 1. Goal

A deterministic regression harness that answers two questions after any prompt,
model, threshold, or ranking change:

1. **Extraction quality** — does the distiller still extract the knowledge it
   should, and still extract NOTHING from noise? (The fuse for switching to the
   company vLLM model.)
2. **Retrieval quality** — does search still surface the expected memory for
   realistic queries? (The fuse for ranking/FTS changes.)

Design principle: **the judge is deterministic** (type + keyword matching, no
LLM grader) — an LLM-graded eval would drift with the very model changes it is
supposed to measure.

## 2. Layout

```
eval/
  fixtures/                    # extraction fixtures: REAL collector transcripts
    ppa-timing-closure.md      #   (sanitized copies of sessions proven on this
    noise-chitchat.md          #    machine: PPA 6-type extraction, long chit-chat
    monetary-decimal.md        #    zero-extraction, decimal/monetary decision)
    ...
  cases.json                   # extraction expectations (schema §3)
  retrieval/
    store/memories/...         # golden memory files (real entries, checked in)
    queries.json               # retrieval expectations (schema §4)
  run.ts                       # the harness (bun run eval)
  results.jsonl                # append-only run history (committed manually)
```

Fixtures are REAL transcripts from this machine's sessions (private repo;
content authored during development). Sanitization pass on check-in: no
credentials, no external names. A hand-written fixture may be added later for
cases real sessions don't cover (e.g. secret-bearing conversation → quarantine
path), but phase 1 ships with real ones only.

## 3. Extraction eval

Per fixture, `run.ts` executes the REAL pipeline stages in isolation:
`parseTranscript` → `buildExtractPrompt` → `LlmClient.complete` (backend from
`clientFromEnv` — opencode-run by default, vLLM via the standard env vars) →
`validateCandidates`. No reconcile, no store writes — an eval run never touches
`~/.agent-memory`.

`cases.json` schema:

```jsonc
[
  {
    "fixture": "ppa-timing-closure.md",
    "salience_min": 6,               // optional, default 6
    "expect": [                      // each must be matched by >= min candidates
      { "type": "decision", "keywords": ["useful skew"], "min": 1 },
      { "type": "pitfall",  "keywords": ["synthesis", "PnR"] },
      { "type": "root_cause", "keywords": ["pipeline", "accumulator"] }
    ],
    "forbid": [                      // NO candidate may match any of these
      { "keywords": ["lunch"] }
    ],
    "max_extra": 5                   // precision guard: unmatched-candidate cap
  },
  {
    "fixture": "noise-chitchat.md",
    "expect": [],
    "max_total": 0                   // the noise contract: zero candidates
  }
]
```

Matching rule (deterministic): a candidate matches an expectation iff
`candidate.type === expect.type` (when given) AND every keyword appears
case-insensitively in `title + trigger + lesson`. `forbid` entries use the same
rule (type optional). `max_extra` counts valid candidates matched by no
expectation; `max_total` caps total valid candidates (for noise fixtures).

Per-fixture verdict: all `expect` met AND no `forbid` hit AND caps respected.
LLM output that fails to parse/validate counts as an eval FAILURE for that
fixture (that IS the schema-fidelity signal the vLLM switch needs), reported
distinctly (`error` vs `miss`).

## 4. Retrieval eval

Golden store: a checked-in snapshot of real memory files under
`eval/retrieval/store/memories/…`. The harness builds a THROWAWAY index in a
tmp dir (`rebuildFrom`), then runs `searchMemory` per query:

```jsonc
[
  { "query": "useful skew setup timing", "expect_id": "mem_20260710_8cd55e", "within_top": 3 },
  { "query": "Decimal monetary float",   "expect_id": "mem_20260710_624036", "within_top": 1 },
  { "query": "時序收斂",                  "expect_id": "mem_x…",              "within_top": 3 }
]
```

Pass iff `expect_id` appears within the first `within_top` results. Fully
deterministic, zero LLM calls, runs in milliseconds — also executes in `bun
test`? No: kept OUT of the unit suite (fixtures are data, thresholds are
policy), but the harness itself gets unit tests with a FakeLlm.

## 5. Runner and history

- `bun run eval` → both suites; `bun run eval --extraction-only|--retrieval-only`.
- Scorecard to stdout: per-fixture/per-query lines + totals
  (`extraction: 3/3 fixtures, expectations 8/8, 0 forbidden, 1 extra` /
  `retrieval: 5/5 queries`).
- Exit code: 0 all pass; 1 any failure (CI-compatible).
- History: one JSON line appended to `eval/results.jsonl` per run:
  `{ ts, model: llm.describe(), extraction: { fixtures_pass, fixtures_total, expectations_met, expectations_total, forbidden_hits, extras, errors }, retrieval: { pass, total }, pass: bool }`
  — switching models becomes a two-line diff. Committed manually (the file is
  tracked, appends are left to the user to commit when meaningful).

## 6. Testing (of the harness itself)

- Matcher/scoring: pure-function unit tests (type+keyword matching, min counts,
  forbid, max_extra/max_total, error-vs-miss classification).
- Runner: FakeLlm end-to-end over a tiny fixture — pass and fail paths, JSONL
  line shape, exit codes.
- Retrieval path: golden-store build + query assertions (deterministic, real).

## 7. Out of scope (phase 1)

- LLM-judged semantic grading; multi-run averaging for nondeterminism
  (single run, temperature 0 on vLLM); reconcile-stage eval; auto-committing
  results; CI wiring (the exit code makes it trivial later).
