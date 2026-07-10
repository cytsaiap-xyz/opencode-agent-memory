# VERIFY — collector (Plan 1)

Status: PENDING USER VERIFICATION

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
