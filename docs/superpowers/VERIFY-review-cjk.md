# VERIFY — review loop + CJK (enhancement 2+6)

Status: PENDING

Headless (executor MUST run):
1. bun test — all green.  2. bun run typecheck — clean.
3. Real store: first `bun run distill stats` after upgrade prints the fts
   rebuild notice once; second run does not; counts match pre-upgrade.
4. Real store CJK: add nothing — `bun run mcp:probe "時序"` returns [] without
   error (store content is English; the point is no crash + LIKE path).
5. Real review flow: craft a session proposing to reverse the useful-skew ban
   (decision type), distill → `distill review` shows a SUPERSEDE_PENDING entry
   with supersedes: mem_20260710_8cd55e; `distill reject <id> --reason "still
   banned"` → old rule stays active; agent query still answers "forbidden".

Interactive (user):
6. Approve path on a real quarantined entry when one appears naturally.
