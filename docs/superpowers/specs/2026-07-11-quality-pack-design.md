# Extraction Quality Pack — Design Spec

**Date:** 2026-07-11
**Status:** APPROVED IN PRINCIPLE by user 2026-07-11 (「把那五個品質項目也排進去」), details subject to review
**Context:** internal vLLM on company GPUs — token cost is a non-issue; QUALITY
IS THE ONLY OBJECTIVE. This pack upgrades the distiller's extraction path with
the LLM-heavy techniques previously deferred on cost assumptions. REFLECT
(item 4) is a separate spec/plan.

## Scope (4 of the 5 approved quality items)

1. **LLM triage** replaces the 400-char heuristic as the primary gate.
2. **Extraction self-consistency** — N independent extraction runs, union of
   candidates, dedup before reconcile.
3. **Multi-judge salience voting** — 2-3 independent judges score each
   candidate; consensus replaces the single extractor's self-score.
4. **Eval multi-run averaging** — `bun run eval --runs N` for stable model
   comparison (this is item 5 of the approved list).

## 1. LLM triage (`AGENT_MEMORY_TRIAGE=llm|heuristic`, default `llm`)

Problem: the 400-char floor can drop short-but-precious sessions (one decisive
user correction can be < 300 chars of body) and wastes a big-model call on
long-but-empty sessions only after passing them.

Design:
- Keep the hard floor ONLY for degenerate transcripts (< 80 chars body — a
  greeting cannot hold durable knowledge).
- Above that: a cheap triage prompt (same LlmClient; the backend model may be
  the same vLLM model — "cheap" here means SHORT output, one boolean) asking:
  "Does this transcript plausibly contain ANY durable engineering knowledge
  (decision/root-cause/pitfall/know-how/convention/workflow)? Reply strict JSON
  {"worth_extracting": bool, "why": "<one line>"}."
- `worth_extracting: false` → ledger row with n_candidates 0 (same as today's
  triage-out), the `why` recorded in the run log (stderr), NOT in the store.
- Triage failure (LLM error / bad JSON) → **fail open**: proceed to extraction
  (quality-first: never lose knowledge to a gatekeeping hiccup).
- `AGENT_MEMORY_TRIAGE=heuristic` restores the 400-char behavior (offline/dev).
- Pipeline summary gains `triagedOut` split: `triagedHeuristic` / `triagedLlm`.

## 2. Extraction self-consistency (`AGENT_MEMORY_EXTRACT_RUNS`, default 2)

Problem: single-pass extraction has run-to-run variance (observed empirically
during eval re-validation — the same model omits items across runs).

Design:
- Run the SAME extraction prompt N times (temperature 0 still varies across
  serving batches on vLLM; on opencode-run it varies freely). N=1 disables.
- Candidate pool = union of all runs' VALIDATED candidates (validation per run,
  so a bad run's schema garbage can't poison the pool; a run that errors is
  logged and skipped — the batch fails only if ALL runs error).
- **Pool dedup before reconcile** (deterministic, no LLM): two candidates are
  duplicates iff same `type` AND keyword-normalized title similarity — Jaccard
  over unicode-token sets of `title` ≥ 0.6 OR identical trigger. Merge rule:
  keep the candidate with the LONGER lesson (more specific); union their
  evidence anchor lists; salience = max.
- Secrets bucket: union across runs, deduped by title (same rule).
- Effect on counters: `candidates` counts the POST-dedup pool; new summary
  field `poolRaw` (pre-dedup) for observability.

## 3. Multi-judge salience voting (`AGENT_MEMORY_JUDGES`, default 3)

Problem: salience is currently the extractor's self-score — one model's vibe.
The eval showed classification/selection variance; a wrong salience wastes a
good candidate (dropped) or admits a weak one.

Design:
- After pool dedup, each candidate goes to N independent judge calls (N=0 or 1
  disables → extractor's self-score stands).
- Judge prompt (per candidate, cheap short output): the candidate (type, title,
  trigger, lesson) + the 6-type criteria + the "durable engineering knowledge a
  colleague would want six months from now" bar → strict JSON
  `{"salience": 0-10, "reason": "<one line>"}`.
- Consensus = **median** of judge scores (robust to one outlier; ties at even N
  use the lower-middle = conservative). Candidate proceeds iff median ≥
  salienceMin. Judge-call failure → that judge abstains; if ALL judges fail,
  fall back to the extractor's self-score (fail open, quality-first).
- The final salience recorded in provenance notes: extractor self-score +
  judge median (`provenance.extractor` string gains `judges: k/N median m`).
- Order note: judges run AFTER validation and dedup (never spend judges on
  schema-invalid or duplicate candidates).

## 4. Eval multi-run averaging (`bun run eval --runs N`, default 1)

- Extraction suite only (retrieval is deterministic — always single).
- Each fixture runs N times; per-fixture verdict = pass-rate (`passes/N`);
  fixture passes iff pass-rate ≥ threshold (default 1.0 — strict; `--pass-rate
  0.8` relaxes). Scorecard shows per-fixture rates; results.jsonl line gains
  `runs`, `passRate` per fixture aggregate.
- This turns the eval from "one coin flip" into a stability measurement —
  directly answers "is the new vLLM model reliably better", which is the
  entire point of the fuse.

## Interactions & invariants

- Pipeline order becomes: INGEST → TRIAGE(llm) → EXTRACT×N → VALIDATE(per run)
  → POOL-DEDUP → JUDGE → RECONCILE → COMMIT → PUBLISH.
- All three distiller features are per-run configurable and default ON with
  quality-first settings (llm triage, runs 2, judges 3). `AGENT_MEMORY_*` envs
  read at CLI layer, passed as options (pipeline stays env-free).
- Evidence anchors: union-merge must keep only anchors that exist (each run's
  candidates are already validated, so anchors are guaranteed real).
- Governance unchanged: judged candidates flow into the existing reconcile
  with policy interception; quarantine/secrets flow unchanged.
- Determinism boundary: pool dedup + median are pure functions (unit-testable
  without LLM); all LLM variance is contained in extract/judge calls.
- Wall-clock: a nightly batch grows ~(N_extract + N_judges×candidates) calls
  per session — irrelevant on-prem; `run-distill.sh` already logs duration.

## Testing

- Unit (FakeLlm): triage gate true/false/error(fail-open); self-consistency
  union + dedup rules (Jaccard cases, evidence union, longer-lesson merge,
  all-runs-error fails batch, one-run-error tolerated); judge median (odd/even,
  abstention, all-fail fallback); counters (poolRaw vs candidates).
- Pipeline E2E (FakeLlm scripted): full order with runs=2, judges=3.
- Eval: --runs plumbing, pass-rate math, results.jsonl shape.
- Real-machine VERIFY: quality-pack distill run on 1-2 real transcripts
  (opencode backend), before/after comparison note; eval --runs 3 baseline.

## Out of scope

- REFLECT (separate spec); embedding-based pool dedup (token-set Jaccard first;
  revisit if dedup misses obvious duplicates in practice); per-type judge
  panels; judge diversity via different models (single-backend for now — the
  vLLM service exposes one model; revisit when multiple internal models exist).
