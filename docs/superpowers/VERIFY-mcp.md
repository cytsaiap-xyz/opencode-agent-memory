# VERIFY — mcp-server (Plan 3)

Status: PENDING

Headless items (executor MUST run these, not defer):
1. `bun test` — all green.
2. `bun run typecheck` — clean.
3. Real-store probe: `bun run mcp:probe --stats` → JSON with the real store's
   counts (10+ active memories from Plan 2's run).
4. Real-store search: `bun run mcp:probe "opencode plugin"` → at least one hit
   from the test_folder memories with sensible lesson text.
5. Access recording: run item 4 twice, then
   `sqlite3 ~/.agent-memory/store/index.db "SELECT id, access_count FROM memories WHERE access_count > 0"`
   → returned ids show access_count >= 2.

Interactive items (user):
6. Register in opencode (opencode.json mcp block per README), restart, ask the
   agent: "search our engineering memory for SPEF" (or any known topic) → agent
   calls search_memory and cites a stored lesson.
7. Optional: register in Claude Code and repeat.
