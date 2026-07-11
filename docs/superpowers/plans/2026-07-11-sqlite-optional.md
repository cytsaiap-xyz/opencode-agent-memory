# SQLite-Optional Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** markdown-primary / db-auxiliary per spec `docs/superpowers/specs/2026-07-11-sqlite-optional-design.md` — startup probe, `MemoryQuery` abstraction, `FileScanIndex` fallback (markdown scan + ledger.jsonl), warnings, both modes fully tested.

**Architecture:** `shared/sqliteProbe.ts` (capability probe) → `distiller/indexes.ts` (`MemoryQuery` interface, `SqliteIndex` wrapper around the existing `MemoryIndex`, `FileScanIndex`, `openMemoryIndex` factory) → all consumers switch to the factory. Existing `MemoryIndex` internals untouched (zero regression risk in sqlite mode).

**Tech Stack:** unchanged, zero new dependencies.

## Global Constraints

- Sqlite mode behavior is BYTE-IDENTICAL to today: all 158 existing tests stay green unmodified (except mechanical constructor→factory swaps in test setup where a task says so).
- `AGENT_MEMORY_NO_SQLITE=1` forces fallback (probe short-circuit) — this is how tests exercise filescan mode deterministically.
- Fallback warning: stderr, ONCE per process per entry point, exact prefix `agent-memory: sqlite unavailable` — mcp paths must never write to stdout.
- FileScanIndex is read-consistent with the live filesystem (no caching between calls) — writes via writeEntry are immediately visible to the next search.
- ledger.jsonl: single writer (distiller), append-only, loader tolerates a torn final line (crash mid-append).
- Search-fallback scoring exactly per spec §4 (hits-weighted substring, score = -hits, zero-hit excluded); CJK substrings work natively.
- Contract tests: ONE parametrized suite runs shared semantics against BOTH implementations.
- Commits: conventional + the standard trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01ALAk5sCENNGXZyy6mSg8tF`

---

### Task 1: shared/sqliteProbe.ts

**Files:** Create `shared/sqliteProbe.ts`; Test `shared/sqliteProbe.test.ts`

**Interfaces:**
```ts
export interface SqliteProbe { ok: boolean; reason?: string }
export function probeSqlite(storeDir: string, env?: Record<string, string | undefined>): SqliteProbe
```
- `env.AGENT_MEMORY_NO_SQLITE === "1"` → `{ ok: false, reason: "disabled by AGENT_MEMORY_NO_SQLITE" }` (no filesystem activity).
- Otherwise: `mkdirSync(storeDir, {recursive:true})`; open `<storeDir>/.sqlite-probe.tmp` via `bun:sqlite` `Database` (dynamic import inside try), `PRAGMA journal_mode = WAL`, `CREATE TABLE t(x)`, insert, select back, close; unlink probe files (`.tmp`, `-wal`, `-shm`, best-effort) in finally. Any throw → `{ ok: false, reason: String(error message) }`.

**Steps:** failing tests (ok path on tmp dir + probe files cleaned up; NO_SQLITE forces not-ok with exact reason; unwritable storeDir (chmod 0o444 dir) → ok:false with reason) → FAIL → implement → PASS full gates → commit `feat(shared): sqlite capability probe with env override`.

---

### Task 2: MemoryQuery interface + SqliteIndex wrapper + factory

**Files:** Create `distiller/indexes.ts`; Test `distiller/indexes.test.ts`

**Interfaces:**
```ts
import type { MemoryEntry } from "./types"
import type { SearchHit } from "./ledger"

export interface LedgerFacet {
  isProcessed(sessionId: string, contentHash: string): boolean
  recordProcessed(row: { session_id: string; content_hash: string; extractor_model: string; n_candidates: number; n_committed: number }): void
}
export interface IndexStats {
  byStatus: Record<string, number>; byType: Record<string, number>
  sessions: number; lastProcessedAt: string | null; accessAvailable: boolean
}
export interface MemoryQuery {
  readonly mode: "sqlite" | "filescan"
  search(query: string, opts?: { project?: string; type?: string; status?: string; minConfidence?: number; limit?: number }): SearchHit[]
  getById(id: string): SearchHit | null
  upsertEntry(e: MemoryEntry, path: string): void          // filescan: no-op
  removeEntry(id: string): void                            // filescan: no-op
  stats(): IndexStats
  recordAccess(id: string): void                           // filescan: no-op
  accessStats(id: string): { access_count: number; last_accessed: string | null } | null  // filescan: null
  ledger: LedgerFacet
  rebuildFrom(storeDir: string): Promise<number>           // filescan: no-op returning current entry count
  close(): void
}
export function openMemoryIndex(storeDir: string, probe: SqliteProbe, opts?: { dbPath?: string; warn?: (line: string) => void }): MemoryQuery
```
- `SqliteIndex`: thin wrapper delegating every method to the existing `MemoryIndex` (constructed at `opts.dbPath ?? join(storeDir, "index.db")`); `stats()` maps to existing + `accessAvailable: true`; `ledger` delegates to isProcessed/recordProcessed.
- Factory: probe.ok → SqliteIndex; else emit warning ONCE via `opts.warn ?? console.error` — exact format: `agent-memory: sqlite unavailable (<reason>) — markdown-scan mode: search is O(n) without bm25 ranking, access stats disabled, ledger uses ledger.jsonl` — and return `FileScanIndex` (Task 3/4; for THIS task create the class with method stubs throwing "not implemented" EXCEPT mode/close, and keep its tests for later tasks).
- Existing `MemoryIndex` stats() return needs `accessAvailable` added? NO — keep MemoryIndex untouched; the wrapper adds the field.

**Steps:** failing tests (factory returns sqlite impl when ok, delegation spot-checks: upsert→search→getById→ledger roundtrip through the wrapper against a real tmp store; factory returns filescan + warns exactly once when probe not ok; dbPath override honored) → FAIL → implement → PASS full gates → commit `feat(distiller): memory query abstraction with sqlite wrapper and factory`.

---

### Task 3: FileScanIndex — search / getById / stats

**Files:** Modify `distiller/indexes.ts`; Create `distiller/filescan.contract.test.ts`

**Implementation (in indexes.ts):**
- Constructor stores `storeDir`.
- `entries()` (private): walk `listEntryPaths(storeDir)` + `<storeDir>/quarantine/*.md` (readdir try/catch), parseEntry per file with per-file try/catch skip; returns `Array<{ entry, path }>`; NO caching.
- `search(query, opts)`: filter by opts (status/minConfidence/project/type) → tokenize query with the SAME unicode split as the sqlite path → per entry `hits = Σ_token (3×count(title) + 2×count(trigger) + 1×count(lesson) + 2×count(domain.join(" ")))` case-insensitive substring occurrence counts → exclude hits===0 → `score = -hits` → sort ascending, tie-break confidence desc → slice `limit ?? 10`.
- `getById(id)`: scan for basename `<id>.md` in both trees; parse; null on miss/corrupt.
- `stats()`: walk + count byStatus/byType; `sessions`/`lastProcessedAt` from ledger.jsonl (Task 4 — for this task return 0/null placeholders wired to the ledger facet); `accessAvailable: false`.

**Contract test suite** (`filescan.contract.test.ts`): a single `describe.each`-style loop over both factory modes (sqlite via ok-probe, filescan via NO_SQLITE probe) running IDENTICAL assertions on shared semantics: upsert-then-search visibility (for filescan: writeEntry alone suffices — assert that too), status/minConfidence/project/type filters, getById hit/miss, stats counts, multi-keyword search finds the right entry first, CJK 2-char query (「時序」 substring) finds a CJK-lesson entry in BOTH modes (sqlite mode passes via the existing LIKE fallback). Plus filescan-only tests: corrupt file skipped; recordAccess no-op + accessStats null; upsertEntry/removeEntry no-ops don't break subsequent reads.

**Steps:** failing tests → implement → PASS full gates → commit `feat(distiller): filescan index with deterministic substring scoring`.

---

### Task 4: FileScanIndex — ledger.jsonl + remaining facets

**Files:** Modify `distiller/indexes.ts`; Test additions in `distiller/filescan.contract.test.ts`

**Implementation:**
- `FileLedger` (in indexes.ts): path `<storeDir>/ledger.jsonl`; lazy-load lines into `Set<"sid|hash|ver">` + track max processed_at + count; torn/unparseable final line skipped silently, other bad lines skipped with one stderr warn; `recordProcessed` appends JSON line (same fields as sqlite table incl. `pipeline_version: PIPELINE_VERSION`, `processed_at: new Date().toISOString()`) AND updates the in-memory set (same-process consistency).
- `stats()` wires `sessions` (set size) + `lastProcessedAt` (max) from FileLedger.
- `rebuildFrom(storeDir)`: returns `entries().length`, writes nothing (log line via warn hook optional).

**Tests:** ledger contract added to BOTH modes in the contract suite (isProcessed false→record→true; different hash false); filescan-only: ledger.jsonl file exists with one valid JSON line per record; torn last line (append `{"session_id":"x`) tolerated on reload; stats sessions/lastProcessedAt reflect records; a SECOND FileScanIndex instance over the same storeDir sees prior records (persistence).

**Steps:** failing tests → implement → PASS full gates → commit `feat(distiller): file-based ledger for sqlite-free idempotency`.

---

### Task 5: wire all consumers through the factory + fallback E2E

**Files:** Modify `distiller/pipeline.ts` (type only: accept MemoryQuery), `distiller/reconcile.ts` (type), `distiller/reviewops.ts` (type), `distiller/quarantine.ts` (type), `distiller/cli.ts`, `mcp-server/main.ts`, `mcp-server/probe.ts`, `mcp-server/query.ts` (type), `mcp-server/server.ts` (type), `eval/run.ts`; Tests: `distiller/fallback.e2e.test.ts` + small updates where constructors move to factory.

**Work:**
- Type-level: change consumer signatures from `MemoryIndex` to `MemoryQuery` (import from `./indexes`). The existing `MemoryIndex` class structurally satisfies everything except `mode`/`ledger`/`accessAvailable` — consumers that used `index.isProcessed(...)` / `index.recordProcessed(...)` switch to `index.ledger.isProcessed(...)` etc.; `SqliteIndex` wrapper provides the full surface. Unit tests that construct `new MemoryIndex(...)` directly for sqlite-specific behavior stay as-is (they test the inner class); tests constructing indexes for CONSUMER calls switch to `openMemoryIndex(dir, { ok: true })`.
- Entry points (`cli.ts openIndex`, `mcp-server/main.ts`, `probe.ts`, `eval/run.ts`): `probeSqlite(storeDir, env)` → `openMemoryIndex(storeDir, probe, { warn })`; cli threads its `err` sink as warn (tests can capture). eval keeps its tmp `dbPath` override in sqlite mode; in fallback mode it scans the golden store dir directly.
- `cli.ts reindex` in fallback mode: prints `markdown is the store — nothing to rebuild (filescan mode)` and exits 0.
- `mcp-server/server.ts memory_stats`: include `mode` and `accessAvailable` in the JSON (additive).
- **Fallback E2E test** (`distiller/fallback.e2e.test.ts`, all with `AGENT_MEMORY_NO_SQLITE=1` env passed explicitly): (a) FakeLlm pipeline run in a scratch HOME → memories written, ledger.jsonl exists, rerun `already-done` (idempotent), INDEX.md rendered; (b) runCli stats/review/approve/reject flow works in filescan mode (approve moves file, subsequent getById finds new path WITHOUT any upsert — filesystem is the index); (c) buildServer + InMemoryTransport client: search_memory returns hits, get_memory works, memory_stats reports `mode: "filescan"`, `accessAvailable: false`; (d) warning appears exactly once per entry-point invocation; (e) `bun run eval --retrieval-only` logic path: runEval retrieval in fallback mode passes the same 4 golden queries (call runEval directly with a probe-forced env NO — runEval reads env? thread a probe/env option through EvalOptions minimally).

**Steps:** failing tests → implement → PASS: full suite green in DEFAULT (sqlite) mode AND the new fallback suite green → smokes: `AGENT_MEMORY_NO_SQLITE=1 bun run mcp:probe --stats` (scratch HOME) prints stats with warning on stderr; `bun run eval --retrieval-only` still 4/4 in sqlite mode → commit `feat(distiller): sqlite-optional wiring — every entry point degrades to markdown scan`.

---

### Task 6: docs + VERIFY + real-machine validation

**Files:** Modify `README.md`, `LLM_WIKI.md`; Create `docs/superpowers/VERIFY-sqlite-optional.md`

- README: "SQLite-optional mode" section — probe behavior, warning text, capability table (what degrades, what's lost: bm25 ranking→substring scoring, access stats off), `AGENT_MEMORY_NO_SQLITE=1`, ledger.jsonl, corporate-deploy note (if sqlite works you get the accelerator automatically; nothing to configure).
- LLM_WIKI（繁中）: fallback 架構、逐功能降級表、ledger.jsonl 語義（單寫入者/torn-line 容忍）、警語格式、「markdown 為主 db 為輔」的原則說明、陷阱補充（filescan 無 access 統計→排序少一個訊號；search 為 substring 計分非 bm25）。
- VERIFY-sqlite-optional.md:
  ```markdown
  # VERIFY — sqlite-optional
  Status: PENDING
  Headless (executor MUST run):
  1. bun test — green (both mode suites).  2. bun run typecheck — clean.
  3. Real store, fallback smoke (READ-ONLY against real data):
     AGENT_MEMORY_NO_SQLITE=1 bun run mcp:probe "useful skew" → returns the ban
     memory with the fallback warning on stderr; --stats shows mode filescan and
     the same byStatus counts as sqlite mode.
  4. Real store, sqlite mode unchanged: bun run mcp:probe --stats → counts match
     pre-change baseline; no warning.
  5. Fallback distill dry-run on a scratch AGENT_MEMORY_HOME with 1-2 copied
     transcripts (opencode backend): memories produced, ledger.jsonl written,
     rerun idempotent.
  Interactive (user): 6. company environment: run setup + distill; if the probe
  fails there, confirm the warning appears and the flow still works end-to-end.
  ```
- Execute headless items 1-5 for real; record results.
- Commit `docs: sqlite-optional mode usage, degradation table, and verification`.
