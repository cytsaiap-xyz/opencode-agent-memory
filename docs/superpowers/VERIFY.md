# VERIFY — collector (Plan 1)

Status: headless items 1-4 EXECUTED AND PASSING (2026-07-10, controller-verified);
interactive items 5-6 PENDING USER VERIFICATION

Item 4 evidence: full backfill against the real local opencode.db —
`11 written, 0 unchanged, 639 skipped, 0 errors`; SQL cross-check confirms
exactly 11 root sessions have >= 2 user text messages (matches written count);
sampled transcript renders correctly with escaped frontmatter and {#msg_id}
anchors. Note: `--limit 5` alone processes the 5 OLDEST sessions (time_updated
ASC) which are typically thin one-shot tests — expect skips; use a full run.

Headless items (executor MUST run these, not defer):
1. `bun test` — all green.
2. `bun run typecheck` — clean.
3. `bun run build` + loader-contract check (Task 6 Step 5 command) — bundle exports only functions.
4. `bun collector/backfill.ts --limit 5` against the real local opencode.db —
   summary prints, transcripts appear under ~/.agent-memory/transcripts/, files
   are readable markdown with anchors.

Interactive items (user):
5. `./scripts/install.sh`, restart opencode, run any short session, wait for
   idle → transcript for that session exists and collector.log shows the write.
6. Resume the same session, go idle again → log shows `unchanged` (or `written`
   if content actually grew), no duplicate files.
