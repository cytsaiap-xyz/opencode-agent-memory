# SQLite-Optional Mode (markdown-primary, db-auxiliary) — Design Spec

**Date:** 2026-07-11
**Status:** DRAFT — pending user approval
**Motivation:** the corporate deployment environment may not support SQLite
(bun:sqlite native bindings, filesystem locking on restricted mounts, etc.).
The markdown store must remain the primary, self-sufficient surface; index.db
becomes an optional accelerator that is probed at startup and cleanly disabled
— with a visible warning — when unavailable.

## 1. Principle

Markdown files are already the source of truth; today index.db is a derived
projection PLUS two pieces of non-derived bookkeeping (processed-sessions
ledger, access stats). This spec makes every db-backed function either:
(a) fall back to a markdown-scan implementation, (b) fall back to a plain-file
implementation, or (c) switch off with a warning — per the table in §3.

## 2. Startup probe

`shared/sqliteProbe.ts`:

```ts
export interface SqliteProbe { ok: boolean; reason?: string }
export function probeSqlite(storeDir: string): SqliteProbe
```

- Attempts: dynamic `require("bun:sqlite")`, open a throwaway db file under
  `<storeDir>/.sqlite-probe.tmp`, `PRAGMA journal_mode = WAL`, create table,
  insert, read back, close, unlink. ANY throw → `{ ok: false, reason }`.
- Override: `AGENT_MEMORY_NO_SQLITE=1` forces `{ ok: false, reason: "disabled
  by AGENT_MEMORY_NO_SQLITE" }` — for testing both modes and for environments
  where the probe passes but production use later fails.
- Probe runs ONCE per process at each entry point (cli, mcp main, probe CLI,
  eval); result threaded through, never re-probed mid-run.

Warning (stderr, once per process, all entry points):
`agent-memory: sqlite unavailable (<reason>) — markdown-scan mode: search is
O(n) without bm25 ranking, access stats disabled, ledger uses ledger.jsonl`

## 3. Function-by-function fallback map

| db-backed function | consumer | fallback mode behavior |
|---|---|---|
| FTS search (bm25 + trigram) | mcp search_memory, reconcile neighbors, review | **markdown scan**: walk `listEntryPaths` + parse, deterministic keyword scoring (see §4), same filter semantics (status/confidence/project/type/domain) |
| getById | mcp get_memory, reviewops, quarantine uniquify | **filename scan**: id === basename; walk memories/ + quarantine/ |
| stats (byStatus/byType) | cli stats, mcp memory_stats | **markdown scan** counts |
| processed-sessions ledger | distiller idempotency | **`<storeDir>/ledger.jsonl`** append-only file (§5) — idempotency is a COST-SAFETY property and must never be silently dropped |
| lastProcessedAt / sessions count | stats | from ledger.jsonl |
| access_count / last_accessed | mcp recordAccess, ranking signal | **switched off** (recordAccess = no-op; stats report `access: unavailable`) — the only capability genuinely lost |
| rebuildFrom / reindex | cli reindex | **no-op with notice** (nothing to rebuild; markdown IS the store) |
| eval retrieval suite | bun run eval | runs against whichever mode is active; in fallback mode the CJK trigram query still passes via the scanner's substring matching (scan is substring-based, tokenizer-free) |

## 4. Fallback search scoring (deterministic, documented)

`FileScanIndex.search(query, opts)`:
1. Filter entries by opts (status default per caller, minConfidence, project,
   type) while walking.
2. Tokenize query the same way as the FTS path (unicode split); for each entry
   compute `hits = Σ per token (occurrences in title×3 + trigger×2 + lesson×1
   + domain×2)` — case-insensitive substring, so 2-char CJK tokens work
   natively (no trigram needed).
3. `score = -hits` (more negative = better, same convention as bm25), entries
   with `hits === 0` excluded; then the EXISTING rank-position boost in
   `searchMemory` (confidence + recency) applies unchanged on top.
4. Cap: same fetch-30-then-rerank shape as today.

Not identical ranking to bm25 — documented as such. At wiki scale (≤ low
thousands of entries) an O(n) parse-and-scan per query is measured-fine
(store parse throughput is already >1k entries/sec in the eval harness).

## 5. File ledger (`ledger.jsonl`)

- One JSON line per processed session: `{ session_id, content_hash,
  pipeline_version, extractor_model, processed_at, n_candidates, n_committed }`
  — same fields as the sqlite table.
- Loaded into a `Set<"sid|hash|ver">` at pipeline start; `recordProcessed`
  appends a line (single writer: only the distiller writes it; append-only, so
  a crash mid-write at worst truncates the final line — loader tolerates a
  torn last line).
- Used ONLY in fallback mode. Sqlite mode keeps the sqlite ledger (no dual
  write, no migration between the two: switching modes at worst re-processes
  sessions once, and RECONCILE dedupes as always).

## 6. Architecture

```ts
// distiller/indexes.ts
export interface MemoryQuery {           // read/search surface
  search(query, opts): SearchHit[]
  getById(id): SearchHit | null
  stats(): { byStatus; byType; sessions; lastProcessedAt; accessAvailable: boolean }
  recordAccess(id): void
  accessStats(id): { access_count; last_accessed } | null   // null in fallback
  ledger: { isProcessed(sid, hash): boolean; recordProcessed(row): void }
  rebuildFrom(storeDir): Promise<number>
  close(): void
  readonly mode: "sqlite" | "filescan"
}
export function openMemoryIndex(storeDir: string, probe: SqliteProbe): MemoryQuery
```

- `SqliteIndex` = today's `MemoryIndex` wrapped to the interface (behavior
  unchanged, all existing tests keep passing).
- `FileScanIndex` = new markdown-scan implementation (§3/§4/§5).
- All consumers (pipeline, reconcile, reviewops, cli, mcp-server, eval) switch
  from `new MemoryIndex(...)` to `openMemoryIndex(...)`; their logic is
  otherwise untouched.

## 7. Testing

- Probe: ok path; AGENT_MEMORY_NO_SQLITE forces fallback.
- FileScanIndex: contract tests run the SAME test suite against both
  implementations where semantics are shared (search filters, getById, stats
  counts, ledger idempotency) — one parametrized suite, two modes.
- Fallback pipeline end-to-end: FakeLlm distill run in NO_SQLITE mode → adds
  memories, ledger.jsonl written, rerun is idempotent, INDEX.md rendered.
- Fallback mcp: server tests re-run against filescan mode (search/get/stats
  work; access stats absent; read-only guarantee holds).
- CJK: 「時序」 substring search passes in filescan mode.
- Warning emitted exactly once per entry point.
- Regression: full existing suite green in sqlite mode (default unchanged).

## 8. Out of scope

- Dual-write or ledger migration between modes (mode switch = at-worst one
  re-extraction pass, reconciler dedupes).
- Performance work beyond documented O(n) scan (revisit if store > ~5k
  entries).
- INDEX.md-driven search (INDEX.md stays a human/LLM catalog; the scanner
  reads entry files directly — more accurate than parsing the catalog).
