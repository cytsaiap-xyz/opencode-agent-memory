import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SearchHit } from "../distiller/ledger"
import type { MemoryQuery } from "../distiller/indexes"
import { listEntryPaths, parseEntry } from "../distiller/store"
import type { MemoryEntry } from "../distiller/types"

export interface SearchOpts {
  query: string; project?: string; type?: string; domain?: string
  include_tentative?: boolean; limit?: number
}

export interface MemorySummary {
  id: string; title: string; trigger: string; lesson: string
  type: string; project: string; domain: string[]
  confidence: number; updated_at: string
}

const RECENCY_WINDOW_MS = 30 * 24 * 3600_000

export function searchMemory(index: MemoryQuery, opts: SearchOpts, now: Date = new Date()): MemorySummary[] {
  const limit = Math.min(opts.limit ?? 10, 50)
  let hits: SearchHit[] = index.search(opts.query, {
    project: opts.project,
    type: opts.type,
    status: "active",
    minConfidence: opts.include_tentative ? 0 : 0.5,
    limit: Math.max(30, limit),
  })
  if (opts.domain) hits = hits.filter((h) => h.entry.domain.includes(opts.domain!))
  // index.search() returns hits in bm25 order (best match first). Raw bm25 magnitudes are
  // corpus-scale dependent (often ~1e-6 on small stores), so blending them additively with a
  // confidence/recency term let those terms dominate relevance outright. Instead, rerank by
  // bm25 *rank position* and let confidence/recency nudge within a bounded window: a hit can
  // move at most ~1.7 rank positions, so relevance ordering still wins beyond adjacent hits.
  const score = (h: SearchHit, i: number): number => {
    const recent = now.getTime() - new Date(h.entry.updated_at).getTime() <= RECENCY_WINDOW_MS
    return i - h.entry.confidence - (recent ? 0.75 : 0)
  }
  hits = hits
    .map((h, i) => ({ h, s: score(h, i) }))
    .sort((a, b) => a.s - b.s)
    .map((x) => x.h)
  const top = hits.slice(0, limit)
  for (const h of top) {
    try {
      index.recordAccess(h.entry.id)
    } catch {
      // access stats are a nice-to-have signal, not the product; a write-lock
      // contention (e.g. SQLITE_BUSY while the distiller holds the write lock)
      // must not turn a successful search into a failed one.
    }
  }
  return top.map((h) => ({
    id: h.entry.id, title: h.entry.title, trigger: h.entry.trigger, lesson: h.entry.lesson,
    type: h.entry.type, project: h.entry.project, domain: h.entry.domain,
    confidence: h.entry.confidence, updated_at: h.entry.updated_at,
  }))
}

export function getMemory(index: MemoryQuery, id: string): (MemoryEntry & { path: string }) | null {
  const hit = index.getById(id)
  if (!hit) return null
  try {
    index.recordAccess(id)
  } catch {
    // best-effort — see searchMemory's recordAccess guard for rationale
  }
  return { ...hit.entry, path: hit.path }
}

export function listDomains(storeDir: string, project?: string): {
  domains: Record<string, number>; types: Record<string, number>; projects: Record<string, number>
} {
  const domains: Record<string, number> = {}
  const types: Record<string, number> = {}
  const projects: Record<string, number> = {}
  for (const path of listEntryPaths(storeDir)) {
    try {
      const e = parseEntry(readFileSync(path, "utf8"))
      if (e.status !== "active") continue
      if (project && e.project !== project) continue
      projects[e.project] = (projects[e.project] ?? 0) + 1
      types[e.type] = (types[e.type] ?? 0) + 1
      for (const d of e.domain) domains[d] = (domains[d] ?? 0) + 1
    } catch {
      // corrupt entry: skip
    }
  }
  return { domains, types, projects }
}

export function memoryStats(index: MemoryQuery, storeDir: string): {
  byStatus: Record<string, number>; byType: Record<string, number>
  sessions: number; lastProcessedAt: string | null; quarantineFiles: number
  mode: "sqlite" | "filescan"; accessAvailable: boolean
} {
  let quarantineFiles = 0
  try {
    quarantineFiles = readdirSync(join(storeDir, "quarantine")).filter((n) => n.endsWith(".md")).length
  } catch {
    // no quarantine dir
  }
  // index.stats() already includes accessAvailable (IndexStats); mode is added here
  // additively so existing consumers parsing the JSON are unaffected by new fields.
  return { ...index.stats(), quarantineFiles, mode: index.mode }
}
