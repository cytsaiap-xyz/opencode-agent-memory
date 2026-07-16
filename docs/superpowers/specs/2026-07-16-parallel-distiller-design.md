# Parallel Distiller — Design Spec

**Date:** 2026-07-16
**Status:** APPROVED (user 2026-07-16: default concurrency 8, user-configurable)
**Motivation:** the pipeline is fully sequential (three nested awaited loops);
the quality pack multiplied LLM calls per session (triage + extract×2 +
judges×3×candidates + reconcile), so nightly wall-clock is the real constraint.
vLLM's server-side batching rewards concurrent requests — serial submission
leaves the internal GPUs idle.

## 1. Core design: a global LLM concurrency limiter + two-phase pipeline

### 1.1 Concurrency-limited LlmClient decorator

```ts
// distiller/limiter.ts
export class Semaphore { constructor(limit: number); acquire(): Promise<() => void> }
export function withConcurrencyLimit(llm: LlmClient, limit: number): LlmClient
```

- ONE global semaphore wraps `complete()` — every LLM call in the process
  (triage, extract, judge, reconcile, reflect ops) shares the same in-flight
  cap. Callers may then use `Promise.all` freely; the decorator enforces the
  budget. FIFO queuing; permit released on resolve AND on throw.
- `AGENT_MEMORY_CONCURRENCY`: integer 1-32, **default 8**, validated at the
  CLI layer with a friendly error. `describe()` passes through unchanged.
- Applied once where the client is created (cli `run`/`reflect`); eval keeps
  its own sequential behavior (out of scope).

### 1.2 Safe intra-stage parallelism

- **extractRuns**: the N extraction calls run via `Promise.all`; results are
  kept in run-index order (Promise.all preserves input order), so the
  order-dependent greedy pool dedup stays deterministic. Per-run error →
  caught → that slot yields no candidates (tolerated, logged); ALL runs
  failing → transcript error (unchanged semantics).
- **judge panels**: `judgeCandidate`'s N judge calls run via `Promise.all`;
  each call's throw/invalid-reply becomes an abstention exactly as today
  (median/abstain/fallback semantics unchanged — order never mattered).
- **across candidates**: all pooled candidates' judge panels run concurrently.

### 1.3 Two-phase pipeline (parallel front, single-writer commit)

```
Phase A (concurrent, bounded):  per transcript — triage → extract×N →
  validate → pool dedup → judge  ⇒  PreparedTranscript (candidates, secrets,
  counters, or error). NO store/index/ledger writes in phase A.
Phase B (strictly sequential, in the ORIGINAL metas order, not completion
  order):  per prepared transcript — secrets quarantine writes → reconcile
  each candidate → commit → recordProcessed.
PUBLISH once at the end (unchanged).
```

- Phase A transcript tasks are bounded by the same limit (fan-out hygiene);
  the LLM decorator is the real throughput governor.
- RECONCILE/COMMIT stay single-writer: two concurrent reconciles racing the
  same store would blind each other to just-added memories (duplicate ADDs),
  and the policy-interception + id-uniquify checks have TOCTOU windows. The
  single-writer discipline (Letta sleep-time lineage, ledger.jsonl contract)
  is preserved by construction.
- Phase B ordering by the original metas order (time_end sort from scanSpool)
  keeps results independent of completion timing → determinism.

## 2. Determinism contract (the one hard risk)

Given identical inputs and a content-keyed deterministic LLM, a run with
concurrency N must produce **byte-identical store trees** (memories/ +
quarantine/, timestamps injected via `now`) and the **same ledger row set**
(ignoring `processed_at` wall-time) as concurrency 1. Pinned by an
equivalence test using a prompt-content-keyed FakeLlm (order-independent by
construction, unlike the existing call-order-scripted fakes).

Existing pipeline tests use call-order-scripted fakes → they pin
`concurrency: 1` (added to the LEGACY options constant), preserving their
exact semantics. New tests cover the concurrent paths.

## 3. Scope notes

- **reflect**: gains judge-panel concurrency automatically (shared
  `judgeCandidate`) and the decorated client from the CLI; the cluster loop
  itself stays sequential (its ops write to the store).
- **eval**: untouched (its multi-run stability measurement is intentionally
  independent; parallelizing it is a separate decision).
- **opencode-run dev backend**: each concurrent call spawns a full `opencode
  run` process — the default 8 is tuned for vLLM; docs recommend
  `AGENT_MEMORY_CONCURRENCY=2` on the dev backend.
- Pipeline stays env-free: `concurrency` arrives as a PipelineOption; the env
  is parsed at the CLI layer only.

## 4. Testing

- limiter: in-flight count never exceeds the cap (probe with a gate-controlled
  fake), FIFO order, permit released on throw, limit=1 serializes.
- extract-runs parallel: run-index order preserved in the pool concat; one
  slot failing tolerated; all failing → error.
- judge parallel: abstention on rejection unchanged; call count unchanged.
- pipeline equivalence: concurrency 1 vs 4 → identical trees + ledger sets +
  counters (content-keyed FakeLlm).
- Phase-B ordering: completion order scrambled (delayed fake) → commit order
  still follows metas order.
- CLI: env validation (default 8, bad values friendly-error), plumbed through.
- Real-machine VERIFY: A/B wall-clock on the same transcripts (opencode
  backend, concurrency 2 vs 1) + counters identical.
