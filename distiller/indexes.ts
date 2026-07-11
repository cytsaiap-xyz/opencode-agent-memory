import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { MemoryIndex } from "./ledger"
import type { SearchHit } from "./ledger"
import type { SqliteProbe } from "../shared/sqliteProbe"
import { listEntryPaths, parseEntry } from "./store"
import type { MemoryEntry } from "./types"
import { PIPELINE_VERSION } from "./types"

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
  // Only meaningful in sqlite mode (undefined in filescan — there's no fts schema to
  // migrate). Entry points must guard with `mode === "sqlite"` before reading this.
  readonly ftsRebuildNeeded?: boolean
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
  readonly ftsRebuildNeeded: boolean

  constructor(dbPath: string) {
    this.inner = new MemoryIndex(dbPath)
    this.ftsRebuildNeeded = this.inner.ftsRebuildNeeded
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

interface LedgerRecord {
  session_id: string
  content_hash: string
  pipeline_version: string
  extractor_model: string
  processed_at: string
  n_candidates: number
  n_committed: number
}

const ledgerKey = (sessionId: string, contentHash: string, pipelineVersion: string): string => `${sessionId}|${contentHash}|${pipelineVersion}`

/**
 * ledger.jsonl-backed LedgerFacet for filescan mode — a single-writer, append-only
 * substitute for the sqlite `processed_sessions` table. Lazily loads the whole file
 * into memory on first use (Set<"sid|hash|ver"> for isProcessed, plus running
 * count/max processed_at for stats()), then keeps that in-memory state in sync on
 * every recordProcessed so same-process reads always see same-process writes
 * without re-reading the file. A torn/unparseable FINAL line (crash mid-append) is
 * tolerated silently; any other unparseable line is skipped with a single
 * aggregate stderr warning for the whole load.
 *
 * Long-lived processes (mcp-server) can outlive an external writer's append — e.g. the
 * nightly distiller running as a separate process appends to the same ledger.jsonl
 * while this instance sits idle. To avoid serving stale isProcessed()/stats() answers
 * for the rest of the process lifetime, every entry point (ensureLoaded, called from
 * isProcessed/recordProcessed/count/lastProcessedAt) cheaply stats the file's mtime
 * and reloads whenever it has moved since the last load — a single statSync per call,
 * not a re-parse unless the file actually changed.
 */
class FileLedger implements LedgerFacet {
  private readonly path: string
  private readonly warn: (line: string) => void
  private keys: Set<string> | null = null
  private recordCount = 0
  private maxProcessedAt: string | null = null
  private lastMtimeMs: number | null = null

  constructor(storeDir: string, warn: (line: string) => void = console.error) {
    this.path = join(storeDir, "ledger.jsonl")
    this.warn = warn
  }

  private currentMtimeMs(): number | null {
    try {
      return statSync(this.path).mtimeMs
    } catch {
      return null
    }
  }

  private ensureLoaded(): void {
    const mtime = this.currentMtimeMs()
    // Already loaded and the file hasn't changed underneath us (including the "still
    // doesn't exist" case, mtime === null === lastMtimeMs) — skip the re-parse.
    if (this.keys !== null && mtime === this.lastMtimeMs) return
    const keys = new Set<string>()
    let maxProcessedAt: string | null = null
    let raw: string
    try {
      raw = readFileSync(this.path, "utf8")
    } catch {
      // ledger.jsonl doesn't exist yet — nothing processed so far
      this.keys = keys
      this.recordCount = 0
      this.maxProcessedAt = null
      this.lastMtimeMs = mtime
      return
    }
    const lines = raw.split("\n").filter((l) => l.length > 0)
    let badNonFinalCount = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const isLast = i === lines.length - 1
      let rec: LedgerRecord
      try {
        const parsed = JSON.parse(line)
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof parsed.session_id !== "string" ||
          typeof parsed.content_hash !== "string" ||
          typeof parsed.pipeline_version !== "string" ||
          typeof parsed.processed_at !== "string"
        ) {
          throw new Error("missing/invalid required field")
        }
        rec = parsed
      } catch (e) {
        // Torn/unparseable final line (crash mid-append) is expected and tolerated
        // without warning; any other bad line is unexpected corruption.
        if (!isLast) badNonFinalCount++
        continue
      }
      keys.add(ledgerKey(rec.session_id, rec.content_hash, rec.pipeline_version))
      if (maxProcessedAt === null || rec.processed_at > maxProcessedAt) maxProcessedAt = rec.processed_at
    }
    if (badNonFinalCount > 0) {
      this.warn(`agent-memory: ledger.jsonl: skipped ${badNonFinalCount} unparseable non-final line(s)`)
    }
    this.keys = keys
    this.recordCount = keys.size
    this.maxProcessedAt = maxProcessedAt
    this.lastMtimeMs = mtime
  }

  isProcessed(sessionId: string, contentHash: string): boolean {
    this.ensureLoaded()
    return this.keys!.has(ledgerKey(sessionId, contentHash, PIPELINE_VERSION))
  }

  recordProcessed(row: { session_id: string; content_hash: string; extractor_model: string; n_candidates: number; n_committed: number }): void {
    this.ensureLoaded()
    const rec: LedgerRecord = {
      session_id: row.session_id,
      content_hash: row.content_hash,
      pipeline_version: PIPELINE_VERSION,
      extractor_model: row.extractor_model,
      processed_at: new Date().toISOString(),
      n_candidates: row.n_candidates,
      n_committed: row.n_committed,
    }
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, JSON.stringify(rec) + "\n")

    // Same-process read-your-writes: update in-memory state immediately rather
    // than relying on a re-read of the file we just appended to. Also refresh the
    // mtime bookmark to match what we just wrote, so the next ensureLoaded() call
    // (from this same instance) doesn't pay for a redundant reload of the file we
    // already have fully reflected in memory.
    const key = ledgerKey(rec.session_id, rec.content_hash, rec.pipeline_version)
    if (!this.keys!.has(key)) {
      this.keys!.add(key)
      this.recordCount = this.keys!.size
    }
    if (this.maxProcessedAt === null || rec.processed_at > this.maxProcessedAt) this.maxProcessedAt = rec.processed_at
    this.lastMtimeMs = this.currentMtimeMs()
  }

  count(): number {
    this.ensureLoaded()
    return this.recordCount
  }

  lastProcessedAt(): string | null {
    this.ensureLoaded()
    return this.maxProcessedAt
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
  private ledgerImpl: FileLedger
  readonly ledger: LedgerFacet

  constructor(storeDir: string, warn: (line: string) => void = console.error) {
    this.storeDir = storeDir
    this.ledgerImpl = new FileLedger(storeDir, warn)
    this.ledger = this.ledgerImpl
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
    return {
      byStatus,
      byType,
      sessions: this.ledgerImpl.count(),
      lastProcessedAt: this.ledgerImpl.lastProcessedAt(),
      accessAvailable: false,
    }
  }

  recordAccess(_id: string): void {
    // no-op: access stats are unavailable in filescan mode
  }

  accessStats(_id: string): { access_count: number; last_accessed: string | null } | null {
    return null
  }

  rebuildFrom(_storeDir: string): Promise<number> {
    // Filescan mode has no separate index to rebuild — the filesystem itself is the
    // index. Just report how many entries currently parse.
    return Promise.resolve(this.entries().length)
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
  return new FileScanIndex(storeDir, warn)
}
