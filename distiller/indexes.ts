import { mkdirSync, readFileSync, readdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { MemoryIndex } from "./ledger"
import type { SearchHit } from "./ledger"
import type { SqliteProbe } from "../shared/sqliteProbe"
import { listEntryPaths, parseEntry } from "./store"
import type { MemoryEntry } from "./types"

// Case-insensitive substring occurrence count (all occurrences, not just presence).
// Used by FileScanIndex.search's hits-weighted scoring — see spec §4.
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  let count = 0
  let from = 0
  for (;;) {
    const at = h.indexOf(n, from)
    if (at === -1) break
    count++
    from = at + n.length
  }
  return count
}

// Same unicode-aware token split as ledger.ts's MemoryIndex.search MATCH path
// (splits on anything that isn't a letter/number/underscore, per \p{L}\p{N}_).
// Kept identical here so a query behaves consistently whether sqlite or filescan
// mode answers it, even though filescan doesn't partition into long/short tokens.
function tokenize(query: string): string[] {
  return query.split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
}

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
 * Markdown-scan fallback used when sqlite is unavailable. search/getById/stats scan
 * the live filesystem on every call (Task 3) — no caching, so a writeEntry is
 * immediately visible to the next search/getById/stats without any upsert. The
 * ledger facet and rebuildFrom stay Task-2 stubs (wired to ledger.jsonl in Task 4);
 * upsertEntry/removeEntry/recordAccess are no-ops (filescan has nothing to update —
 * the filesystem itself is the index) and accessStats reports unavailable via null.
 */
export class FileScanIndex implements MemoryQuery {
  readonly mode = "filescan" as const
  private storeDir: string

  constructor(storeDir: string) {
    this.storeDir = storeDir
  }

  // Re-reads the filesystem on every call — deliberately uncached so writes are
  // immediately visible (write-then-read consistency is a hard requirement for
  // filescan mode, since there's no upsert step to keep an in-memory copy fresh).
  private entries(): Array<{ entry: MemoryEntry; path: string }> {
    const paths = [...listEntryPaths(this.storeDir)]
    const quarantineDir = join(this.storeDir, "quarantine")
    try {
      for (const f of readdirSync(quarantineDir)) {
        if (f.endsWith(".md")) paths.push(join(quarantineDir, f))
      }
    } catch {
      // quarantine dir doesn't exist yet — nothing to add
    }
    const out: Array<{ entry: MemoryEntry; path: string }> = []
    for (const path of paths) {
      try {
        out.push({ entry: parseEntry(readFileSync(path, "utf8")), path })
      } catch {
        // corrupt/unparseable file — tolerate, skip; matches sqlite rebuildFrom's
        // per-file tolerance instead of aborting the whole scan
      }
    }
    return out
  }

  search(query: string, opts: { project?: string; type?: string; status?: string; minConfidence?: number; limit?: number } = {}): SearchHit[] {
    const tokens = tokenize(query)
    const filtered = this.entries().filter(({ entry }) => {
      if (opts.status !== undefined && entry.status !== opts.status) return false
      if (opts.type !== undefined && entry.type !== opts.type) return false
      if (opts.project !== undefined && entry.project !== opts.project) return false
      if (opts.minConfidence !== undefined && entry.confidence < opts.minConfidence) return false
      return true
    })

    const scored: SearchHit[] = []
    for (const { entry, path } of filtered) {
      const domainStr = entry.domain.join(" ")
      let hits = 0
      for (const tok of tokens) {
        hits +=
          3 * countOccurrences(entry.title, tok) +
          2 * countOccurrences(entry.trigger, tok) +
          1 * countOccurrences(entry.lesson, tok) +
          2 * countOccurrences(domainStr, tok)
      }
      if (hits === 0) continue
      scored.push({ entry, path, score: -hits })
    }

    scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : b.entry.confidence - a.entry.confidence))
    return scored.slice(0, opts.limit ?? 10)
  }

  getById(id: string): SearchHit | null {
    const target = `${id}.md`
    for (const { entry, path } of this.entries()) {
      if (basename(path) === target) return { entry, path, score: 0 }
    }
    return null
  }

  upsertEntry(_e: MemoryEntry, _path: string): void {
    // no-op: the filesystem itself is the index in filescan mode
  }

  removeEntry(_id: string): void {
    // no-op: the filesystem itself is the index in filescan mode
  }

  stats(): IndexStats {
    const byStatus: Record<string, number> = {}
    const byType: Record<string, number> = {}
    for (const { entry } of this.entries()) {
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
      byType[entry.type] = (byType[entry.type] ?? 0) + 1
    }
    // sessions/lastProcessedAt are ledger.jsonl-backed (Task 4); placeholders for now.
    return { byStatus, byType, sessions: 0, lastProcessedAt: null, accessAvailable: false }
  }

  recordAccess(_id: string): void {
    // no-op: access stats are unavailable in filescan mode
  }

  accessStats(_id: string): { access_count: number; last_accessed: string | null } | null {
    return null
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
