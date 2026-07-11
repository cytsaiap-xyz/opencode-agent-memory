import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import type { EvidenceRef, MemoryClass, MemoryEntry, MemoryStatus, MemoryType, ReviewState } from "./types"

const RAW_SAFE = /^[A-Za-z0-9_./:+-]+$/

const MEMORY_TYPES: readonly MemoryType[] = ["decision", "root_cause", "pitfall", "know_how", "convention", "workflow"]
const MEMORY_CLASSES: readonly MemoryClass[] = ["episodic", "semantic", "procedural"]
const STATUSES: readonly MemoryStatus[] = ["candidate", "active", "superseded", "quarantined", "archived"]
const REVIEWS: readonly ReviewState[] = ["auto", "human_pending", "human_approved"]

// Strings that would be sniffed as a JSON scalar by parseValue (leading digit / "-digit",
// or an exact true/false/null) must be quoted even though they're otherwise raw-safe,
// or they'd come back as a number/boolean/null instead of a string.
const LOOKS_LIKE_JSON_SCALAR = /^-?\d|^(?:true|false|null)$/

const enc = (v: unknown): string => {
  if (v === null) return "null"
  if (typeof v === "string") {
    if (!RAW_SAFE.test(v) || LOOKS_LIKE_JSON_SCALAR.test(v)) return JSON.stringify(v)
    return v
  }
  if (typeof v === "boolean" || typeof v === "number") return String(v)
  return JSON.stringify(v)
}

export function serializeEntry(e: MemoryEntry): string {
  const fm = [
    "---",
    `id: ${enc(e.id)}`,
    `memory_class: ${enc(e.memory_class)}`,
    `type: ${enc(e.type)}`,
    `title: ${enc(e.title)}`,
    `trigger: ${enc(e.trigger)}`,
    `project: ${enc(e.project)}`,
    `scope: ${enc(e.scope)}`,
    `domain: ${JSON.stringify(e.domain)}`,
    `volatile: ${e.volatile}`,
    `confidence: ${e.confidence}`,
    `status: ${enc(e.status)}`,
    `superseded_by: ${enc(e.superseded_by)}`,
    `supersedes: ${enc(e.supersedes)}`,
    `promoted_from: ${enc(e.promoted_from)}`,
    `absorbs: ${JSON.stringify(e.absorbs ?? null)}`,
    `review: ${enc(e.review)}`,
    `evidence: ${JSON.stringify(e.evidence)}`,
    `provenance: ${JSON.stringify(e.provenance)}`,
    `created_at: ${enc(e.created_at)}`,
    `updated_at: ${enc(e.updated_at)}`,
    "---",
    "",
    e.lesson.trim(), // lesson is stored trimmed (parseEntry trims symmetrically)
  ]
  if (e.notes.length > 0) fm.push("", "## Notes", "", ...e.notes.map((n) => `- ${enc(n)}`))
  return fm.join("\n") + "\n"
}

const parseValue = (raw: string): unknown => {
  const t = raw.trim()
  if (/^["[{]|^-?\d|^(true|false|null)$/.test(t)) {
    try {
      return JSON.parse(t)
    } catch {
      return t
    }
  }
  return t
}

export function parseEntry(markdown: string): MemoryEntry {
  const m = markdown.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) throw new Error("memory entry: missing frontmatter")
  const fields = new Map<string, unknown>()
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(": ")
    if (idx > 0) fields.set(line.slice(0, idx), parseValue(line.slice(idx + 2)))
  }
  const req = (key: string): unknown => {
    if (!fields.has(key)) throw new Error(`memory entry: missing field "${key}"`)
    return fields.get(key)
  }
  const str = (key: string): string => {
    const v = req(key)
    if (typeof v !== "string" || v.length === 0) throw new Error(`memory entry: field "${key}" must be a non-empty string`)
    return v
  }
  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T => {
    const v = str(key)
    if (!(allowed as readonly string[]).includes(v)) throw new Error(`memory entry: invalid ${key} "${v}"`)
    return v as T
  }

  const body = markdown.slice(m[0]!.length)
  // Only treat "## Notes" as a real notes section when it's shaped exactly as the
  // serializer writes it: anchored at the end of the body and consisting solely of a
  // trailing bullet list. Anything else (e.g. "## Notes" appearing mid-lesson) is left
  // as part of the lesson instead of being silently truncated/misfiled.
  const notesMatch = body.match(/\n\n## Notes\n\n((?:- [^\n]*\n?)+)$/)
  const lesson = (notesMatch ? body.slice(0, notesMatch.index) : body).trim()
  if (!lesson) throw new Error("memory entry: empty lesson body")
  const notes = (notesMatch ? notesMatch[1]! : "")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => parseValue(l.slice(2)) as string)

  const domain = req("domain")
  if (!Array.isArray(domain) || domain.length === 0 || !domain.every((d) => typeof d === "string"))
    throw new Error(`memory entry: field "domain" must be a non-empty string array`)
  const evidence = req("evidence")
  if (!Array.isArray(evidence)) throw new Error(`memory entry: field "evidence" must be an array`)
  const provenance = req("provenance") as { extractor?: unknown; prompt_hash?: unknown }
  if (typeof provenance !== "object" || provenance === null || typeof provenance.extractor !== "string" || typeof provenance.prompt_hash !== "string")
    throw new Error(`memory entry: field "provenance" malformed`)
  const confidence = req("confidence")
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1)
    throw new Error(`memory entry: field "confidence" out of range`)
  const volatile = req("volatile")
  if (typeof volatile !== "boolean") throw new Error(`memory entry: field "volatile" must be boolean`)
  const supersededBy = req("superseded_by")
  if (supersededBy !== null && typeof supersededBy !== "string")
    throw new Error(`memory entry: field "superseded_by" must be string or null`)
  const supersedes = fields.has("supersedes") ? fields.get("supersedes") : null
  if (supersedes !== null && typeof supersedes !== "string")
    throw new Error(`memory entry: field "supersedes" must be string or null`)
  const promotedFrom = fields.has("promoted_from") ? fields.get("promoted_from") : null
  if (promotedFrom !== null && typeof promotedFrom !== "string")
    throw new Error(`memory entry: field "promoted_from" must be string or null`)
  const absorbs = fields.has("absorbs") ? fields.get("absorbs") : null
  if (absorbs !== null && (!Array.isArray(absorbs) || !absorbs.every((a) => typeof a === "string")))
    throw new Error(`memory entry: field "absorbs" must be a string array or null`)
  const scope = oneOf("scope", ["project", "global"] as const)

  return {
    id: str("id"),
    memory_class: oneOf("memory_class", MEMORY_CLASSES),
    type: oneOf("type", MEMORY_TYPES),
    title: str("title"),
    trigger: str("trigger"),
    project: str("project"),
    scope,
    domain: domain as string[],
    volatile,
    confidence,
    status: oneOf("status", STATUSES),
    superseded_by: supersededBy,
    supersedes,
    promoted_from: promotedFrom,
    absorbs: absorbs as string[] | null,
    review: oneOf("review", REVIEWS),
    evidence: evidence as EvidenceRef[],
    provenance: { extractor: provenance.extractor, prompt_hash: provenance.prompt_hash },
    created_at: str("created_at"),
    updated_at: str("updated_at"),
    lesson,
    notes,
  }
}

export function entryId(project: string, title: string, date: Date): string {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "")
  const hash = createHash("sha256").update(`${project}\n${title}`).digest("hex").slice(0, 6)
  return `mem_${day}_${hash}`
}

export function entryPath(storeDir: string, e: MemoryEntry): string {
  return join(storeDir, "memories", e.project, `${e.id}.md`)
}

export async function writeEntry(storeDir: string, e: MemoryEntry): Promise<string> {
  const path = entryPath(storeDir, e)
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, serializeEntry(e))
  return path
}

export async function readEntry(path: string): Promise<MemoryEntry> {
  return parseEntry(await Bun.file(path).text())
}

export function listEntryPaths(storeDir: string): string[] {
  const root = join(storeDir, "memories")
  const out: string[] = []
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
      else if (p.endsWith(".md")) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

export function quarantinePath(storeDir: string, id: string): string {
  return join(storeDir, "quarantine", `${id}.md`)
}

// Shared "-2/-3… suffix" uniquify convention for any path that writes a fresh entry under
// a deterministic (project+title+day) id: appends a numeric suffix until BOTH the
// filesystem (via pathFor) and the live index (via getById) agree the id is free, so a
// same-project/title/day collision can never silently overwrite an existing file or
// repoint an index row that isn't this same write. Returns e unchanged when e.id is
// already free (the common case). Used by reconcile.ts's addEntry, quarantine.ts's
// writeQuarantineEntry, and reflect.ts's insight write — one convention, one place.
export function uniquifyEntryId<T extends MemoryEntry>(
  e: T,
  pathFor: (id: string) => string,
  getById: (id: string) => unknown | null,
): T {
  if (!existsSync(pathFor(e.id)) && getById(e.id) === null) return e
  let suffix = 2
  let id = `${e.id}-${suffix}`
  while (existsSync(pathFor(id)) || getById(id) !== null) {
    suffix++
    id = `${e.id}-${suffix}`
  }
  return { ...e, id }
}

export function computeConfidence(input: { sessions: number; humanApproved: boolean; contradicted: boolean }): number {
  const raw = 0.5 + 0.15 * (input.sessions - 1) + (input.humanApproved ? 0.2 : 0) - (input.contradicted ? 0.25 : 0)
  return Math.round(Math.min(0.95, Math.max(0.1, raw)) * 100) / 100
}
