# VERIFY — sqlite-optional

Status: items 1-5 EXECUTED AND PASSING 2026-07-11; item 6 interactive/pending
(no corporate-restricted environment available on this machine).

Headless (executor MUST run):

1. `bun test` — green (both mode suites).
   **EXECUTED: PASS** — 195 pass, 0 fail, 724 expect() calls across 25 files.
2. `bun run typecheck` — clean.
   **EXECUTED: PASS** — `tsc --noEmit` exits 0, no output.
3. Real store, fallback smoke (READ-ONLY against real data):
   `AGENT_MEMORY_NO_SQLITE=1 bun run mcp:probe "useful skew"` → returns the ban
   memory with the fallback warning on stderr; `--stats` shows mode filescan and
   the same byStatus counts as sqlite mode.
   **EXECUTED: PASS**:
   - `AGENT_MEMORY_NO_SQLITE=1 bun run mcp:probe "useful skew"` → stdout
     returned exactly one hit, `mem_20260710_8cd55e` "Forbid useful skew in
     timing methodology" (type `decision`, confidence `0.65`); stderr:
     `agent-memory: sqlite unavailable (disabled by AGENT_MEMORY_NO_SQLITE) —
     markdown-scan mode: search is O(n) without bm25 ranking, access stats
     disabled, ledger uses ledger.jsonl`. Exit 0.
   - `AGENT_MEMORY_NO_SQLITE=1 bun run mcp:probe --stats` → `mode: "filescan"`,
     `byStatus: { active: 18, archived: 2 }`, `byType: { convention: 1,
     decision: 6, know_how: 6, pitfall: 3, root_cause: 1, workflow: 3 }`,
     `quarantineFiles: 2` — byStatus/byType/quarantineFiles all match item 4's
     sqlite-mode baseline exactly. `accessAvailable: false`. Same warning on
     stderr.
   - Expected (not a bug) divergence: `sessions: 0` and `lastProcessedAt: null`
     in this filescan run, vs. `sessions: 16` /
     `lastProcessedAt: "2026-07-10T13:58:09.974Z"` in sqlite mode. These two
     fields come from `ledger.jsonl`, not from the markdown store — the real
     store's distiller has only ever run in sqlite mode, so
     `~/.agent-memory/store/ledger.jsonl` has never been written. This is the
     documented "ledger.jsonl is genuinely separate, non-projected data"
     behavior (see design spec §5 / README / LLM_WIKI), not a counting bug —
     `byStatus`/`byType`/`quarantineFiles`, which ARE markdown-derived, match
     exactly.
   - No writes to the real store: `git status`-equivalent check
     (`ls -la ~/.agent-memory/store/`) before/after showed no new/modified
     files; `--stats` never calls `recordAccess`, and fallback mode's
     `recordAccess` is a no-op regardless.
4. Real store, sqlite mode unchanged: `bun run mcp:probe --stats` → counts
   match pre-change baseline; no warning.
   **EXECUTED: PASS** — `mode: "sqlite"`, `byStatus: { active: 18,
   archived: 2 }`, `byType: { convention: 1, decision: 6, know_how: 6,
   pitfall: 3, root_cause: 1, workflow: 3 }`, `sessions: 16,
   lastProcessedAt: "2026-07-10T13:58:09.974Z"`, `accessAvailable: true`,
   `quarantineFiles: 2`. No warning on stderr. Matches the Task 5 report's
   recorded baseline (`18 active, 2 archived, 16 sessions`) exactly —
   confirms sqlite mode is byte-identical after Task 6's doc-only changes.
5. Fallback distill dry-run on a scratch `AGENT_MEMORY_HOME` with 1-2 copied
   transcripts (opencode backend): memories produced, ledger.jsonl written,
   rerun idempotent.
   **EXECUTED: PASS** — created a scratch `AGENT_MEMORY_HOME`
   (`mktemp -d`), copied two real transcripts from
   `~/.agent-memory/transcripts/tmp/` (`ses_0b3d6dbf9ffezTmP2sFiMWgf4B.md`,
   the useful-skew-policy-reversal session; `ses_0b46ff7bfffe11gFC1EsTOEGBF.md`,
   a longer SPEF/timing-closure session), both with `time_end` well past the
   default 6-hour idle window.
   - First run: `AGENT_MEMORY_HOME=$SCRATCH AGENT_MEMORY_NO_SQLITE=1 bun run
     distill run` (default `AGENT_MEMORY_LLM` unset → opencode-run backend,
     the real LLM path, not FakeLlm) →
     `distill done: 5 added, 0 updated, 0 superseded, 1 nooped, 1 quarantined,
     0 rejected, 0 errors (scanned 2, eligible 2, already-done 0, triaged 0)`,
     exit 0, fallback warning on stderr exactly once.
     `store/memories/tmp/` has 5 new `.md` files, `store/quarantine/` has 1,
     `store/ledger.jsonl` exists with 2 well-formed JSON lines (one per
     session, `extractor_model: "distiller v0.1 / opencode-run"`,
     `n_candidates`/`n_committed` populated), `store/INDEX.md` was rendered
     and contains the new titles.
   - Second run (same env, same transcripts, nothing changed): `distill done:
     0 added, 0 updated, 0 superseded, 0 nooped, 0 quarantined, 0 rejected,
     0 errors (scanned 2, eligible 2, already-done 2, triaged 0)` — both
     sessions now report `already-done`, no second LLM call, and
     `ledger.jsonl` is still exactly 2 lines (no duplicate rows). Idempotency
     confirmed.
   - Scratch directory removed after recording results; the real store
     (`~/.agent-memory`) was never touched by this item.

Interactive (user):

6. Company environment: run setup + distill; if the probe fails there,
   confirm the warning appears and the flow still works end-to-end.
   **PENDING** — no corporate/sqlite-restricted deployment target was
   available to the executor on this machine; items 1-5 above already
   exercise the `AGENT_MEMORY_NO_SQLITE=1` fallback path end-to-end
   (probe → search/stats → full distill pipeline with the real opencode-run
   LLM backend) as the best available proxy. This item stays open for the
   user to close out against an actual restricted environment.
