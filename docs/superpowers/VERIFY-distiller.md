# VERIFY — distiller (Plan 2)

Status: PENDING

Headless items (executor MUST run these, not defer):
1. `bun test` — all green.
2. `bun run typecheck` — clean.
3. Real end-to-end on this machine (opencode-run backend, zero idle window):
   `AGENT_MEMORY_IDLE_HOURS=0 bun run distill run --project tmp`
   → the verify-collector transcript distills; summary line prints; then
   `bun run distill stats` shows the entries and
   `sqlite3 ~/.agent-memory/store/index.db "SELECT id, status FROM memories"` lists them.
4. `bun run distill reindex` after deleting index.db → same stats.
5. Idempotency: re-run item 3's command → `already-done >= 1`, no new entries.

Interactive items (user):
6. Inspect one generated memory file under ~/.agent-memory/store/memories/ —
   frontmatter fields sensible, lesson readable, evidence anchors point at real
   transcript turns.
7. (When a vLLM endpoint is reachable) AGENT_MEMORY_LLM=vllm + URL/MODEL envs:
   rerun item 3 against a fresh AGENT_MEMORY_HOME; extraction quality acceptable.
