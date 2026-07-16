# Parallel Distiller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** global LLM concurrency limiter (default 8, `AGENT_MEMORY_CONCURRENCY`) + two-phase pipeline (parallel prepare, single-writer commit) per spec `docs/superpowers/specs/2026-07-16-parallel-distiller-design.md`.

## Global Constraints

- Determinism contract (spec §2) is THE acceptance bar: concurrency N and 1 produce byte-identical store trees (injected `now`) and equal ledger row sets. The equivalence test is mandatory, uses a content-keyed FakeLlm.
- Phase A performs ZERO store/index/ledger writes; phase B is strictly sequential in the original metas order.
- Judge/extract error semantics unchanged (abstention, one-run-tolerated, all-runs-error → not ledgered).
- Existing call-order-scripted tests pin `concurrency: 1` via the LEGACY constant; no test deleted/weakened.
- Pipeline env-free; env parsed at CLI (int 1-32, default 8, friendly errors).
- Commits: conventional + standard trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01ALAk5sCENNGXZyy6mSg8tF`

---

### Task 1: distiller/limiter.ts — Semaphore + withConcurrencyLimit

**Files:** Create `distiller/limiter.ts`; Test `distiller/limiter.test.ts`

Interfaces per spec §1.1. Semaphore: `acquire()` resolves with a release fn; FIFO waiters; release idempotent (double-release guarded). Decorator: wraps `complete` with acquire/finally-release; `describe()` passthrough.

Tests (gate-controlled fake llm — a complete() that blocks on a manually-resolved promise): max in-flight never exceeds limit (track concurrent count with a probe counter across 10 queued calls, limit 3); FIFO completion order; permit released when complete() throws (subsequent call proceeds); limit=1 fully serializes; describe passthrough.

Commit: `feat(distiller): llm concurrency limiter with fifo semaphore`

---

### Task 2: parallel judge panels + parallel extract runs

**Files:** Modify `distiller/judge.ts`, `distiller/pipeline.ts` (extract loop only); Tests: `distiller/judge.test.ts` (adjust), `distiller/pipeline.test.ts` (adjust)

- `judgeCandidate`: the N judge calls become `Promise.all` over an array of per-call async fns, each with its own try/catch → abstain slot (null), then filter and median exactly as today. `judges <= 1` short-circuit unchanged. Tests asserting sequential call COUNTS stay valid; any test asserting inter-call ordering is updated (verify none does — the FakeLlm scripted replies are consumed in call order; with Promise.all the calls still START in array order so a synchronous scripted fake consumes replies deterministically — verify and document this in the test file).
- Pipeline extract loop: `Promise.all(runIndices.map(async i => { try { return await extractFromTranscript(...) } catch (e) { log; return null } }))` → filter nulls, concat validated results IN ARRAY (run-index) ORDER; all-null → throw (unchanged). The per-run stderr log lines keep the run index.
- Gates: full suite green (existing tests still effectively sequential because FakeLlm's complete() resolves synchronously — verify; where a test genuinely depends on strict alternation of extract/judge replies across stages, pin it with a content-keyed fake or reorder replies; document each such change in the commit body).

Commit: `feat(distiller): parallel judge panels and extraction runs`

---

### Task 3: two-phase pipeline + equivalence proof

**Files:** Modify `distiller/pipeline.ts`; Tests `distiller/pipeline.test.ts` (LEGACY pinning + new tests), new helper in test file (content-keyed FakeLlm)

- `PipelineOptions` gains `concurrency?: number` (default 8). Phase A: map metas → bounded tasks (Semaphore from Task 1, limit = concurrency) producing `PreparedTranscript { meta, kept: Candidate[], secrets: […], counters: {…}, error?: string, ledgerable: boolean }`; INGEST ledger check happens BEFORE phase A dispatch (read-only `isProcessed` — adjudicate: reads are safe concurrent; keep the check in the dispatch loop, sequential, before task creation). TRIAGE/extract/validate/pool/judge all inside the task; NO writes.
- Phase B: iterate prepared results in metas order: write secrets via writeQuarantineEntry, reconcile candidates, recordProcessed — logic byte-identical to today's per-meta tail.
- Counters aggregate identically (sum over prepared + phase B ops).
- LEGACY constant gains `concurrency: 1`; sweep existing tests.
- New tests: (a) equivalence — content-keyed FakeLlm (replies selected by matching the prompt/system content, never by call order), 3 transcripts with overlapping candidates, run pipeline twice into two scratch stores with SAME injected now, concurrency 1 vs 4 → recursive file-tree comparison byte-identical (memories/ + quarantine/ + INDEX.md), ledger row sets equal ignoring processed_at, summaries equal; (b) phase-B ordering — a delayed fake making transcript 2 finish LAST in phase A → committed entries' created order (ledger insertion order / note dates) still follows metas order; (c) phase A write-freeze — run with a store-dir file-count probe between phases (inject a hook? simplest: dryRun-like assertion is impossible mid-run — instead assert structurally: make phase A throw for ALL transcripts → store completely untouched incl. quarantine (proves no phase-A writes)); (d) error paths unchanged (all-error transcript not ledgered under concurrency 4).

Commit: `feat(distiller): two-phase pipeline — parallel prepare, single-writer commit`

---

### Task 4: CLI env + decoration + docs + VERIFY

**Files:** Modify `distiller/cli.ts`, `README.md`, `LLM_WIKI.md`; Create `docs/superpowers/VERIFY-parallel.md`

- cli: `AGENT_MEMORY_CONCURRENCY` int 1-32 default 8 (numEnv pattern); `const llm = withConcurrencyLimit(deps.llm ?? clientFromEnv(env), concurrency)` for BOTH `run` and `reflect`; pass `concurrency` into runPipeline opts. Tests: env validation, default 8 plumbed (probe via a deps.llm counting max in-flight with a gate — or simpler: assert runPipeline receives the option via an injected spy… keep it simple: bad-env friendly error + a smoke that run works with AGENT_MEMORY_CONCURRENCY=2).
- README: env table row + tuning note (vLLM default 8; opencode-run dev backend → recommend 2, each call spawns a process); parallel architecture paragraph (phase A/B diagram).
- LLM_WIKI（繁中）: 平行化章節——全域 LLM 併發上限的裝飾器設計、兩階段管線與單一寫入者不變式、決定性契約、AGENT_MEMORY_CONCURRENCY 調整指引。
- VERIFY-parallel.md:
  ```markdown
  # VERIFY — parallel distiller
  Status: PENDING
  Headless (executor MUST run):
  1. bun test — green (incl. equivalence test).  2. typecheck clean.
  3. Real A/B (opencode backend, scratch HOME, same 2 real transcripts):
     AGENT_MEMORY_CONCURRENCY=1 vs =2, fresh store each — record wall-clock
     for both and confirm summary counters match; spot-diff the two stores'
     memories/ trees (titles/types should match; exact text may vary with
     backend nondeterminism — this is the LLM, not the pipeline; note it).
  4. AGENT_MEMORY_CONCURRENCY=banana → friendly error exit 1.
  Interactive: 5. company vLLM: measure the real speedup at 8.
  ```
- Execute headless 1-4 for real; record.

Commit: `feat(distiller): concurrency env, decorated clients, docs, and verification`
