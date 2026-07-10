import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export interface TranscriptMeta {
  path: string; sessionId: string; project: string
  contentHash: string; timeEnd: string; exportedAt: string
  title: string; body: string
}

const parseValue = (raw: string): string => {
  const t = raw.trim()
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string
    } catch {
      return t
    }
  }
  return t
}

export function parseTranscript(path: string, markdown: string): TranscriptMeta {
  const m = markdown.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) throw new Error(`transcript ${path}: missing frontmatter`)
  const fields = new Map<string, string>()
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(": ")
    if (idx > 0) fields.set(line.slice(0, idx), parseValue(line.slice(idx + 2)))
  }
  const req = (key: string): string => {
    const v = fields.get(key)
    if (!v) throw new Error(`transcript ${path}: missing field "${key}"`)
    return v
  }
  return {
    path,
    sessionId: req("session_id"),
    project: basename(dirname(path)),
    contentHash: req("content_hash"),
    timeEnd: req("time_end"),
    exportedAt: req("exported_at"),
    title: req("title"),
    body: markdown.slice(m[0]!.length),
  }
}

export function scanSpool(transcriptsDir: string): TranscriptMeta[] {
  const out: TranscriptMeta[] = []
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith(".md")) {
        try {
          out.push(parseTranscript(p, readFileSync(p, "utf8")))
        } catch {
          // unparseable transcript: skip, never abort the scan
        }
      }
    }
  }
  walk(transcriptsDir)
  return out.sort((a, b) => a.timeEnd.localeCompare(b.timeEnd))
}

export function isEligible(meta: TranscriptMeta, now: Date, idleHours: number): boolean {
  return now.getTime() - new Date(meta.timeEnd).getTime() >= idleHours * 3600_000
}

export function anchorsIn(body: string): Set<string> {
  const out = new Set<string>()
  for (const m of body.matchAll(/\{#([^}]+)\}/g)) out.add(m[1]!)
  return out
}
