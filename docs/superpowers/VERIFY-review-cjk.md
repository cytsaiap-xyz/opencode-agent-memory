# VERIFY — review loop + CJK (enhancement 2+6)

Status: EXECUTED (headless 1-5, 2026-07-10) — interactive item 6 pending

Headless (executor MUST run):
1. bun test — all green.  2. bun run typecheck — clean.
   **EXECUTED**: 129 pass / 0 fail (438 expect calls, 19 files); `tsc --noEmit` clean.
3. Real store: first `bun run distill stats` after upgrade prints the fts
   rebuild notice once; second run does not; counts match pre-upgrade.
   **EXECUTED**: pre-upgrade `index.db` at `user_version=0`, 16 active memories,
   6 sessions. First `distill stats` printed
   `agent-memory: fts schema upgraded — rebuilding index from ~/.agent-memory/store`
   and reported `{"active":16}` / 6 sessions (exact match). Second run printed no
   notice. Post-migration: `user_version=2`, 16 rows in `memories_fts`.
4. Real store CJK: add nothing — `bun run mcp:probe "時序"` returns [] without
   error (store content is English; the point is no crash + LIKE path).
   **EXECUTED**: returned `[]`, exit 0, no error (2-char query → LIKE fallback).
5. Real review flow: craft a session proposing to reverse the useful-skew ban
   (decision type), distill → `distill review` shows a SUPERSEDE_PENDING entry
   with supersedes: mem_20260710_8cd55e; `distill reject <id> --reason "still
   banned"` → old rule stays active; agent query still answers "forbidden".
   **EXECUTED**: crafted `ses_0b3d6dbf9ffezTmP2sFiMWgf4B` from /private/tmp via
   two `opencode run` turns ("signoff team reverses the useful-skew ban"; 2 user
   turns, 2804-byte transcript, exported by the live collector plugin). Distilled
   with `AGENT_MEMORY_IDLE_HOURS=0 --project tmp`. RECONCILE proposed SUPERSEDE
   against `mem_20260710_8cd55e` for TWO candidates; both were intercepted
   (target type `decision`) into `quarantine/` as `SUPERSEDE_PENDING`:
   `mem_20260710_42a869` (decision) and `mem_20260710_5fdddf` (know_how — the
   interception correctly keys off the TARGET's type). Both showed in
   `distill review` with `supersedes: mem_20260710_8cd55e` and a
   "pending review — proposes to supersede" note; the ban stayed
   `status: active`, `superseded_by: null` throughout. Rejected both with
   `--reason "still banned per signoff team"` → both `status: archived` in place
   with dated reason notes; `distill review` → "quarantine empty";
   `bun run mcp:probe "useful skew"` still returns `mem_20260710_8cd55e` with the
   original "forbidden" lesson. Final stats: `{"active":16,"archived":2}`.
   Observations recorded during execution (not blockers, see final review report):
   (a) two runs of the same transcript had ALL candidates rejected for
   "hallucinated evidence anchor: #msg_…" — the extract LLM prefixed real
   anchor ids with `#`; validation is strict, so recall is lost (pre-existing
   Plan 2 behavior). (b) a third candidate was routed as UPDATE against the
   decision-type ban and auto-applied (note append + evidence merge +
   confidence 0.5→0.65) — UPDATE is not intercepted, only SUPERSEDE is
   (spec §3 scope); the lesson text stayed "forbidden".

Interactive (user):
6. Approve path on a real quarantined entry when one appears naturally.
