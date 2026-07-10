# VERIFY — distiller (Plan 2)

Status: 1-5 EXECUTED AND PASSING (final wave, 2026-07-10). 6-7 PENDING USER.

Headless items (executor MUST run these, not defer):

1. `bun test` — all green.
   **EXECUTED 2026-07-10: PASS** — 91 pass, 0 fail (91 tests / 14 files at time of
   this wave's fixes; count grows as tests are added).
2. `bun run typecheck` — clean.
   **EXECUTED 2026-07-10: PASS** — `tsc --noEmit` produced no output.
3. Real end-to-end on this machine (opencode-run backend, zero idle window),
   against the real `~/.agent-memory` spool's `test_folder` project (NOT
   `--project tmp`): the `tmp` project's only transcript is a ~660-byte
   verify-collector smoke transcript whose body sits under the 400-char
   `TRIAGE_MIN_BODY` floor in `pipeline.ts`, so it always gets triaged out
   before ever reaching the LLM — it cannot exercise real extraction. Use
   `test_folder` instead, which has two real transcripts (~8KB and ~15KB):
   `AGENT_MEMORY_IDLE_HOURS=0 bun run distill run --project test_folder`
   → both transcripts distill (opencode-run backend, ~2 min/transcript, so
   ~4 min total for the pair); summary line prints; then
   `bun run distill stats` shows the entries and
   `sqlite3 ~/.agent-memory/store/index.db "SELECT id, status FROM memories"` lists them.
   **EXECUTED 2026-07-10 by the final reviewer: PASS.** Result: `10 added, 0
   updated, 0 superseded, 0 nooped, 0 quarantined, 0 rejected, 0 errors
   (scanned 2, eligible 2, already-done 0, triaged 0)`. The 10 memories are
   visible under `~/.agent-memory/store/memories/test_folder/` and listed in
   `~/.agent-memory/store/INDEX.md`.
4. `bun run distill reindex` after deleting index.db → memory/quarantine FTS
   entries are restored to the SAME set as before deletion.
   **EXECUTED 2026-07-10: PASS**, with an important correction to how this
   item used to be read: `reindex` (`ledger.ts: rebuildFrom`) only rebuilds
   the `memories`/`memories_fts` tables from the markdown files under
   `store/memories/` and `store/quarantine/`. It does **not** and cannot
   restore `processed_sessions` (the idempotency ledger `isProcessed`/
   `recordProcessed` reads) or `memories.access_count`/`last_accessed` —
   neither has a markdown-file source of truth to rebuild from. Concretely:
   deleting `index.db` and reindexing brings memory entries back and item 3's
   `sqlite3 SELECT` output looks the same, but it does **not** make a
   following `distill run` idempotent — every transcript session's ledger row
   is gone, so the next run re-extracts everything via the LLM from scratch.
   Do not chain "delete index.db → reindex → run → expect already-done" as a
   single verification; that combination was previously miswritten as if it
   were idempotent, which it is not. (This caveat is also recorded in
   `LLM_WIKI.md`'s 已知陷阱補充 item 6.)
5. Idempotency: re-run item 3's command → `already-done >= 1`, no new entries,
   zero LLM calls (the skipped-processed path in `pipeline.ts` never invokes
   `deps.llm.complete`).
   **EXECUTED 2026-07-10: PASS.** Re-running
   `AGENT_MEMORY_IDLE_HOURS=0 bun run distill run --project test_folder`
   printed `0 added, 0 updated, 0 superseded, 0 nooped, 0 quarantined, 0
   rejected, 0 errors (scanned 2, eligible 2, already-done 2, triaged 0)` —
   both sessions already-done, zero new entries, zero LLM calls made.

Interactive items (user):

6. Inspect one generated memory file under ~/.agent-memory/store/memories/ —
   frontmatter fields sensible, lesson readable, evidence anchors point at real
   transcript turns.
7. (When a vLLM endpoint is reachable) AGENT_MEMORY_LLM=vllm + URL/MODEL envs:
   rerun item 3 against a fresh AGENT_MEMORY_HOME; extraction quality acceptable.
