# REFLECT Stage (cross-session consolidation) — Design Spec

**Date:** 2026-07-11
**Status:** APPROVED IN PRINCIPLE by user 2026-07-11, details subject to review
**Context:** quality-first environment (free internal vLLM tokens). REFLECT is
the deferred spec-§6 stage: periodic cross-session consolidation — the
Generative-Agents "level-2 reflection" over the per-session memories that
EXTRACT produces. Runs as `distill reflect` (scheduled weekly, or manual).

## Goals

1. **Insight synthesis**: cluster related active memories and produce
   higher-order insight entries that cite their member memories.
2. **Near-duplicate consolidation**: find same-lesson entries that write-time
   reconcile missed (different wording across projects/weeks) and merge them —
   through the EXISTING governance machinery.
3. **Promotion automation**: memories with evidence from ≥ 2 projects (the
   "promotion candidate" notes reconcile already leaves) get a `global/` copy
   proposed — via the review queue, not silently.

## Design

### Clustering (deterministic first, LLM second)

- Candidate grouping WITHOUT embeddings: group active memories by shared
  `domain` tags, then within a domain compute pairwise token-set Jaccard over
  `title + trigger`; connected components with similarity ≥ 0.35 AND size ≥ 2
  form clusters (cheap, deterministic, unit-testable).
- Each cluster (cap: 12 members, largest-first) goes to the LLM with all
  member entries (id, type, title, trigger, lesson) and THREE possible outputs
  per cluster (strict JSON):
  - `{"op":"insight", "title","trigger","lesson","domain":[...],"cites":[ids]}`
    — a genuinely higher-order pattern across members (not a restatement).
  - `{"op":"merge", "keep": id, "absorb": [ids], "reason"}` — members are the
    same lesson in different words.
  - `{"op":"none", "reason"}` — cluster is thematic coincidence; do nothing.
- Multi-judge gate (reuse quality-pack judges, N=3 median ≥ salienceMin): an
  insight must clear the same bar as any extracted candidate.

### Applying ops (all through existing governance)

- **insight** → new entry: `type` from the LLM constrained to the 6-type enum,
  `memory_class: "semantic"`, `project`: the members' common project or
  `"global"` when members span projects, `evidence`: union of members'
  evidence (provenance preserved), notes cite member ids
  (`derived from: mem_a, mem_b, …`), confidence from `computeConfidence`
  with the union's distinct session count, `review: "auto"`, status active.
  Members stay active (insights ANNOTATE, they don't replace).
- **merge** → the absorb entries are superseded by `keep` via the EXISTING
  supersession path — which means decision/convention members route through
  the review queue automatically (policy governance holds for REFLECT too).
  `keep` gains the absorbed entries' evidence (dedup by session) and a note.
- **promotion** (independent of clusters): scan active project-scoped entries
  whose evidence spans ≥ 2 distinct projects OR carrying a "promotion
  candidate" note → create a `global/` PENDING copy (`status: quarantined`,
  `review: human_pending`, note naming the source entry) — human approves via
  the existing `distill approve`. The source entry is NOT superseded: the
  global copy ADDS scope. On approval the source gains a note
  `promoted to <global id>`; both stay active — project-filtered queries hit
  the local entry, cross-project queries hit the global one.
  - **Promotion tracking**: the pending global copy carries a new frontmatter
    field `promoted_from: <source entry id>` (machine-readable, replaces
    note-text parsing for idempotency). On `approveEntry`, if the approved
    entry has `promoted_from`, the source entry is found and annotated with
    `promoted to <approved id>` note for reciprocal tracing.
- Idempotency: stateless by design — no new ledger surface. Reflect SKIPS
  clusters whose members already share a `derived from` note citing all of
  them, skips merges whose members are already superseded, and skips
  promotions where a global copy (pending or active) already cites the
  source. A deterministic re-run is therefore a no-op.

### CLI & scheduling

- `distill reflect [--project <slug>] [--dry-run]` — dry-run prints the
  planned ops (cluster membership, insight drafts, merges, promotions) without
  writing; the normal run prints a summary line:
  `reflect done: I insights, M merges (P pending review), G promotions queued, C clusters examined`.
- `scripts/run-distill.sh` gains optional `--with-reflect` (cron: weekly line
  alongside the nightly distill, documented in README/setup.sh --schedule-reflect "0 4 * * 0").

## Testing

- Clustering: pure-function tests (Jaccard components, domain grouping, caps).
- Op application (FakeLlm): insight creation with evidence union + citations;
  merge → supersession incl. policy-type interception into review; promotion
  pending copy + approve flow (extends reviewops tests); idempotent second run
  = zero ops on all three paths.
- Dry-run writes nothing (mtime sweep assertion).
- Real-machine VERIFY: reflect --dry-run over the real store (18 active) —
  inspect proposed ops manually; then a real run; document what it produced.

## Out of scope

- Embedding-based clustering (Jaccard first; revisit on recall complaints).
- Insight-of-insights recursion (single level for now).
- Scheduled automation beyond the cron line (no daemon).
