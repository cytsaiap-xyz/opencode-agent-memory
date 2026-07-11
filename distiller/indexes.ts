import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { MemoryIndex } from "./ledger"
import type { SearchHit } from "./ledger"
import type { SqliteProbe } from "../shared/sqliteProbe"
import type { MemoryEntry } from "./types"

export interface LedgerFacet {
  isProcessed(sessionId: string, contentHash: string): boolean
  recordProcessed(row: { session_id: string; content_hash: string; extractor_model: string; n_candidates: number; n_committed: number }): void
}

export interface IndexStats {
  byStatus: Record<string, number>
  byType: Record<string, number>
  sessions: number
  lastProcessedAt: string | null
  accessAvailable: boolean
}

export interface MemoryQuery {
  readonly mode: "sqlite" | "filescan"
  search(query: string, opts?: { project?: string; type?: string; status?: string; minConfidence?: number; limit?: number }): SearchHit[]
  getById(id: string): SearchHit | null
  upsertEntry(e: MemoryEntry, path: string): void // filescan: no-op
  removeEntry(id: string): void // filescan: no-op
  stats(): IndexStats
  recordAccess(id: string): void // filescan: no-op
  accessStats(id: string): { access_count: number; last_accessed: string | null } | null // filescan: null
  ledger: LedgerFacet
  rebuildFrom(storeDir: string): Promise<number> // filescan: no-op returning current entry count
  close(): void
}

/**
 * Thin wrapper around the existing MemoryIndex, delegating every method unchanged.
 * distiller/ledger.ts stays untouched — this class only adapts its surface to the
 * MemoryQuery interface (adds `mode`, `ledger` facet, `accessAvailable`).
 */
export class SqliteIndex implements MemoryQuery {
  readonly mode = "sqlite" as const
  private inner: MemoryIndex
  readonly ledger: LedgerFacet

  constructor(dbPath: string) {
    this.inner = new MemoryIndex(dbPath)
    const inner = this.inner
    this.ledger = {
      isProcessed(sessionId, contentHash) {
        return inner.isProcessed(sessionId, contentHash)
      },
      recordProcessed(row) {
        inner.recordProcessed(row)
      },
    }
  }

  search(query: string, opts?: { project?: string; type?: string; status?: string; minConfidence?: number; limit?: number }): SearchHit[] {
    return this.inner.search(query, opts)
  }

  getById(id: string): SearchHit | null {
    return this.inner.getById(id)
  }

  upsertEntry(e: MemoryEntry, path: string): void {
    this.inner.upsertEntry(e, path)
  }

  removeEntry(id: string): void {
    this.inner.removeEntry(id)
  }

  stats(): IndexStats {
    const s = this.inner.stats()
    return { ...s, accessAvailable: true }
  }

  recordAccess(id: string): void {
    this.inner.recordAccess(id)
  }

  accessStats(id: string): { access_count: number; last_accessed: string | null } | null {
    return this.inner.accessStats(id)
  }

  rebuildFrom(storeDir: string): Promise<number> {
    return this.inner.rebuildFrom(storeDir)
  }

  close(): void {
    this.inner.close()
  }
}

/**
 * Markdown-scan fallback used when sqlite is unavailable. Task 2 only lays down the
 * class skeleton — every method except `mode`/`close` throws until Tasks 3/4 implement
 * search/getById/stats/ledger semantics against the live filesystem.
 */
export class FileScanIndex implements MemoryQuery {
  readonly mode = "filescan" as const
  private storeDir: string

  constructor(storeDir: string) {
    this.storeDir = storeDir
  }

  search(_query: string, _opts?: { project?: string; type?: string; status?: string; minConfidence?: number; limit?: number }): SearchHit[] {
    throw new Error("filescan: not implemented yet")
  }

  getById(_id: string): SearchHit | null {
    throw new Error("filescan: not implemented yet")
  }

  upsertEntry(_e: MemoryEntry, _path: string): void {
    throw new Error("filescan: not implemented yet")
  }

  removeEntry(_id: string): void {
    throw new Error("filescan: not implemented yet")
  }

  stats(): IndexStats {
    throw new Error("filescan: not implemented yet")
  }

  recordAccess(_id: string): void {
    throw new Error("filescan: not implemented yet")
  }

  accessStats(_id: string): { access_count: number; last_accessed: string | null } | null {
    throw new Error("filescan: not implemented yet")
  }

  get ledger(): LedgerFacet {
    throw new Error("filescan: not implemented yet")
  }

  rebuildFrom(_storeDir: string): Promise<number> {
    throw new Error("filescan: not implemented yet")
  }

  close(): void {
    // no-op: no resources to release for a markdown-scan index
  }
}

export function openMemoryIndex(
  storeDir: string,
  probe: SqliteProbe,
  opts?: { dbPath?: string; warn?: (line: string) => void },
): MemoryQuery {
  if (probe.ok) {
    mkdirSync(storeDir, { recursive: true })
    const dbPath = opts?.dbPath ?? join(storeDir, "index.db")
    mkdirSync(dirname(dbPath), { recursive: true })
    return new SqliteIndex(dbPath)
  }

  // Dedup ("once per process per entry point") is the entry point's responsibility —
  // an entry point calls this factory once per process. Here we simply emit exactly
  // one warn call per factory invocation.
  const warn = opts?.warn ?? console.error
  warn(
    `agent-memory: sqlite unavailable (${probe.reason}) — markdown-scan mode: search is O(n) without bm25 ranking, access stats disabled, ledger uses ledger.jsonl`,
  )
  return new FileScanIndex(storeDir)
}
