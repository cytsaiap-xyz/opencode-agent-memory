# VERIFY — mcp-server (Plan 3)

Status: items 1-6 EXECUTED AND PASSING 2026-07-10; item 7 optional/pending

Headless items (executor MUST run these, not defer):
1. `bun test` — all green.
   **EXECUTED: PASS** — 106 tests / 338 expect() calls across 17 files, 0 fail.
2. `bun run typecheck` — clean.
   **EXECUTED: PASS** — `tsc --noEmit` exits 0, no output.
3. Real-store probe: `bun run mcp:probe --stats` → JSON with the real store's
   counts (10+ active memories from Plan 2's run).
   **EXECUTED: PASS** — real store (no `AGENT_MEMORY_HOME` override) returned
   `byStatus.active: 10`, `byType: { convention: 1, decision: 4, know_how: 3,
   pitfall: 1, workflow: 1 }`, `sessions: 3`,
   `lastProcessedAt: "2026-07-10T08:06:30.313Z"`, `quarantineFiles: 0`.
4. Real-store search: `bun run mcp:probe "opencode plugin"` → at least one hit
   from the test_folder memories with sensible lesson text.
   **EXECUTED: PASS (with corrected query)** — `"opencode plugin"` returns `[]`,
   and that is correct behavior, not a bug: FTS indexes only
   title/trigger/lesson/domain, and in the real store "opencode" appears only in
   the non-indexed `provenance` field (`extractor: "distiller v0.1 /
   opencode-run"`). The item's example query assumed store content that Plan 2's
   run didn't produce. Substitute query exercising the same path:
   `bun run mcp:probe "Decimal monetary float"` → 2 hits from test_folder, top
   hit `mem_20260710_624036` "Use Decimal for monetary computations instead of
   float" with sensible trigger + lesson text.
5. Access recording: run item 4 twice, then
   `sqlite3 ~/.agent-memory/store/index.db "SELECT id, access_count FROM memories WHERE access_count > 0"`
   → returned ids show access_count >= 2.
   **EXECUTED: PASS** — after running the item-4 substitute search twice:
   `mem_20260710_624036|2`, `mem_20260710_05c56b|2` (exactly the returned ids,
   exactly 2 each; no other rows have access_count > 0).

Interactive items (user):
6. Register in opencode (opencode.json mcp block per README), restart, ask the
   agent: "search our engineering memory for SPEF" (or any known topic) → agent
   calls search_memory and cites a stored lesson.
   **EXECUTED: PASS (2026-07-10, live)** — registered in the global
   `~/.config/opencode/opencode.json` alongside codebase-memory-mcp; asked via
   `opencode run` for lessons about decimal/monetary values. The agent called
   `agent-memory_search_memory` four times (varying `type` filters), then
   `agent-memory_get_memory` on the top hit, and answered citing
   `mem_20260710_624036` (decision, confidence 0.5): "Use Decimal with
   ROUND_HALF_UP instead of float for monetary computations" — including the
   provenance context ("triggered by a prior session where float was used in a
   tip calculator"). Full closed loop: conversation → transcript → distilled
   memory → MCP recall by a fresh agent.
7. Optional: register in Claude Code and repeat.
