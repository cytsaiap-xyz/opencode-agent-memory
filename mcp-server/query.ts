import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { MemoryIndex, SearchHit } from "../distiller/ledger"
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

export function searchMemory(index: MemoryIndex, opts: SearchOpts, now: Date = new Date()): MemorySummary[] {
  const limit = Math.min(opts.limit ?? 10, 50)
  let hits: SearchHit[] = index.search(opts.query, {
    project: opts.project,
    type: opts.type,
    status: "active",
    minConfidence: opts.include_tentative ? 0 : 0.5,
    limit: 30,
  })
  if (opts.domain) hits = hits.filter((h) => h.entry.domain.includes(opts.domain!))
  const score = (h: SearchHit): number => {
    const recent = now.getTime() - new Date(h.entry.updated_at).getTime() <= RECENCY_WINDOW_MS
    return h.score - 2 * h.entry.confidence + (recent ? -0.5 : 0)
  }
  hits.sort((a, b) => score(a) - score(b))
  const top = hits.slice(0, limit)
  for (const h of top) index.recordAccess(h.entry.id)
  return top.map((h) => ({
    id: h.entry.id, title: h.entry.title, trigger: h.entry.trigger, lesson: h.entry.lesson,
    type: h.entry.type, project: h.entry.project, domain: h.entry.domain,
    confidence: h.entry.confidence, updated_at: h.entry.updated_at,
  }))
}

export function getMemory(index: MemoryIndex, id: string): (MemoryEntry & { path: string }) | null {
  const hit = index.getById(id)
  if (!hit) return null
  index.recordAccess(id)
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

export function memoryStats(index: MemoryIndex, storeDir: string): {
  byStatus: Record<string, number>; byType: Record<string, number>
  sessions: number; lastProcessedAt: string | null; quarantineFiles: number
} {
  let quarantineFiles = 0
  try {
    quarantineFiles = readdirSync(join(storeDir, "quarantine")).filter((n) => n.endsWith(".md")).length
  } catch {
    // no quarantine dir
  }
  return { ...index.stats(), quarantineFiles }
}
