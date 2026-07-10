import { Database } from "bun:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { listEntryPaths, parseEntry } from "./store"
import type { MemoryEntry } from "./types"
import { PIPELINE_VERSION } from "./types"

export interface LedgerRow {
  session_id: string; content_hash: string; pipeline_version: string
  extractor_model: string; processed_at: string; n_candidates: number; n_committed: number
}

export interface SearchHit { entry: MemoryEntry; path: string; score: number }

const DDL = `
CREATE TABLE IF NOT EXISTS processed_sessions (
  session_id TEXT NOT NULL, content_hash TEXT NOT NULL, pipeline_version TEXT NOT NULL,
  extractor_model TEXT NOT NULL, processed_at TEXT NOT NULL,
  n_candidates INTEGER NOT NULL, n_committed INTEGER NOT NULL,
  PRIMARY KEY (session_id, content_hash, pipeline_version)
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
  confidence REAL NOT NULL, volatile INTEGER NOT NULL, path TEXT NOT NULL,
  updated_at TEXT NOT NULL, access_count INTEGER NOT NULL DEFAULT 0, last_accessed TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, trigger, lesson, domain);
`

const ftsQuery = (query: string): string =>
  query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" OR ")

export class MemoryIndex {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA busy_timeout = 5000")
    this.db.run(DDL)
  }

  isProcessed(sessionId: string, contentHash: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM processed_sessions WHERE session_id = ? AND content_hash = ? AND pipeline_version = ?`)
        .get(sessionId, contentHash, PIPELINE_VERSION) !== null
    )
  }

  recordProcessed(row: Omit<LedgerRow, "pipeline_version" | "processed_at">): void {
    this.db.run(
      `INSERT OR REPLACE INTO processed_sessions
       (session_id, content_hash, pipeline_version, extractor_model, processed_at, n_candidates, n_committed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.session_id, row.content_hash, PIPELINE_VERSION, row.extractor_model, new Date().toISOString(), row.n_candidates, row.n_committed],
    )
  }

  upsertEntry(e: MemoryEntry, path: string): void {
    this.db.run(`DELETE FROM memories_fts WHERE id = ?`, [e.id])
    this.db.run(
      `INSERT INTO memories (id, project, type, status, confidence, volatile, path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project=excluded.project, type=excluded.type, status=excluded.status, confidence=excluded.confidence, volatile=excluded.volatile, path=excluded.path, updated_at=excluded.updated_at`,
      [e.id, e.project, e.type, e.status, e.confidence, e.volatile ? 1 : 0, path, e.updated_at],
    )
    this.db.run(`INSERT INTO memories_fts (id, title, trigger, lesson, domain) VALUES (?, ?, ?, ?, ?)`, [
      e.id, e.title, e.trigger, e.lesson, e.domain.join(" "),
    ])
  }

  removeEntry(id: string): void {
    this.db.run(`DELETE FROM memories_fts WHERE id = ?`, [id])
    this.db.run(`DELETE FROM memories WHERE id = ?`, [id])
  }

  search(
    query: string,
    opts: { project?: string; type?: string; status?: string; minConfidence?: number; limit?: number } = {},
  ): SearchHit[] {
    const fts = ftsQuery(query)
    if (!fts) return []
    const conds: string[] = ["memories_fts MATCH ?"]
    const params: (string | number)[] = [fts]
    if (opts.project) { conds.push("m.project = ?"); params.push(opts.project) }
    if (opts.type) { conds.push("m.type = ?"); params.push(opts.type) }
    if (opts.status) { conds.push("m.status = ?"); params.push(opts.status) }
    if (opts.minConfidence !== undefined) { conds.push("m.confidence >= ?"); params.push(opts.minConfidence) }
    params.push(opts.limit ?? 10)
    const rows = this.db
      .query(
        `SELECT m.path AS path, bm25(memories_fts) AS score
         FROM memories_fts JOIN memories m ON m.id = memories_fts.id
         WHERE ${conds.join(" AND ")} ORDER BY score LIMIT ?`,
      )
      .all(...params) as Array<{ path: string; score: number }>
    const hits: SearchHit[] = []
    for (const r of rows) {
      try {
        hits.push({ entry: parseEntry(readFileSync(r.path, "utf8")), path: r.path, score: r.score })
      } catch {
        // stale index row (file moved/deleted) — skip; reindex heals
      }
    }
    return hits
  }

  getById(id: string): SearchHit | null {
    const row = this.db.query(`SELECT path FROM memories WHERE id = ?`).get(id) as { path: string } | null
    if (!row) return null
    try {
      return { entry: parseEntry(readFileSync(row.path, "utf8")), path: row.path, score: 0 }
    } catch {
      return null
    }
  }

  recordAccess(id: string): void {
    this.db.run(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`, [
      new Date().toISOString(), id,
    ])
  }

  stats(): { byStatus: Record<string, number>; byType: Record<string, number>; sessions: number; lastProcessedAt: string | null } {
    const byStatus: Record<string, number> = {}
    for (const r of this.db.query(`SELECT status, COUNT(*) AS n FROM memories GROUP BY status`).all() as Array<{ status: string; n: number }>)
      byStatus[r.status] = r.n
    const byType: Record<string, number> = {}
    for (const r of this.db.query(`SELECT type, COUNT(*) AS n FROM memories GROUP BY type`).all() as Array<{ type: string; n: number }>)
      byType[r.type] = r.n
    const sessions = (this.db.query(`SELECT COUNT(*) AS n FROM processed_sessions`).get() as { n: number }).n
    const lastProcessedAt = (this.db.query("SELECT MAX(processed_at) AS m FROM processed_sessions").get() as { m: string | null }).m
    return { byStatus, byType, sessions, lastProcessedAt }
  }

  accessStats(id: string): { access_count: number; last_accessed: string | null } | null {
    const row = this.db.query(`SELECT access_count, last_accessed FROM memories WHERE id = ?`).get(id) as { access_count: number; last_accessed: string | null } | null
    return row
  }

  async rebuildFrom(storeDir: string): Promise<number> {
    // Quarantined entries live under storeDir/quarantine, not storeDir/memories, and would
    // otherwise be permanently dropped from the index by a reindex (rebuildFrom wipes the
    // tables first, so anything not re-scanned here is simply gone).
    const quarantineDir = join(storeDir, "quarantine")
    let qPaths: string[] = []
    try {
      qPaths = readdirSync(quarantineDir).filter((f) => f.endsWith(".md")).map((f) => join(quarantineDir, f))
    } catch {
      // quarantine dir doesn't exist yet
    }
    // File reads (the async part) happen before the transaction opens: a BEGIN IMMEDIATE
    // held open across `await Bun.file(...).text()` calls would keep the write lock for the
    // whole rebuild's I/O, not just the DB writes. Read everything first, then do the
    // DELETE+re-insert as one atomic unit so concurrent WAL readers always see either the
    // pre-rebuild or post-rebuild index, never a half-wiped one, and a mid-rebuild crash
    // rolls back instead of leaving the tables empty.
    const parsed: Array<{ entry: MemoryEntry; path: string }> = []
    for (const path of [...listEntryPaths(storeDir), ...qPaths]) {
      try {
        parsed.push({ entry: parseEntry(await Bun.file(path).text()), path })
      } catch (e) {
        // One corrupt/unparseable file must not abort the whole rebuild — skip it, warn,
        // and keep going; count only what parsed.
        console.error(`ledger: rebuildFrom: skipping unparseable file ${path}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.db.run("BEGIN IMMEDIATE")
    try {
      this.db.run(`DELETE FROM memories`)
      this.db.run(`DELETE FROM memories_fts`)
      for (const { entry, path } of parsed) this.upsertEntry(entry, path)
      this.db.run("COMMIT")
    } catch (e) {
      this.db.run("ROLLBACK")
      throw e
    }
    return parsed.length
  }

  close(): void {
    this.db.close()
  }
}
