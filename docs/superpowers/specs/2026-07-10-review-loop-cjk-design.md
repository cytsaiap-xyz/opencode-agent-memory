# Review Loop Completion + CJK Search — Design Spec

**Date:** 2026-07-10
**Status:** DRAFT — pending user approval
**Extends:** `2026-07-10-agent-memory-design.md` (§6 COMMIT phase-1 deferral, §8)

## 1. Goal

Close the three dead ends in the human review loop, and make FTS search work
for CJK queries.

Current dead ends:
1. Quarantine is enter-only — `distill review` lists entries but no command can
   release or dismiss them.
2. The confidence formula's `+0.2 human_approved` term has no trigger anywhere
   in the system.
3. A SUPERSEDE against a `decision`/`convention` memory (team policy) takes
   effect immediately with no human in the loop — a stray remark in one session
   could silently overturn a signoff-team rule and every agent would follow it.

## 2. Feature A — review commands

```
distill review                 → list ALL entries with review: human_pending
                                 (quarantine/ dir AND memories/ tree), showing
                                 id, type, title, project, and the last note
                                 (the "why it's pending" line)
distill approve <id>           → release the entry (see semantics below)
distill reject <id> [--reason "…"]  → archive the entry (never delete)
```

**approve semantics:**
1. Locate by id via index (`getById`); must be `review: human_pending`
   (anything else → friendly error, exit 1).
2. Set `status: active`, `review: human_approved`; recompute confidence via
   `computeConfidence({ sessions: distinct evidence sessions, humanApproved:
   true, contradicted: false })`; append note `<date>: approved by human`.
3. If the entry has `supersedes: <target_id>` (Feature B), perform the deferred
   supersession now: target gets `status: superseded`, `superseded_by: <id>`,
   dated note, index upsert. Missing target (drift) → warn on stderr, continue.
4. If the file lives under `quarantine/`, move it to
   `memories/<project>/<id>.md` (canonical home for active knowledge); on path
   collision, uniquify the id with the existing `-2`/`-3` convention and update
   frontmatter before writing. Remove the quarantine file.
5. Upsert index; print one outcome line.

**reject semantics:**
1. Same locate/state guard as approve.
2. Set `status: archived`; append note `<date>: rejected by human — <reason>`
   (default reason `"not specified"`). `review` stays `human_pending`? No —
   set `review: human_approved` is wrong; introduce NO new enum value: rejected
   entries keep `review: human_pending` but `status: archived` excludes them
   from `distill review` (which filters on status ∈ {quarantined} OR (review =
   human_pending AND status != archived)) and from all serving paths.
3. File stays where it is (quarantine/ or memories/); index upserted. Archived
   entries remain in reindex scans (both trees are already scanned).

## 3. Feature B — decision/convention SUPERSEDE interception

In `reconcileCandidate`, when the LLM decides SUPERSEDE and the target entry's
`type` ∈ {`decision`, `convention`}:

- Do NOT tombstone the target — it stays active and served.
- Create the candidate as a PENDING entry instead: `status: quarantined`,
  `review: human_pending`, new frontmatter field `supersedes: <target_id>`,
  note `<date>: pending review — proposes to supersede <target_id>: <reason>`;
  write to `quarantine/` (with the quarantine id-uniquify convention).
- Return op `SUPERSEDE_PENDING`; pipeline counts it in `summary.quarantined`
  (no new summary field) and it appears in `distill review`.
- `distill approve` on such an entry completes the original supersession
  (Feature A step 3). `distill reject` leaves the old rule untouched forever.

Other four types (`root_cause`, `pitfall`, `know_how`, `workflow`) keep
automatic SUPERSEDE — they are factual knowledge, not team policy.

**Amendment (2026-07-10, from live verification):** UPDATE decisions against
decision/convention targets are gated the same way. Live testing showed the
reconcile LLM routing a CONTRADICTING session as an UPDATE — merging it into
the policy memory as corroborating evidence and raising confidence with no
human in the loop. Since the LLM cannot be trusted to distinguish agreement
from contradiction, ANY mutation of a policy memory (UPDATE or SUPERSEDE)
now produces a pending entry instead. Duplicate pending proposals against
the same target are deduplicated (skipped with a note in the run log).

**Schema change:** `MemoryEntry` gains `supersedes: string | null` (default
null). Serializer always writes it; parser treats a MISSING `supersedes` line
as `null` (backward compatibility with the 16 existing store files — this is
the one field exempt from strict-missing-field errors). Round-trip tests cover
both presence and absence.

## 4. Feature C — trigram FTS for CJK

**Problem:** FTS5's `unicode61` tokenizer treats a contiguous CJK run as one
token — `search_memory("時序收斂")` cannot match a lesson containing
`「…時序收斂技巧…」`.

**Change:** recreate `memories_fts` with `tokenize = 'trigram'`.

- **Migration:** `PRAGMA user_version` on index.db; version < 2 → drop and
  recreate `memories_fts` (empty), set `user_version = 2`, expose
  `MemoryIndex.ftsRebuildNeeded: boolean`. Both entry points that own a
  storeDir (`distiller/cli.ts` before command dispatch; `mcp-server/main.ts`
  and `probe.ts` on startup) check the flag and run `rebuildFrom(storeDir)`
  with a one-line stderr notice. index.db is a rebuildable projection — no
  data loss by design.
- **Query rules** (in `MemoryIndex.search`):
  - Tokens ≥ 3 chars (code points): quoted, joined `OR`, used in `MATCH`
    (trigram handles both English words and CJK runs ≥ 3 chars).
  - If NO token is ≥ 3 chars (e.g. a pure 2-char CJK query like `時序`):
    fall back to an index-accelerated `LIKE` query (`title LIKE '%tok%' OR
    trigger LIKE … OR lesson LIKE … OR domain LIKE …` per token, OR-joined),
    with `score = 0` for all hits (ordering then falls to the rank-position
    boost's confidence/recency terms). FTS5 trigram tables accelerate LIKE.
  - Mixed queries: the ≥3-char tokens drive MATCH; shorter tokens are ignored
    (documented behavior).
- **Cost:** trigram index is ~2-3× larger than unicode61 for the same text —
  irrelevant at this store's scale, and the index is disposable.
- English behavior note: trigram also enables substring matching for English
  (e.g. `parasitic` matches `parasitics`) — mild recall improvement; bm25
  ranking still applies.

## 5. Testing

- Round-trip: `supersedes` present + absent (legacy file fixture).
- approve: quarantined secret entry → active in memories/, confidence bumped
  (0.5 → 0.7 single-session), quarantine file gone, index updated.
- approve with `supersedes`: target tombstoned exactly as a direct SUPERSEDE
  would have; drift (missing target) warns and still approves.
- reject: archived, invisible to `distill review` and `search_memory`.
- reconcile: SUPERSEDE against decision-type target → target untouched +
  pending entry in quarantine with `supersedes` set; against pitfall-type →
  automatic supersession unchanged (regression).
- trigram: CJK 4-char query matches lesson content; 2-char CJK query matches
  via LIKE fallback; English queries still pass all existing search tests;
  migration test (v1 index.db → open → ftsRebuildNeeded → rebuild → hits).
- CLI: review lists pending incl. SUPERSEDE_PENDING entries; approve/reject
  friendly errors on unknown id / non-pending entries.

## 6. Out of scope

- Batch approve/UI; wiki-PR review flow (enhancement #1, separate effort).
- Low-confidence auto-routing to review (still deferred; salience gate has
  proven sufficient so far).
- New MCP tools for review (review stays CLI-side, deliberate — approving
  memories is a human act, not an agent act).
