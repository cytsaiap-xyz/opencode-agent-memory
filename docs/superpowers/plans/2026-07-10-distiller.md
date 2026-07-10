# Distiller (Plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The batch distiller: INGEST → TRIAGE → EXTRACT → VALIDATE → RECONCILE → COMMIT → PUBLISH over collector transcripts, producing memory-entry markdown files + a rebuildable SQLite FTS5 index, driven by a CLI (`run` / `reindex` / `review` / `stats`).

**Architecture:** Pure modules composed by a pipeline orchestrator. Canonical data = one memory per markdown file (`store/memories/<project>/<id>.md`, frontmatter per spec §7); `store/index.db` is a derived projection rebuilt by `reindex`. LLM behind a two-impl `LlmClient` interface (vLLM OpenAI-compatible with `json_schema`; `opencode run` dev fallback). Spec §6-§7; research patterns in `docs/research/2026-07-10-distillation-pipeline-patterns.md`.

**Tech Stack:** TypeScript + Bun, `bun:test`, `bun:sqlite`, `fetch` (built-in), `Bun.spawn`. Zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies.** Frontmatter is written AND parsed by our own code (values that are not plain identifiers are JSON-encoded — JSON is a YAML subset, so files stay standard-YAML-readable).
- All LLM output is schema-validated per field before entering the store (house rule). **Evidence anchors must resolve to `{#msg_id}` anchors present in the source transcript, or the candidate is rejected** (hallucination gate).
- Never delete: SUPERSEDE marks `status: superseded` + `superseded_by`; quarantine holds rejects with reasons; markdown files are the source of truth, `index.db` fully rebuildable.
- Confidence deterministic (spec amendment 2026-07-10): `0.5 + 0.15·(independent_sessions−1) + 0.2·human_approved − 0.25·contradicted`, clamp [0.1, 0.95].
- Ledger idempotency key: `(session_id, content_hash, pipeline_version)`. `PIPELINE_VERSION = "1"`.
- Tests: per-test tmp dirs; poll, never fixed sleeps; FakeLlm for all pipeline tests (no network, no opencode dependency in `bun test`).
- Config via env: `AGENT_MEMORY_LLM` (`vllm` | `opencode`, default `opencode`), `AGENT_MEMORY_VLLM_URL`, `AGENT_MEMORY_VLLM_MODEL`, `AGENT_MEMORY_VLLM_KEY` (optional), `AGENT_MEMORY_SALIENCE_MIN` (default 6), `AGENT_MEMORY_IDLE_HOURS` (default 6).
- `opencode run` invocations put the message argument BEFORE any flags (yargs array-flag trap, Spike A).
- Commits: conventional, English, scope `distiller` (or `shared` where applicable), trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01ALAk5sCENNGXZyy6mSg8tF`

---

### Task 1: distiller/types.ts + distiller/store.ts — memory entry model and markdown round-trip

**Files:**
- Create: `distiller/types.ts`, `distiller/store.ts`
- Test: `distiller/store.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type MemoryType = "decision" | "root_cause" | "pitfall" | "know_how" | "convention" | "workflow"
  export type MemoryClass = "episodic" | "semantic" | "procedural"
  export type MemoryStatus = "candidate" | "active" | "superseded" | "quarantined" | "archived"
  export type ReviewState = "auto" | "human_pending" | "human_approved"
  export interface EvidenceRef { session: string; anchors: string[]; observed_at: string }
  export interface MemoryEntry {
    id: string; memory_class: MemoryClass; type: MemoryType
    title: string; trigger: string; project: string; scope: "project" | "global"
    domain: string[]; volatile: boolean; confidence: number
    status: MemoryStatus; superseded_by: string | null; review: ReviewState
    evidence: EvidenceRef[]
    provenance: { extractor: string; prompt_hash: string }
    created_at: string; updated_at: string
    lesson: string; notes: string[]
  }
  export const PIPELINE_VERSION = "1"
  ```
- Produces (`store.ts`):
  - `serializeEntry(e: MemoryEntry): string` — frontmatter + lesson body + optional `## Notes` section (one `- ` bullet per note).
  - `parseEntry(markdown: string): MemoryEntry` — throws with a descriptive message on any missing/invalid field (strict: the store never holds half-parsed entries).
  - `entryId(project: string, title: string, date: Date): string` — `mem_<YYYYMMDD>_<sha256(project + "\n" + title).hex.slice(0,6)>` (deterministic for tests).
  - `entryPath(storeDir: string, e: MemoryEntry): string` — `<storeDir>/memories/<e.project>/<e.id>.md` (project `"global"` maps to `memories/global/`).
  - `writeEntry(storeDir: string, e: MemoryEntry): Promise<string>` (mkdir -p, write, return path)
  - `readEntry(path: string): Promise<MemoryEntry>`
  - `listEntryPaths(storeDir: string): string[]` (recursive `memories/**/*.md`, sorted)
  - `quarantinePath(storeDir: string, id: string): string` — `<storeDir>/quarantine/<id>.md`
  - `computeConfidence(input: { sessions: number; humanApproved: boolean; contradicted: boolean }): number`
- Frontmatter encoding contract: scalar strings that match `/^[A-Za-z0-9_./:-]+$/` are written raw; everything else JSON-encoded. Arrays/objects (`domain`, `evidence`, `provenance`) always JSON-encoded on one line. Parser: for each `key: value` line, `JSON.parse` the value if it starts with `"`/`[`/`{`/digit/`true`/`false`/`null`, else take the raw string; `null` → `null`.

- [ ] **Step 1: Write the failing tests**

`distiller/store.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeConfidence, entryId, entryPath, listEntryPaths, parseEntry,
  readEntry, serializeEntry, writeEntry,
} from "./store"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-store-"))

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "mem_20260710_abc123",
  memory_class: "semantic",
  type: "root_cause",
  title: 'Hold violations: stale SPEF, not the ECO',
  trigger: "when hold slack degrades after an ECO route",
  project: "chip-alpha",
  scope: "project",
  domain: ["sta", "eco-flow"],
  volatile: false,
  confidence: 0.5,
  status: "active",
  superseded_by: null,
  review: "auto",
  evidence: [{ session: "ses_x", anchors: ["msg_1", "msg_2"], observed_at: "2026-07-10T00:00:00.000Z" }],
  provenance: { extractor: "distiller v0.1 / fake", prompt_hash: "sha256:aa" },
  created_at: "2026-07-10T00:00:00.000Z",
  updated_at: "2026-07-10T00:00:00.000Z",
  lesson: "Re-extract parasitics before re-running STA after any ECO route.",
  notes: [],
  ...over,
})

test("serialize/parse round-trips every field exactly", () => {
  const entries = [
    entry(),
    entry({ notes: ["2026-07-11: confirmed on chip-beta (ses_y)", "second note"] }),
    entry({ title: 'tricky: "quotes" #hash \n newline', superseded_by: "mem_x", status: "superseded" }),
    entry({ scope: "global", project: "global", domain: ["a"] }),
  ]
  for (const e of entries) expect(parseEntry(serializeEntry(e))).toEqual(e)
})

test("parseEntry throws descriptively on missing field", () => {
  const bad = serializeEntry(entry()).replace(/^trigger: .*$/m, "")
  expect(() => parseEntry(bad)).toThrow(/trigger/)
})

test("parseEntry throws on invalid enum", () => {
  const bad = serializeEntry(entry()).replace("type: root_cause", "type: vibes")
  expect(() => parseEntry(bad)).toThrow(/type/)
})

test("entryId is deterministic and shaped", () => {
  const a = entryId("p", "t", new Date("2026-07-10T12:00:00Z"))
  expect(a).toBe(entryId("p", "t", new Date("2026-07-10T23:00:00Z")))
  expect(a).toMatch(/^mem_20260710_[0-9a-f]{6}$/)
  expect(entryId("p", "other", new Date("2026-07-10T12:00:00Z"))).not.toBe(a)
})

test("write/read/list round-trip on disk; global scope path", async () => {
  const dir = tmp()
  const e1 = entry()
  const e2 = entry({ id: "mem_20260710_ffffff", project: "global", scope: "global" })
  const p1 = await writeEntry(dir, e1)
  const p2 = await writeEntry(dir, e2)
  expect(p1).toBe(join(dir, "memories", "chip-alpha", "mem_20260710_abc123.md"))
  expect(p2).toBe(join(dir, "memories", "global", "mem_20260710_ffffff.md"))
  expect(await readEntry(p1)).toEqual(e1)
  expect(listEntryPaths(dir).sort()).toEqual([p1, p2].sort())
  expect(entryPath(dir, e1)).toBe(p1)
})

test("computeConfidence follows the spec formula with clamping", () => {
  expect(computeConfidence({ sessions: 1, humanApproved: false, contradicted: false })).toBe(0.5)
  expect(computeConfidence({ sessions: 3, humanApproved: false, contradicted: false })).toBe(0.8)
  expect(computeConfidence({ sessions: 1, humanApproved: true, contradicted: false })).toBe(0.7)
  expect(computeConfidence({ sessions: 1, humanApproved: false, contradicted: true })).toBe(0.25)
  expect(computeConfidence({ sessions: 9, humanApproved: true, contradicted: false })).toBe(0.95)
  expect(computeConfidence({ sessions: 1, humanApproved: false, contradicted: true }) >= 0.1).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test distiller/store.test.ts`
Expected: FAIL — cannot resolve `./store`.

- [ ] **Step 3: Implement**

`distiller/types.ts`: exactly the interfaces in this task's header.

`distiller/store.ts`:
```ts
import { createHash } from "node:crypto"
import { mkdir, readdir } from "node:fs/promises"
import { readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import type { EvidenceRef, MemoryClass, MemoryEntry, MemoryStatus, MemoryType, ReviewState } from "./types"

const RAW_SAFE = /^[A-Za-z0-9_./:+-]+$/

const MEMORY_TYPES: readonly MemoryType[] = ["decision", "root_cause", "pitfall", "know_how", "convention", "workflow"]
const MEMORY_CLASSES: readonly MemoryClass[] = ["episodic", "semantic", "procedural"]
const STATUSES: readonly MemoryStatus[] = ["candidate", "active", "superseded", "quarantined", "archived"]
const REVIEWS: readonly ReviewState[] = ["auto", "human_pending", "human_approved"]

const enc = (v: unknown): string => {
  if (v === null) return "null"
  if (typeof v === "string") return RAW_SAFE.test(v) ? v : JSON.stringify(v)
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
    `review: ${enc(e.review)}`,
    `evidence: ${JSON.stringify(e.evidence)}`,
    `provenance: ${JSON.stringify(e.provenance)}`,
    `created_at: ${enc(e.created_at)}`,
    `updated_at: ${enc(e.updated_at)}`,
    "---",
    "",
    e.lesson,
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
  const notesSplit = body.split(/\n## Notes\n/)
  const lesson = notesSplit[0]!.trim()
  if (!lesson) throw new Error("memory entry: empty lesson body")
  const notes = (notesSplit[1] ?? "")
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

export function computeConfidence(input: { sessions: number; humanApproved: boolean; contradicted: boolean }): number {
  const raw = 0.5 + 0.15 * (input.sessions - 1) + (input.humanApproved ? 0.2 : 0) - (input.contradicted ? 0.25 : 0)
  return Math.round(Math.min(0.95, Math.max(0.1, raw)) * 100) / 100
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test distiller/store.test.ts && bun run typecheck`
Expected: PASS (6 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add distiller/types.ts distiller/store.ts distiller/store.test.ts
git commit -m "feat(distiller): memory entry model with markdown round-trip store"
```

---

### Task 2: distiller/ledger.ts — index.db (processed-sessions ledger + FTS5 memory index)

**Files:**
- Create: `distiller/ledger.ts`
- Test: `distiller/ledger.test.ts`

**Interfaces:**
- Consumes: `MemoryEntry`, `PIPELINE_VERSION` (Task 1), `listEntryPaths`/`readEntry` (Task 1).
- Produces:
  ```ts
  export interface LedgerRow {
    session_id: string; content_hash: string; pipeline_version: string
    extractor_model: string; processed_at: string; n_candidates: number; n_committed: number
  }
  export interface SearchHit { entry: MemoryEntry; path: string; score: number }
  export class MemoryIndex {
    constructor(dbPath: string)                    // opens/creates, runs DDL idempotently
    isProcessed(sessionId: string, contentHash: string): boolean
    recordProcessed(row: Omit<LedgerRow, "pipeline_version" | "processed_at">): void
    upsertEntry(e: MemoryEntry, path: string): void
    removeEntry(id: string): void
    search(query: string, opts?: { project?: string; type?: string; status?: string; minConfidence?: number; limit?: number }): SearchHit[]
    getById(id: string): SearchHit | null          // exact metadata lookup (FTS does not index ids)
    recordAccess(id: string): void                 // access_count++, last_accessed=now
    stats(): { byStatus: Record<string, number>; byType: Record<string, number>; sessions: number }
    rebuildFrom(storeDir: string): Promise<number> // wipe memories tables, re-read all markdown; returns count
    close(): void
  }
  ```
- DDL: `processed_sessions` (PK `(session_id, content_hash, pipeline_version)`); `memories` metadata table (id PK, project, type, status, confidence, volatile, path, updated_at, access_count, last_accessed); `memories_fts` FTS5 (id UNINDEXED, title, trigger, lesson, domain). `search` joins FTS (bm25 order) with metadata filters; FTS query is sanitized: split on non-alphanumerics, drop empties, quote each token, join with ` OR `.
- `search` stores the full entry markdown path; hits re-read via `readEntry` (markdown remains the source of truth).

- [ ] **Step 1: Write the failing tests**

`distiller/ledger.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryIndex } from "./ledger"
import { writeEntry } from "./store"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-idx-"))

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: `SPEF reuse pitfall ${id}`, trigger: "after ECO route",
  project: "chip-alpha", scope: "project", domain: ["sta"],
  volatile: false, confidence: 0.5, status: "active", superseded_by: null, review: "auto",
  evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-10T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z",
  lesson: "Re-extract parasitics before STA.", notes: [],
  ...over,
})

test("ledger idempotency: isProcessed flips after recordProcessed; new hash reprocesses", () => {
  const idx = new MemoryIndex(join(tmp(), "index.db"))
  expect(idx.isProcessed("ses_1", "sha256:aa")).toBe(false)
  idx.recordProcessed({ session_id: "ses_1", content_hash: "sha256:aa", extractor_model: "fake", n_candidates: 2, n_committed: 1 })
  expect(idx.isProcessed("ses_1", "sha256:aa")).toBe(true)
  expect(idx.isProcessed("ses_1", "sha256:bb")).toBe(false)
  idx.close()
})

test("upsert + search with filters and bm25 relevance", async () => {
  const dir = tmp()
  const idx = new MemoryIndex(join(dir, "index.db"))
  const e1 = entry("mem_1", { lesson: "Re-extract SPEF parasitics before STA after ECO." })
  const e2 = entry("mem_2", { type: "know_how", title: "Innovus flow tip", lesson: "Use -no_html for faster reports.", domain: ["innovus"] })
  const e3 = entry("mem_3", { status: "superseded", lesson: "Old SPEF advice." })
  const e4 = entry("mem_4", { confidence: 0.3, lesson: "Tentative SPEF hunch." })
  for (const e of [e1, e2, e3, e4]) idx.upsertEntry(e, await writeEntry(join(dir, "store"), e))

  const hits = idx.search("SPEF parasitics", { status: "active", minConfidence: 0.5 })
  expect(hits.map((h) => h.entry.id)).toEqual(["mem_1"]) // superseded + low-confidence excluded
  expect(idx.search("SPEF", {}).length).toBeGreaterThanOrEqual(3) // no filters sees all
  expect(idx.search("innovus reports", { type: "know_how" })[0]!.entry.id).toBe("mem_2")
  idx.close()
})

test("upsertEntry is an update, not a duplicate; removeEntry removes", async () => {
  const dir = tmp()
  const idx = new MemoryIndex(join(dir, "index.db"))
  const e = entry("mem_1")
  const p = await writeEntry(join(dir, "store"), e)
  idx.upsertEntry(e, p)
  idx.upsertEntry({ ...e, lesson: "Updated lesson about SPEF." }, p)
  const hits = idx.search("SPEF")
  expect(hits.filter((h) => h.entry.id === "mem_1").length).toBe(1)
  expect(idx.getById("mem_1")!.entry.lesson).toBe("Updated lesson about SPEF.")
  expect(idx.getById("mem_nope")).toBeNull()
  idx.removeEntry("mem_1")
  expect(idx.search("SPEF").length).toBe(0)
  expect(idx.getById("mem_1")).toBeNull()
  idx.close()
})

test("search query with FTS metacharacters does not throw", () => {
  const idx = new MemoryIndex(join(tmp(), "index.db"))
  expect(() => idx.search('AND OR NOT "quoted" (paren) col:x *')).not.toThrow()
  idx.close()
})

test("recordAccess bumps counters; stats aggregates; rebuildFrom restores index", async () => {
  const dir = tmp()
  const store = join(dir, "store")
  const idx = new MemoryIndex(join(dir, "index.db"))
  for (const e of [entry("mem_1"), entry("mem_2", { type: "know_how" }), entry("mem_3", { status: "quarantined" })])
    idx.upsertEntry(e, await writeEntry(store, e))
  idx.recordProcessed({ session_id: "s", content_hash: "h", extractor_model: "f", n_candidates: 0, n_committed: 0 })
  idx.recordAccess("mem_1")
  const s = idx.stats()
  expect(s.byStatus.active).toBe(2)
  expect(s.byStatus.quarantined).toBe(1)
  expect(s.byType.pitfall).toBe(2)
  expect(s.sessions).toBe(1)

  const n = await idx.rebuildFrom(store)
  expect(n).toBe(3)
  expect(idx.search("SPEF", {}).length).toBe(3)
  expect(idx.stats().sessions).toBe(1) // ledger survives rebuild
  idx.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test distiller/ledger.test.ts`
Expected: FAIL — cannot resolve `./ledger`.

- [ ] **Step 3: Implement**

`distiller/ledger.ts`:
```ts
import { Database } from "bun:sqlite"
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

// NOTE: import { readFileSync } from "node:fs" at the top of the file — used by
// search() and getById() to re-read canonical markdown (no require() calls).

export class MemoryIndex {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
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
      `INSERT OR REPLACE INTO memories (id, project, type, status, confidence, volatile, path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

  stats(): { byStatus: Record<string, number>; byType: Record<string, number>; sessions: number } {
    const byStatus: Record<string, number> = {}
    for (const r of this.db.query(`SELECT status, COUNT(*) AS n FROM memories GROUP BY status`).all() as Array<{ status: string; n: number }>)
      byStatus[r.status] = r.n
    const byType: Record<string, number> = {}
    for (const r of this.db.query(`SELECT type, COUNT(*) AS n FROM memories GROUP BY type`).all() as Array<{ type: string; n: number }>)
      byType[r.type] = r.n
    const sessions = (this.db.query(`SELECT COUNT(*) AS n FROM processed_sessions`).get() as { n: number }).n
    return { byStatus, byType, sessions }
  }

  async rebuildFrom(storeDir: string): Promise<number> {
    this.db.run(`DELETE FROM memories`)
    this.db.run(`DELETE FROM memories_fts`)
    let count = 0
    for (const path of listEntryPaths(storeDir)) {
      const entry = parseEntry(await Bun.file(path).text())
      this.upsertEntry(entry, path)
      count++
    }
    return count
  }

  close(): void {
    this.db.close()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test distiller/ledger.test.ts && bun run typecheck`
Expected: PASS (5 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add distiller/ledger.ts distiller/ledger.test.ts
git commit -m "feat(distiller): sqlite ledger and fts5 memory index"
```

---

### Task 3: distiller/transcripts.ts — spool scanning and transcript parsing

**Files:**
- Create: `distiller/transcripts.ts`
- Test: `distiller/transcripts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TranscriptMeta {
    path: string; sessionId: string; project: string   // project = spool subdirectory name
    contentHash: string; timeEnd: string; exportedAt: string
    title: string; body: string                        // body = markdown after frontmatter
  }
  export function parseTranscript(path: string, markdown: string): TranscriptMeta   // throws on missing fields
  export function scanSpool(transcriptsDir: string): TranscriptMeta[]               // recursive, sorted by timeEnd
  export function isEligible(meta: TranscriptMeta, now: Date, idleHours: number): boolean
  export function anchorsIn(body: string): Set<string>                              // all {#msg_id} anchors
  ```
- `isEligible`: `now - timeEnd >= idleHours * 3600_000`.
- Frontmatter values may be raw or JSON-quoted (collector escapes non-safe values) — reuse the same parse rule as the store.

- [ ] **Step 1: Write the failing tests**

`distiller/transcripts.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { anchorsIn, isEligible, parseTranscript, scanSpool } from "./transcripts"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-ts-"))

const sample = (sessionId: string, timeEnd: string) => `---
session_id: ${sessionId}
project_dir: "/x/projA"
title: "Fix \\"quoted\\" thing"
model: "opencode/big-pickle"
time_start: 2026-07-10T02:00:00.000Z
time_end: ${timeEnd}
turns: 2
tokens: { input: 10, output: 5 }
content_hash: sha256:abcdef0123456789
exported_at: 2026-07-10T03:00:00.000Z
---
## T1 [02:00] User {#msg_u1}

please fix the thing

## T2 [02:01] Assistant {#msg_a1}

fixed it
`

test("parseTranscript extracts meta and body; unquotes title", () => {
  const md = sample("ses_p", "2026-07-10T02:30:00.000Z")
  const m = parseTranscript("/spool/proja/ses_p.md", md)
  expect(m.sessionId).toBe("ses_p")
  expect(m.project).toBe("proja")
  expect(m.contentHash).toBe("sha256:abcdef0123456789")
  expect(m.timeEnd).toBe("2026-07-10T02:30:00.000Z")
  expect(m.title).toBe('Fix "quoted" thing')
  expect(m.body).toContain("## T1")
  expect(m.body).not.toContain("content_hash")
})

test("parseTranscript throws on missing session_id", () => {
  const md = sample("ses_p", "2026-07-10T02:30:00.000Z").replace(/^session_id: .*$/m, "")
  expect(() => parseTranscript("/spool/p/x.md", md)).toThrow(/session_id/)
})

test("scanSpool walks project dirs and sorts by timeEnd", () => {
  const dir = tmp()
  mkdirSync(join(dir, "proja"), { recursive: true })
  mkdirSync(join(dir, "projb"), { recursive: true })
  writeFileSync(join(dir, "proja", "ses_2.md"), sample("ses_2", "2026-07-10T05:00:00.000Z"))
  writeFileSync(join(dir, "projb", "ses_1.md"), sample("ses_1", "2026-07-10T01:00:00.000Z"))
  writeFileSync(join(dir, "proja", "junk.txt"), "not a transcript")
  const metas = scanSpool(dir)
  expect(metas.map((m) => m.sessionId)).toEqual(["ses_1", "ses_2"])
  expect(metas[0]!.project).toBe("projb")
})

test("scanSpool skips unparseable transcripts instead of throwing", () => {
  const dir = tmp()
  mkdirSync(join(dir, "proja"), { recursive: true })
  writeFileSync(join(dir, "proja", "bad.md"), "no frontmatter here")
  writeFileSync(join(dir, "proja", "ok.md"), sample("ses_ok", "2026-07-10T01:00:00.000Z"))
  expect(scanSpool(dir).map((m) => m.sessionId)).toEqual(["ses_ok"])
})

test("isEligible respects idle window", () => {
  const m = parseTranscript("/s/p/x.md", sample("s", "2026-07-10T00:00:00.000Z"))
  expect(isEligible(m, new Date("2026-07-10T07:00:00.000Z"), 6)).toBe(true)
  expect(isEligible(m, new Date("2026-07-10T03:00:00.000Z"), 6)).toBe(false)
})

test("anchorsIn finds every heading anchor", () => {
  const m = parseTranscript("/s/p/x.md", sample("s", "2026-07-10T00:00:00.000Z"))
  expect(anchorsIn(m.body)).toEqual(new Set(["msg_u1", "msg_a1"]))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test distiller/transcripts.test.ts`
Expected: FAIL — cannot resolve `./transcripts`.

- [ ] **Step 3: Implement**

`distiller/transcripts.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test distiller/transcripts.test.ts && bun run typecheck`
Expected: PASS (6 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add distiller/transcripts.ts distiller/transcripts.test.ts
git commit -m "feat(distiller): transcript spool scanning and parsing"
```

---

### Task 4: distiller/llm.ts — LlmClient with vLLM and opencode-run backends

**Files:**
- Create: `distiller/llm.ts`
- Test: `distiller/llm.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LlmRequest { system?: string; prompt: string; schema?: Record<string, unknown> }
  export interface LlmClient { complete(req: LlmRequest): Promise<string>; describe(): string }
  export function createVllmClient(cfg: { url: string; model: string; apiKey?: string; fetchImpl?: typeof fetch }): LlmClient
  export type SpawnResult = { exitCode: number; stdout: string; stderr: string }
  export type SpawnFn = (argv: string[]) => Promise<SpawnResult>
  export function createOpencodeRunClient(opts?: { spawn?: SpawnFn }): LlmClient
  export function clientFromEnv(env?: Record<string, string | undefined>): LlmClient
  ```
- vLLM: POST `<url>/chat/completions` (url is the OpenAI-compatible base, e.g. `http://host:8000/v1`), body `{ model, messages, temperature: 0 }` + `response_format: { type: "json_schema", json_schema: { name: "output", schema } }` when `schema` given; `Authorization: Bearer <apiKey>` when set. Non-2xx or missing `choices[0].message.content` → throw with status + body snippet (≤300 chars). `describe()` → `vllm/<model>`.
- opencode-run: argv `["opencode", "run", <system + "\n\n" + prompt>, "--pure", "--title", "distiller"]` — **message BEFORE flags** (Spike A trap). `schema` is appended to the prompt as an instruction ("Reply with ONLY JSON matching this schema: …") since the CLI has no structured-output flag. Non-zero exit → throw with stderr tail. `describe()` → `opencode-run`.
- `clientFromEnv`: `AGENT_MEMORY_LLM=vllm` requires `AGENT_MEMORY_VLLM_URL` + `AGENT_MEMORY_VLLM_MODEL` (throw a descriptive error if missing); anything else (incl. unset) → opencode-run client.

- [ ] **Step 1: Write the failing tests**

`distiller/llm.test.ts`:
```ts
import { expect, test } from "bun:test"
import { clientFromEnv, createOpencodeRunClient, createVllmClient } from "./llm"

test("vllm client posts OpenAI-compatible request and returns content", async () => {
  const seen: { url?: string; body?: Record<string, unknown>; auth?: string | null } = {}
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(url)
    seen.body = JSON.parse(String(init?.body))
    seen.auth = new Headers(init?.headers).get("authorization")
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })
  }) as typeof fetch
  const client = createVllmClient({ url: "http://v:8000/v1", model: "qwen3", apiKey: "k1", fetchImpl })
  const out = await client.complete({ system: "sys", prompt: "hi", schema: { type: "object" } })
  expect(out).toBe('{"ok":true}')
  expect(seen.url).toBe("http://v:8000/v1/chat/completions")
  expect(seen.auth).toBe("Bearer k1")
  const body = seen.body as Record<string, unknown>
  expect(body.model).toBe("qwen3")
  expect(body.temperature).toBe(0)
  expect((body.messages as unknown[]).length).toBe(2)
  expect((body.response_format as { type: string }).type).toBe("json_schema")
  expect(client.describe()).toBe("vllm/qwen3")
})

test("vllm client throws with status and body snippet on non-2xx", async () => {
  const fetchImpl = (async () => new Response("model not found", { status: 404 })) as typeof fetch
  const client = createVllmClient({ url: "http://v:8000/v1", model: "x", fetchImpl })
  await expect(client.complete({ prompt: "hi" })).rejects.toThrow(/404.*model not found/s)
})

test("opencode-run client puts message before flags and joins system+prompt", async () => {
  let argv: string[] = []
  const client = createOpencodeRunClient({
    spawn: async (a) => {
      argv = a
      return { exitCode: 0, stdout: "reply text\n", stderr: "" }
    },
  })
  const out = await client.complete({ system: "SYS", prompt: "PROMPT", schema: { type: "array" } })
  expect(out).toBe("reply text")
  expect(argv[0]).toBe("opencode")
  expect(argv[1]).toBe("run")
  expect(argv[2]).toContain("SYS")
  expect(argv[2]).toContain("PROMPT")
  expect(argv[2]).toContain('"type": "array"')
  expect(argv.indexOf("--pure")).toBeGreaterThan(2) // message strictly before flags
})

test("opencode-run client throws with stderr tail on failure", async () => {
  const client = createOpencodeRunClient({
    spawn: async () => ({ exitCode: 1, stdout: "", stderr: "boom detail" }),
  })
  await expect(client.complete({ prompt: "x" })).rejects.toThrow(/boom detail/)
})

test("clientFromEnv selects backend and validates vllm config", () => {
  expect(clientFromEnv({}).describe()).toBe("opencode-run")
  expect(clientFromEnv({ AGENT_MEMORY_LLM: "vllm", AGENT_MEMORY_VLLM_URL: "http://v/v1", AGENT_MEMORY_VLLM_MODEL: "m" }).describe()).toBe("vllm/m")
  expect(() => clientFromEnv({ AGENT_MEMORY_LLM: "vllm" })).toThrow(/AGENT_MEMORY_VLLM_URL/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test distiller/llm.test.ts`
Expected: FAIL — cannot resolve `./llm`.

- [ ] **Step 3: Implement**

`distiller/llm.ts`:
```ts
export interface LlmRequest { system?: string; prompt: string; schema?: Record<string, unknown> }
export interface LlmClient { complete(req: LlmRequest): Promise<string>; describe(): string }

export function createVllmClient(cfg: {
  url: string; model: string; apiKey?: string; fetchImpl?: typeof fetch
}): LlmClient {
  const doFetch = cfg.fetchImpl ?? fetch
  return {
    describe: () => `vllm/${cfg.model}`,
    async complete(req) {
      const messages: Array<{ role: string; content: string }> = []
      if (req.system) messages.push({ role: "system", content: req.system })
      messages.push({ role: "user", content: req.prompt })
      const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0 }
      if (req.schema) body.response_format = { type: "json_schema", json_schema: { name: "output", schema: req.schema } }
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
      const res = await doFetch(`${cfg.url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`vllm request failed: ${res.status} ${text.slice(0, 300)}`)
      let content: unknown
      try {
        content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
      } catch {
        throw new Error(`vllm returned non-JSON body: ${text.slice(0, 300)}`)
      }
      if (typeof content !== "string" || !content) throw new Error(`vllm response missing message content: ${text.slice(0, 300)}`)
      return content
    },
  }
}

export type SpawnResult = { exitCode: number; stdout: string; stderr: string }
export type SpawnFn = (argv: string[]) => Promise<SpawnResult>

const bunSpawn: SpawnFn = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

export function createOpencodeRunClient(opts: { spawn?: SpawnFn } = {}): LlmClient {
  const spawn = opts.spawn ?? bunSpawn
  return {
    describe: () => "opencode-run",
    async complete(req) {
      let message = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt
      if (req.schema)
        message += `\n\nReply with ONLY JSON matching this schema — no prose, no code fences:\n${JSON.stringify(req.schema, null, 2)}`
      // Message argument MUST come before flags: `opencode run` declares -f/--file
      // etc. as yargs array flags that greedily swallow following positionals.
      const res = await spawn(["opencode", "run", message, "--pure", "--title", "distiller"])
      if (res.exitCode !== 0) throw new Error(`opencode run failed (exit ${res.exitCode}): ${res.stderr.slice(-300)}`)
      return res.stdout.trim()
    },
  }
}

export function clientFromEnv(env: Record<string, string | undefined> = process.env): LlmClient {
  if (env.AGENT_MEMORY_LLM === "vllm") {
    const url = env.AGENT_MEMORY_VLLM_URL
    const model = env.AGENT_MEMORY_VLLM_MODEL
    if (!url) throw new Error("AGENT_MEMORY_VLLM_URL is required when AGENT_MEMORY_LLM=vllm")
    if (!model) throw new Error("AGENT_MEMORY_VLLM_MODEL is required when AGENT_MEMORY_LLM=vllm")
    return createVllmClient({ url, model, apiKey: env.AGENT_MEMORY_VLLM_KEY })
  }
  return createOpencodeRunClient()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test distiller/llm.test.ts && bun run typecheck`
Expected: PASS (5 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add distiller/llm.ts distiller/llm.test.ts
git commit -m "feat(distiller): llm client with vllm and opencode-run backends"
```

---

### Task 5: distiller/extract.ts — extraction prompt, parsing, deterministic validation

**Files:**
- Create: `distiller/extract.ts`
- Test: `distiller/extract.test.ts`

**Interfaces:**
- Consumes: `TranscriptMeta`, `anchorsIn` (Task 3); `MemoryType` (Task 1).
- Produces:
  ```ts
  export interface Candidate {
    type: MemoryType; title: string; trigger: string; lesson: string
    domain: string[]; evidence: Array<{ message_id: string }>
    salience: number; volatile: boolean
  }
  export const EXTRACT_SCHEMA: Record<string, unknown>   // JSON schema of Candidate[]
  export function buildExtractPrompt(meta: TranscriptMeta): { system: string; prompt: string; promptHash: string }
  export function stripFences(raw: string): string
  export interface ValidationResult {
    valid: Candidate[]
    rejected: Array<{ item: unknown; reasons: string[] }>
    secrets: Array<{ item: Candidate; matches: string[] }>
  }
  export function validateCandidates(raw: string, meta: TranscriptMeta, salienceMin: number): ValidationResult
  export function scanSecrets(text: string): string[]
  ```
- `buildExtractPrompt`: system = the distiller role + 6-type taxonomy + rules (adapted from `spikes/extract-prompt.txt`, which passed Spike A: atomic, self-contained, imperative lesson ≤80 words, salience 0-10 emit ≥ salienceMin, volatile flag, evidence must cite `{#msg_id}` anchors, extract contrast for failed-then-fixed arcs, do NOT extract file contents/boilerplate/secrets); prompt = `Transcript:\n\n` + meta.body. `promptHash` = `sha256:` + sha256(system).slice(0,16) — system only, so per-transcript prompts don't churn the hash.
- `validateCandidates` (deterministic, no LLM): parse via `stripFences` + JSON.parse (throw on unparseable — caller counts as error); must be an array; per item check: type ∈ 6 types; title/trigger/lesson non-empty strings; lesson ≤ 80 words; domain non-empty string array; evidence non-empty, every `message_id` ∈ `anchorsIn(meta.body)` (reason `hallucinated evidence anchor: <id>` otherwise); salience number — items with salience < salienceMin are silently dropped (not "rejected"); volatile boolean. Items failing any check → `rejected` with all reasons. Valid items whose `title + trigger + lesson` hits `scanSecrets` → `secrets` bucket.
- `scanSecrets` patterns: `-----BEGIN [A-Z ]*PRIVATE KEY-----`; `AKIA[0-9A-Z]{16}`; `(sk|ghp|gho|xox[bpas])[-_][A-Za-z0-9]{16,}`; generic high-entropy token: any whitespace-delimited token ≥ 32 chars containing at least three of {lower, upper, digit, symbol}. Returns matched pattern labels.

- [ ] **Step 1: Write the failing tests**

`distiller/extract.test.ts`:
```ts
import { expect, test } from "bun:test"
import { buildExtractPrompt, scanSecrets, stripFences, validateCandidates } from "./extract"
import type { TranscriptMeta } from "./transcripts"

const meta: TranscriptMeta = {
  path: "/s/proja/ses_1.md", sessionId: "ses_1", project: "proja",
  contentHash: "sha256:aa", timeEnd: "2026-07-10T00:00:00.000Z", exportedAt: "2026-07-10T01:00:00.000Z",
  title: "t",
  body: "## T1 [00:00] User {#msg_u1}\n\nhow to fix X\n\n## T2 [00:01] Assistant {#msg_a1}\n\nuse Y\n",
}

const cand = (over: Record<string, unknown> = {}) => ({
  type: "know_how", title: "Fix X with Y", trigger: "when X fails",
  lesson: "Use Y because Z.", domain: ["tooling"],
  evidence: [{ message_id: "msg_a1" }], salience: 7, volatile: false,
  ...over,
})

test("buildExtractPrompt embeds taxonomy, rules, and transcript; stable promptHash", () => {
  const a = buildExtractPrompt(meta)
  const b = buildExtractPrompt({ ...meta, body: "## T1 [00:00] User {#msg_z}\n\ndifferent\n" })
  expect(a.system).toContain("root_cause")
  expect(a.system).toContain("salience")
  expect(a.prompt).toContain("how to fix X")
  expect(a.promptHash).toBe(b.promptHash) // hash covers the template, not the transcript
  expect(a.promptHash).toMatch(/^sha256:[0-9a-f]{16}$/)
})

test("stripFences removes markdown code fences", () => {
  expect(stripFences('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]')
  expect(stripFences('[1]')).toBe("[1]")
})

test("valid candidate passes; hallucinated anchor rejected with reason", () => {
  const r = validateCandidates(JSON.stringify([cand(), cand({ evidence: [{ message_id: "msg_FAKE" }] })]), meta, 6)
  expect(r.valid.length).toBe(1)
  expect(r.rejected.length).toBe(1)
  expect(r.rejected[0]!.reasons.join()).toContain("hallucinated evidence anchor: msg_FAKE")
})

test("field violations collect ALL reasons; below-salience silently dropped", () => {
  const bad = cand({ type: "vibes", lesson: Array(100).fill("word").join(" "), domain: [] })
  const low = cand({ salience: 3 })
  const r = validateCandidates(JSON.stringify([bad, low]), meta, 6)
  expect(r.valid.length).toBe(0)
  expect(r.rejected.length).toBe(1)
  const reasons = r.rejected[0]!.reasons.join("; ")
  expect(reasons).toContain("type")
  expect(reasons).toContain("lesson")
  expect(reasons).toContain("domain")
})

test("unparseable output throws; non-array throws", () => {
  expect(() => validateCandidates("not json at all {", meta, 6)).toThrow()
  expect(() => validateCandidates('{"a":1}', meta, 6)).toThrow(/array/)
})

test("secret-bearing candidates are diverted to the secrets bucket", () => {
  const leaky = cand({ lesson: "Set key AKIA0123456789ABCDEF before running." })
  const r = validateCandidates(JSON.stringify([leaky]), meta, 6)
  expect(r.valid.length).toBe(0)
  expect(r.secrets.length).toBe(1)
  expect(r.secrets[0]!.matches.length).toBeGreaterThan(0)
})

test("scanSecrets catches PEM, AWS keys, token prefixes, high-entropy blobs; clean text passes", () => {
  expect(scanSecrets("-----BEGIN RSA PRIVATE KEY-----")).not.toEqual([])
  expect(scanSecrets("ghp_abcdEFGH0123456789ijkl")).not.toEqual([])
  expect(scanSecrets("aB3$" + "xY9#".repeat(10))).not.toEqual([])
  expect(scanSecrets("re-extract parasitics before running STA")).toEqual([])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test distiller/extract.test.ts`
Expected: FAIL — cannot resolve `./extract`.

- [ ] **Step 3: Implement**

`distiller/extract.ts`:
```ts
import { createHash } from "node:crypto"
import { anchorsIn, type TranscriptMeta } from "./transcripts"
import type { MemoryType } from "./types"

export interface Candidate {
  type: MemoryType; title: string; trigger: string; lesson: string
  domain: string[]; evidence: Array<{ message_id: string }>
  salience: number; volatile: boolean
}

const TYPES: readonly string[] = ["decision", "root_cause", "pitfall", "know_how", "convention", "workflow"]

export const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: [...TYPES] },
      title: { type: "string" },
      trigger: { type: "string" },
      lesson: { type: "string" },
      domain: { type: "array", items: { type: "string" }, minItems: 1 },
      evidence: { type: "array", items: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] }, minItems: 1 },
      salience: { type: "number" },
      volatile: { type: "boolean" },
    },
    required: ["type", "title", "trigger", "lesson", "domain", "evidence", "salience", "volatile"],
  },
}

const SYSTEM = `You are a knowledge distiller for an engineering team. Read the AI-coding-agent session transcript and extract ONLY durable engineering knowledge a colleague would want six months from now.

Extract items of these types:
- decision: a technical choice plus the rationale (especially user overrides of the agent)
- root_cause: error/symptom -> underlying cause -> verified fix
- pitfall: something that looks right but fails, and why
- know_how: domain/tool knowledge (EDA flows, frameworks, scripts, flags)
- convention: a team/project preference the user enforced or repeated
- workflow: a multi-step procedure that was executed successfully and is reusable

Do NOT extract: file contents, boilerplate, transient task details, anything true only for this one task, secrets/credentials, or knowledge obvious from public documentation.

Rules:
- Each item must be atomic (one lesson) and self-contained (understandable without the transcript).
- evidence must cite the {#msg_id} anchors from the transcript headings.
- Write "lesson" as an imperative or conditional ("When X, do Y because Z"), at most 80 words.
- Score salience 0-10; emit only items scoring at or above the threshold given below.
- If the session contains a failed attempt later corrected, extract the CONTRAST (what was wrong, what fixed it), not the failure alone.
- Mark volatile=true if the fact can go stale (tool versions, current bugs, WIP state).

Output STRICT JSON only — an array of items, no prose, no markdown fences. If nothing qualifies, output [].`

export function buildExtractPrompt(meta: TranscriptMeta): { system: string; prompt: string; promptHash: string } {
  const promptHash = "sha256:" + createHash("sha256").update(SYSTEM).digest("hex").slice(0, 16)
  return { system: SYSTEM, prompt: `Transcript:\n\n${meta.body}`, promptHash }
}

export function stripFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim()
}

const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { label: "token-prefix", re: /\b(?:sk|ghp|gho|xox[bpas])[-_][A-Za-z0-9]{16,}\b/ },
]

export function scanSecrets(text: string): string[] {
  const matches: string[] = []
  for (const { label, re } of SECRET_PATTERNS) if (re.test(text)) matches.push(label)
  for (const token of text.split(/\s+/)) {
    if (token.length < 32) continue
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(token)).length
    if (classes >= 3) {
      matches.push("high-entropy-token")
      break
    }
  }
  return matches
}

export interface ValidationResult {
  valid: Candidate[]
  rejected: Array<{ item: unknown; reasons: string[] }>
  secrets: Array<{ item: Candidate; matches: string[] }>
}

export function validateCandidates(raw: string, meta: TranscriptMeta, salienceMin: number): ValidationResult {
  const parsed: unknown = JSON.parse(stripFences(raw))
  if (!Array.isArray(parsed)) throw new Error("extraction output is not a JSON array")
  const anchors = anchorsIn(meta.body)
  const result: ValidationResult = { valid: [], rejected: [], secrets: [] }

  for (const item of parsed) {
    const reasons: string[] = []
    const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>
    if (typeof o.salience === "number" && o.salience < salienceMin) continue // below threshold: drop silently

    if (typeof o.type !== "string" || !TYPES.includes(o.type)) reasons.push(`invalid type "${String(o.type)}"`)
    for (const key of ["title", "trigger", "lesson"] as const)
      if (typeof o[key] !== "string" || (o[key] as string).trim() === "") reasons.push(`${key} must be a non-empty string`)
    if (typeof o.lesson === "string" && o.lesson.split(/\s+/).length > 80) reasons.push("lesson exceeds 80 words")
    if (!Array.isArray(o.domain) || o.domain.length === 0 || !o.domain.every((d) => typeof d === "string" && d))
      reasons.push("domain must be a non-empty string array")
    if (!Array.isArray(o.evidence) || o.evidence.length === 0) reasons.push("evidence must be a non-empty array")
    else
      for (const ev of o.evidence) {
        const id = (ev as { message_id?: unknown }).message_id
        if (typeof id !== "string") reasons.push("evidence item missing message_id")
        else if (!anchors.has(id)) reasons.push(`hallucinated evidence anchor: ${id}`)
      }
    if (typeof o.salience !== "number") reasons.push("salience must be a number")
    if (typeof o.volatile !== "boolean") reasons.push("volatile must be a boolean")

    if (reasons.length > 0) {
      result.rejected.push({ item, reasons })
      continue
    }
    const candidate = o as unknown as Candidate
    const secretMatches = scanSecrets(`${candidate.title} ${candidate.trigger} ${candidate.lesson}`)
    if (secretMatches.length > 0) result.secrets.push({ item: candidate, matches: secretMatches })
    else result.valid.push(candidate)
  }
  return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test distiller/extract.test.ts && bun run typecheck`
Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add distiller/extract.ts distiller/extract.test.ts
git commit -m "feat(distiller): extraction prompt and deterministic candidate validation"
```

---

### Task 6: distiller/reconcile.ts — Mem0 loop (ADD / UPDATE / SUPERSEDE / NOOP)

**Files:**
- Create: `distiller/reconcile.ts`
- Test: `distiller/reconcile.test.ts`

**Interfaces:**
- Consumes: `Candidate` (Task 5), `MemoryIndex`/`SearchHit` (Task 2), store fns (Task 1), `LlmClient` (Task 4), `TranscriptMeta` (Task 3).
- Produces:
  ```ts
  export type ReconcileOp =
    | { op: "ADD" }
    | { op: "NOOP"; target_id: string; reason: string }
    | { op: "UPDATE"; target_id: string; note: string }
    | { op: "SUPERSEDE"; target_id: string; reason: string }
  export const RECONCILE_SCHEMA: Record<string, unknown>
  export function buildReconcilePrompt(c: Candidate, neighbors: Array<{ id: string; title: string; trigger: string; lesson: string }>): { system: string; prompt: string }
  export function parseReconcileOp(raw: string, neighborIds: string[]): ReconcileOp   // throws on invalid op / unknown target
  export interface ReconcileDeps { llm: LlmClient; index: MemoryIndex; storeDir: string; now: Date; extractorLabel: string; promptHash: string }
  export async function reconcileCandidate(c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps):
    Promise<{ op: ReconcileOp["op"]; entry?: MemoryEntry }>
  ```
- `reconcileCandidate` flow:
  1. `neighbors = deps.index.search(\`${c.title} ${c.lesson}\`, { status: "active", limit: 5 })` (no project filter — cross-project accretion enables later promotion).
  2. No neighbors → op ADD (skip the LLM call entirely).
  3. Else LLM with RECONCILE_SCHEMA → `parseReconcileOp` (target must be a neighbor id).
  4. Apply:
     - **ADD**: new entry — `entryId(meta.project, c.title, now)`, `memory_class`: `workflow` → `procedural`, else `semantic`; scope `project`; project `meta.project`; confidence `computeConfidence({sessions:1,...})`; status `active`; review `auto`; evidence `[{ session: meta.sessionId, anchors: c.evidence.map(e => e.message_id), observed_at: meta.timeEnd }]`; provenance `{ extractor: deps.extractorLabel, prompt_hash: deps.promptHash }`; created/updated = now ISO; lesson `c.lesson`; notes `[]`. `writeEntry` + `upsertEntry`.
     - **UPDATE**: read target entry; if `meta.sessionId` not already in evidence, push evidence row; push note `<now date>: <note> (<sessionId>)`; recompute confidence from distinct evidence sessions (`computeConfidence({ sessions: distinct, humanApproved: review === "human_approved", contradicted: false })`); if target.project !== meta.project and scope is `project`, also push note `promotion candidate: seen in <meta.project>`; update `updated_at`; write + upsert.
     - **SUPERSEDE**: create the new entry as in ADD; mark old: `status: "superseded"`, `superseded_by: <new id>`, note `<date>: superseded by <new id> — <reason>`, `updated_at`; write + upsert both.
     - **NOOP**: nothing written.
  - ID collision on ADD/SUPERSEDE (same project+title same day): append note to EXISTING entry instead (treat as UPDATE with note "re-extracted"), do not overwrite blindly.

- [ ] **Step 1: Write the failing tests**

`distiller/reconcile.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmClient } from "./llm"
import { MemoryIndex } from "./ledger"
import { parseReconcileOp, reconcileCandidate } from "./reconcile"
import { readEntry, writeEntry } from "./store"
import type { Candidate } from "./extract"
import type { TranscriptMeta } from "./transcripts"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-rec-"))

const meta: TranscriptMeta = {
  path: "/s/proja/ses_2.md", sessionId: "ses_2", project: "proja",
  contentHash: "sha256:bb", timeEnd: "2026-07-11T00:00:00.000Z", exportedAt: "2026-07-11T01:00:00.000Z",
  title: "t", body: "## T1 [00:00] User {#msg_1}\n\nx\n",
}

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  type: "pitfall", title: "SPEF reuse after ECO", trigger: "after ECO route",
  lesson: "Re-extract parasitics before STA.", domain: ["sta"],
  evidence: [{ message_id: "msg_1" }], salience: 7, volatile: false,
  ...over,
})

const existing = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: "SPEF reuse after ECO", trigger: "after ECO route",
  project: "proja", scope: "project", domain: ["sta"],
  volatile: false, confidence: 0.5, status: "active", superseded_by: null, review: "auto",
  evidence: [{ session: "ses_1", anchors: ["msg_a"], observed_at: "2026-07-10T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z",
  lesson: "Re-extract parasitics before STA.", notes: [],
  ...over,
})

const fakeLlm = (reply: string): LlmClient => ({ describe: () => "fake", complete: async () => reply })

const setup = async (seed?: MemoryEntry) => {
  const dir = tmp()
  const storeDir = join(dir, "store")
  const index = new MemoryIndex(join(storeDir, "index.db"))
  if (seed) index.upsertEntry(seed, await writeEntry(storeDir, seed))
  return { storeDir, index }
}

const deps = (o: { llm: LlmClient; index: MemoryIndex; storeDir: string }) => ({
  ...o, now: new Date("2026-07-11T02:00:00.000Z"), extractorLabel: "distiller v0.1 / fake", promptHash: "sha256:pp",
})

test("parseReconcileOp validates op and target membership", () => {
  expect(parseReconcileOp('{"op":"ADD"}', ["m1"])) .toEqual({ op: "ADD" })
  expect(parseReconcileOp('{"op":"UPDATE","target_id":"m1","note":"n"}', ["m1"]).op).toBe("UPDATE")
  expect(() => parseReconcileOp('{"op":"UPDATE","target_id":"mX","note":"n"}', ["m1"])).toThrow(/target/)
  expect(() => parseReconcileOp('{"op":"YOLO"}', [])).toThrow(/op/)
  expect(() => parseReconcileOp("garbage", [])).toThrow()
})

test("no neighbors -> ADD without any LLM call", async () => {
  const { storeDir, index } = await setup()
  let called = 0
  const llm: LlmClient = { describe: () => "f", complete: async () => { called++; return '{"op":"ADD"}' } }
  const r = await reconcileCandidate(cand(), meta, deps({ llm, index, storeDir }))
  expect(r.op).toBe("ADD")
  expect(called).toBe(0)
  expect(r.entry!.confidence).toBe(0.5)
  expect(r.entry!.evidence[0]!.session).toBe("ses_2")
  expect(index.search("SPEF").length).toBe(1)
  const onDisk = await readEntry(index.search("SPEF")[0]!.path)
  expect(onDisk.id).toBe(r.entry!.id)
})

test("UPDATE appends evidence + note and raises confidence", async () => {
  const seed = existing("mem_20260710_aaaaaa")
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand(), meta,
    deps({ llm: fakeLlm('{"op":"UPDATE","target_id":"mem_20260710_aaaaaa","note":"confirmed again"}'), index, storeDir }),
  )
  expect(r.op).toBe("UPDATE")
  expect(r.entry!.evidence.length).toBe(2)
  expect(r.entry!.confidence).toBe(0.65)
  expect(r.entry!.notes.some((n) => n.includes("confirmed again"))).toBe(true)
  expect(r.entry!.updated_at).toBe("2026-07-11T02:00:00.000Z")
})

test("UPDATE from another project flags promotion candidate", async () => {
  const seed = existing("mem_20260710_aaaaaa", { project: "projb" })
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand(), meta,
    deps({ llm: fakeLlm('{"op":"UPDATE","target_id":"mem_20260710_aaaaaa","note":"n"}'), index, storeDir }),
  )
  expect(r.entry!.notes.some((n) => n.includes("promotion candidate"))).toBe(true)
})

test("SUPERSEDE creates new entry and tombstones the old one", async () => {
  const seed = existing("mem_20260710_aaaaaa", { lesson: "Old wrong advice." })
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand({ lesson: "New corrected advice." }), meta,
    deps({ llm: fakeLlm('{"op":"SUPERSEDE","target_id":"mem_20260710_aaaaaa","reason":"flow changed"}'), index, storeDir }),
  )
  expect(r.op).toBe("SUPERSEDE")
  const old = index.search("SPEF", { status: "superseded" })
  expect(old.length).toBe(1)
  expect(old[0]!.entry.superseded_by).toBe(r.entry!.id)
  expect(old[0]!.entry.notes.some((n) => n.includes("flow changed"))).toBe(true)
  const active = index.search("SPEF", { status: "active" })
  expect(active.length).toBe(1)
  expect(active[0]!.entry.lesson).toBe("New corrected advice.")
})

test("NOOP writes nothing", async () => {
  const seed = existing("mem_20260710_aaaaaa")
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand(), meta,
    deps({ llm: fakeLlm('{"op":"NOOP","target_id":"mem_20260710_aaaaaa","reason":"same fact"}'), index, storeDir }),
  )
  expect(r.op).toBe("NOOP")
  const e = index.search("SPEF")[0]!.entry
  expect(e.evidence.length).toBe(1)
  expect(e.updated_at).toBe("2026-07-10T00:00:00.000Z")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test distiller/reconcile.test.ts`
Expected: FAIL — cannot resolve `./reconcile`.

- [ ] **Step 3: Implement**

`distiller/reconcile.ts`:
```ts
import type { Candidate } from "./extract"
import { stripFences } from "./extract"
import type { LlmClient } from "./llm"
import type { MemoryIndex } from "./ledger"
import { computeConfidence, entryId, writeEntry } from "./store"
import type { TranscriptMeta } from "./transcripts"
import type { MemoryEntry } from "./types"

export type ReconcileOp =
  | { op: "ADD" }
  | { op: "NOOP"; target_id: string; reason: string }
  | { op: "UPDATE"; target_id: string; note: string }
  | { op: "SUPERSEDE"; target_id: string; reason: string }

export const RECONCILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["ADD", "NOOP", "UPDATE", "SUPERSEDE"] },
    target_id: { type: "string" },
    note: { type: "string" },
    reason: { type: "string" },
  },
  required: ["op"],
}

const RECONCILE_SYSTEM = `You reconcile a candidate memory against existing memories in an engineering knowledge store. Choose exactly one operation:
- ADD: the candidate is genuinely new knowledge not covered by any existing memory.
- NOOP: an existing memory already states this; nothing new. Set target_id and reason.
- UPDATE: an existing memory covers the same lesson and the candidate adds evidence or nuance. Set target_id and a one-sentence note describing what the new session adds.
- SUPERSEDE: the candidate CONTRADICTS an existing memory because reality changed (new fix replaces old workaround, flow migrated). Set target_id and reason. Do not use SUPERSEDE for mere additions.
Reply with ONLY JSON: {"op": "...", "target_id": "...", "note": "...", "reason": "..."} (target_id/note/reason only where the op requires them).`

export function buildReconcilePrompt(
  c: Candidate,
  neighbors: Array<{ id: string; title: string; trigger: string; lesson: string }>,
): { system: string; prompt: string } {
  const lines = neighbors.map((n) => `- id: ${n.id}\n  title: ${n.title}\n  trigger: ${n.trigger}\n  lesson: ${n.lesson}`)
  return {
    system: RECONCILE_SYSTEM,
    prompt: `Candidate:\n  type: ${c.type}\n  title: ${c.title}\n  trigger: ${c.trigger}\n  lesson: ${c.lesson}\n\nExisting memories:\n${lines.join("\n")}`,
  }
}

export function parseReconcileOp(raw: string, neighborIds: string[]): ReconcileOp {
  const o = JSON.parse(stripFences(raw)) as Record<string, unknown>
  const op = o.op
  if (op === "ADD") return { op: "ADD" }
  if (op !== "NOOP" && op !== "UPDATE" && op !== "SUPERSEDE") throw new Error(`reconcile: invalid op "${String(op)}"`)
  const target = o.target_id
  if (typeof target !== "string" || !neighborIds.includes(target))
    throw new Error(`reconcile: target_id "${String(target)}" is not one of the presented neighbors`)
  if (op === "UPDATE") return { op, target_id: target, note: typeof o.note === "string" ? o.note : "additional evidence" }
  return { op, target_id: target, reason: typeof o.reason === "string" ? o.reason : "unspecified" }
}

export interface ReconcileDeps {
  llm: LlmClient; index: MemoryIndex; storeDir: string; now: Date
  extractorLabel: string; promptHash: string
}

function entryFromCandidate(c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps): MemoryEntry {
  const nowIso = deps.now.toISOString()
  return {
    id: entryId(meta.project, c.title, deps.now),
    memory_class: c.type === "workflow" ? "procedural" : "semantic",
    type: c.type,
    title: c.title,
    trigger: c.trigger,
    project: meta.project,
    scope: "project",
    domain: c.domain,
    volatile: c.volatile,
    confidence: computeConfidence({ sessions: 1, humanApproved: false, contradicted: false }),
    status: "active",
    superseded_by: null,
    review: "auto",
    evidence: [{ session: meta.sessionId, anchors: c.evidence.map((e) => e.message_id), observed_at: meta.timeEnd }],
    provenance: { extractor: deps.extractorLabel, prompt_hash: deps.promptHash },
    created_at: nowIso,
    updated_at: nowIso,
    lesson: c.lesson,
    notes: [],
  }
}

async function applyUpdate(
  targetId: string, note: string, c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps,
): Promise<MemoryEntry> {
  const hit = deps.index.getById(targetId)
  if (!hit) throw new Error(`reconcile: target ${targetId} not found in index`)
  const target = hit.entry
  const day = deps.now.toISOString().slice(0, 10)
  if (!target.evidence.some((ev) => ev.session === meta.sessionId))
    target.evidence.push({ session: meta.sessionId, anchors: c.evidence.map((e) => e.message_id), observed_at: meta.timeEnd })
  target.notes.push(`${day}: ${note} (${meta.sessionId})`)
  if (target.project !== meta.project && target.scope === "project")
    target.notes.push(`${day}: promotion candidate: seen in ${meta.project}`)
  const sessions = new Set(target.evidence.map((ev) => ev.session)).size
  target.confidence = computeConfidence({
    sessions, humanApproved: target.review === "human_approved", contradicted: false,
  })
  target.updated_at = deps.now.toISOString()
  const newPath = await writeEntry(deps.storeDir, target)
  deps.index.upsertEntry(target, newPath)
  return target
}

export async function reconcileCandidate(
  c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps,
): Promise<{ op: ReconcileOp["op"]; entry?: MemoryEntry }> {
  const neighbors = deps.index.search(`${c.title} ${c.lesson}`, { status: "active", limit: 5 })
  let decision: ReconcileOp
  if (neighbors.length === 0) {
    decision = { op: "ADD" }
  } else {
    const { system, prompt } = buildReconcilePrompt(c, neighbors.map((h) => ({
      id: h.entry.id, title: h.entry.title, trigger: h.entry.trigger, lesson: h.entry.lesson,
    })))
    const raw = await deps.llm.complete({ system, prompt, schema: RECONCILE_SCHEMA })
    decision = parseReconcileOp(raw, neighbors.map((h) => h.entry.id))
  }

  switch (decision.op) {
    case "ADD": {
      const entry = entryFromCandidate(c, meta, deps)
      const collision = neighbors.find((h) => h.entry.id === entry.id)
      if (collision) return { op: "UPDATE", entry: await applyUpdate(entry.id, "re-extracted", c, meta, deps) }
      const path = await writeEntry(deps.storeDir, entry)
      deps.index.upsertEntry(entry, path)
      return { op: "ADD", entry }
    }
    case "UPDATE":
      return { op: "UPDATE", entry: await applyUpdate(decision.target_id, decision.note, c, meta, deps) }
    case "SUPERSEDE": {
      const target = neighbors.find((h) => h.entry.id === decision.target_id)!
      const entry = entryFromCandidate(c, meta, deps)
      if (entry.id === target.entry.id)
        return { op: "UPDATE", entry: await applyUpdate(entry.id, "re-extracted", c, meta, deps) }
      const path = await writeEntry(deps.storeDir, entry)
      deps.index.upsertEntry(entry, path)
      const old = target.entry
      old.status = "superseded"
      old.superseded_by = entry.id
      old.notes.push(`${deps.now.toISOString().slice(0, 10)}: superseded by ${entry.id} — ${decision.reason}`)
      old.updated_at = deps.now.toISOString()
      const oldPath = await writeEntry(deps.storeDir, old)
      deps.index.upsertEntry(old, oldPath)
      return { op: "SUPERSEDE", entry }
    }
    case "NOOP":
      return { op: "NOOP" }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test distiller/reconcile.test.ts && bun run typecheck && bun test`
Expected: PASS (6 tests), typecheck clean, full suite green.

- [ ] **Step 5: Commit**

```bash
git add distiller/reconcile.ts distiller/reconcile.test.ts
git commit -m "feat(distiller): mem0-style reconcile loop with supersession"
```

---

### Task 7: distiller/pipeline.ts — orchestration with ledger idempotency and quarantine

**Files:**
- Create: `distiller/pipeline.ts`
- Test: `distiller/pipeline.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export interface RunSummary {
    scanned: number; eligible: number; skippedProcessed: number; triagedOut: number
    candidates: number; rejected: number; quarantined: number
    ops: { added: number; updated: number; superseded: number; nooped: number }
    errors: number
  }
  export interface PipelineOptions { project?: string; now?: Date; idleHours?: number; salienceMin?: number }
  export async function runPipeline(cfg: MemoryConfig, deps: { llm: LlmClient; index: MemoryIndex }, opts?: PipelineOptions): Promise<RunSummary>
  ```
- Flow per transcript from `scanSpool(cfg.transcriptsDir)` (filtered by `opts.project` when given):
  1. `isEligible(meta, now, idleHours)` else skip (not counted beyond `scanned`).
  2. `index.isProcessed(sessionId, contentHash)` → `skippedProcessed++`, continue.
  3. TRIAGE heuristic: `meta.body.length < 400` → `triagedOut++`, `recordProcessed(n_candidates: 0, n_committed: 0)`, continue.
  4. EXTRACT: `llm.complete({ system, prompt, schema: EXTRACT_SCHEMA })` → `validateCandidates(...)`.
  5. Secrets bucket → quarantine: build entry via candidate (status `"quarantined"`, review `"human_pending"`), write to `quarantinePath(storeDir, id)` (serialized like a normal entry), `upsertEntry` (so `review`/`stats` see it), `quarantined++`.
  6. Valid → `reconcileCandidate` each; tally ops.
  7. `recordProcessed({ n_candidates, n_committed: added+updated+superseded })`.
  8. Whole-transcript try/catch → `errors++`, log to stderr, continue (a failing LLM call must not kill the batch; the session stays unprocessed and retries next run).
  9. PUBLISH after the loop: `renderIndexMd(storeDir)` → writes `<storeDir>/INDEX.md` grouped by project then type: `- [<title>](memories/<project>/<id>.md) — <type>, confidence <c>, <status>` (active + candidate only; quarantined listed in a final `## Quarantine` section).
- `idleHours` default from `AGENT_MEMORY_IDLE_HOURS` env or 6; `salienceMin` default from `AGENT_MEMORY_SALIENCE_MIN` or 6 (both read in the CLI, passed as opts — pipeline takes plain numbers, no env reads).

- [ ] **Step 1: Write the failing tests**

`distiller/pipeline.test.ts` (FakeLlm scripted by call order; transcripts written with the same `sample()` shape as Task 3's tests, bodies ≥ 400 chars via padding):
```ts
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../shared/config"
import type { LlmClient } from "./llm"
import { MemoryIndex } from "./ledger"
import { runPipeline } from "./pipeline"

const PAD = "\n\npadding ".repeat(60) // pushes body length past the 400-char triage floor

const transcript = (sessionId: string, hash: string, text: string) => `---
session_id: ${sessionId}
project_dir: "/x/proja"
title: "t"
model: m
time_start: 2026-07-10T00:00:00.000Z
time_end: 2026-07-10T01:00:00.000Z
turns: 2
tokens: { input: 1, output: 1 }
content_hash: ${hash}
exported_at: 2026-07-10T02:00:00.000Z
---
## T1 [00:00] User {#msg_u1}

${text}${PAD}

## T2 [00:01] Assistant {#msg_a1}

answer
`

const candidateJson = (title: string, lesson: string) =>
  JSON.stringify([{ type: "pitfall", title, trigger: "when x", lesson, domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: 8, volatile: false }])

const scriptedLlm = (replies: string[]): LlmClient & { calls: number } => {
  const c = {
    calls: 0,
    describe: () => "fake",
    complete: async () => {
      const r = replies[c.calls] ?? "[]"
      c.calls++
      return r
    },
  }
  return c
}

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-pipe-"))
  const cfg = loadConfig({ AGENT_MEMORY_HOME: dir })
  mkdirSync(join(cfg.transcriptsDir, "proja"), { recursive: true })
  const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
  return { dir, cfg, index }
}
const NOW = new Date("2026-07-11T00:00:00.000Z") // 23h after time_end -> eligible at idleHours=6

test("end-to-end: extract -> add; rerun is idempotent; INDEX.md rendered", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "how to fix X"))
  const llm = scriptedLlm([candidateJson("Fix X", "Do Y because Z.")])
  const s1 = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s1.eligible).toBe(1)
  expect(s1.ops.added).toBe(1)
  expect(s1.errors).toBe(0)
  expect(index.search("Fix X", { status: "active" }).length).toBe(1)
  const indexMd = readFileSync(join(cfg.storeDir, "INDEX.md"), "utf8")
  expect(indexMd).toContain("Fix X")

  const s2 = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s2.skippedProcessed).toBe(1)
  expect(s2.ops.added).toBe(0)
  expect(llm.calls).toBe(1) // no second extraction
})

test("idle window and thin transcripts are respected", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "text"))
  const early = await runPipeline(cfg, { llm: scriptedLlm([]), index }, { now: new Date("2026-07-10T02:00:00.000Z") })
  expect(early.eligible).toBe(0)

  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_thin.md"),
    transcript("ses_thin", "sha256:h2", "hi").replace(PAD, "")) // short body
  const s = await runPipeline(cfg, { llm: scriptedLlm([]), index }, { now: NOW })
  expect(s.triagedOut).toBe(1)
  expect(index.isProcessed("ses_thin", "sha256:h2")).toBe(true) // thin sessions are ledgered, not retried
})

test("second session on same topic reconciles as UPDATE", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "topic"))
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_2.md"), transcript("ses_2", "sha256:h2", "same topic again"))
  const llm = scriptedLlm([
    candidateJson("SPEF pitfall", "Re-extract parasitics."),           // extract ses_1 -> ADD (no neighbors, no llm call)
    candidateJson("SPEF pitfall", "Re-extract parasitics."),           // extract ses_2
    "", // placeholder — replaced below after we know the id
  ])
  const s1 = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s1.ops.added).toBe(1)
  const id = index.search("SPEF")[0]!.entry.id
  ;(llm as { complete: LlmClient["complete"] }).complete = (() => {
    let call = 0
    return async () => {
      call++
      if (call === 1) return candidateJson("SPEF pitfall", "Re-extract parasitics.")
      return JSON.stringify({ op: "UPDATE", target_id: id, note: "confirmed" })
    }
  })()
  const s2 = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s2.ops.updated).toBe(1)
  expect(index.search("SPEF")[0]!.entry.evidence.length).toBe(2)
})

test("secret candidates land in quarantine, not the store", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "leaky"))
  const llm = scriptedLlm([candidateJson("Key setup", "Set AKIA0123456789ABCDEF first.")])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s.quarantined).toBe(1)
  expect(s.ops.added).toBe(0)
  expect(index.search("Key setup", { status: "quarantined" }).length).toBe(1)
  expect(existsSync(join(cfg.storeDir, "quarantine"))).toBe(true)
})

test("LLM failure counts an error, leaves session unprocessed for retry", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "text"))
  const llm: LlmClient = { describe: () => "f", complete: async () => { throw new Error("llm down") } }
  const s = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s.errors).toBe(1)
  expect(index.isProcessed("ses_1", "sha256:h1")).toBe(false)
  const retry = await runPipeline(cfg, { llm: scriptedLlm([candidateJson("Fix X", "Do Y.")]), index }, { now: NOW })
  expect(retry.ops.added).toBe(1)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test distiller/pipeline.test.ts`
Expected: FAIL — cannot resolve `./pipeline`.

- [ ] **Step 3: Implement**

`distiller/pipeline.ts`:
```ts
import { mkdir } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { MemoryConfig } from "../shared/config"
import { buildExtractPrompt, EXTRACT_SCHEMA, validateCandidates, type Candidate } from "./extract"
import type { LlmClient } from "./llm"
import type { MemoryIndex } from "./ledger"
import { reconcileCandidate } from "./reconcile"
import { computeConfidence, entryId, listEntryPaths, quarantinePath, readEntry, serializeEntry } from "./store"
import { isEligible, scanSpool, type TranscriptMeta } from "./transcripts"
import type { MemoryEntry } from "./types"

export interface RunSummary {
  scanned: number; eligible: number; skippedProcessed: number; triagedOut: number
  candidates: number; rejected: number; quarantined: number
  ops: { added: number; updated: number; superseded: number; nooped: number }
  errors: number
}

export interface PipelineOptions { project?: string; now?: Date; idleHours?: number; salienceMin?: number }

const TRIAGE_MIN_BODY = 400

function quarantineEntry(c: Candidate, meta: TranscriptMeta, now: Date, extractor: string, promptHash: string): MemoryEntry {
  const nowIso = now.toISOString()
  return {
    id: entryId(meta.project, c.title, now),
    memory_class: c.type === "workflow" ? "procedural" : "semantic",
    type: c.type, title: c.title, trigger: c.trigger,
    project: meta.project, scope: "project", domain: c.domain, volatile: c.volatile,
    confidence: computeConfidence({ sessions: 1, humanApproved: false, contradicted: false }),
    status: "quarantined", superseded_by: null, review: "human_pending",
    evidence: [{ session: meta.sessionId, anchors: c.evidence.map((e) => e.message_id), observed_at: meta.timeEnd }],
    provenance: { extractor, prompt_hash: promptHash },
    created_at: nowIso, updated_at: nowIso, lesson: c.lesson, notes: [],
  }
}

export async function runPipeline(
  cfg: MemoryConfig,
  deps: { llm: LlmClient; index: MemoryIndex },
  opts: PipelineOptions = {},
): Promise<RunSummary> {
  const now = opts.now ?? new Date()
  const idleHours = opts.idleHours ?? 6
  const salienceMin = opts.salienceMin ?? 6
  const extractor = `distiller v0.1 / ${deps.llm.describe()}`
  const summary: RunSummary = {
    scanned: 0, eligible: 0, skippedProcessed: 0, triagedOut: 0,
    candidates: 0, rejected: 0, quarantined: 0,
    ops: { added: 0, updated: 0, superseded: 0, nooped: 0 }, errors: 0,
  }

  let metas = scanSpool(cfg.transcriptsDir)
  if (opts.project) metas = metas.filter((m) => m.project === opts.project)
  summary.scanned = metas.length

  for (const meta of metas) {
    try {
      if (!isEligible(meta, now, idleHours)) continue
      summary.eligible++
      if (deps.index.isProcessed(meta.sessionId, meta.contentHash)) {
        summary.skippedProcessed++
        continue
      }
      if (meta.body.length < TRIAGE_MIN_BODY) {
        summary.triagedOut++
        deps.index.recordProcessed({
          session_id: meta.sessionId, content_hash: meta.contentHash,
          extractor_model: extractor, n_candidates: 0, n_committed: 0,
        })
        continue
      }

      const { system, prompt, promptHash } = buildExtractPrompt(meta)
      const raw = await deps.llm.complete({ system: `${system}\n\nSalience threshold: ${salienceMin}.`, prompt, schema: EXTRACT_SCHEMA })
      const validated = validateCandidates(raw, meta, salienceMin)
      summary.candidates += validated.valid.length + validated.secrets.length
      summary.rejected += validated.rejected.length
      for (const rej of validated.rejected)
        console.error(`distiller: ${meta.sessionId}: rejected candidate: ${rej.reasons.join("; ")}`)

      for (const sec of validated.secrets) {
        const qe = quarantineEntry(sec.item, meta, now, extractor, promptHash)
        qe.notes.push(`${now.toISOString().slice(0, 10)}: quarantined — secret scan: ${sec.matches.join(", ")}`)
        const qPath = quarantinePath(cfg.storeDir, qe.id)
        await mkdir(dirname(qPath), { recursive: true })
        await Bun.write(qPath, serializeEntry(qe))
        deps.index.upsertEntry(qe, qPath)
        summary.quarantined++
      }

      let committed = 0
      for (const c of validated.valid) {
        const r = await reconcileCandidate(c, meta, {
          llm: deps.llm, index: deps.index, storeDir: cfg.storeDir, now, extractorLabel: extractor, promptHash,
        })
        if (r.op === "ADD") { summary.ops.added++; committed++ }
        else if (r.op === "UPDATE") { summary.ops.updated++; committed++ }
        else if (r.op === "SUPERSEDE") { summary.ops.superseded++; committed++ }
        else summary.ops.nooped++
      }

      deps.index.recordProcessed({
        session_id: meta.sessionId, content_hash: meta.contentHash,
        extractor_model: extractor, n_candidates: validated.valid.length + validated.secrets.length, n_committed: committed,
      })
    } catch (e) {
      summary.errors++
      console.error(`distiller: ${meta.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  await renderIndexMd(cfg.storeDir)
  return summary
}

export async function renderIndexMd(storeDir: string): Promise<void> {
  const byProject = new Map<string, MemoryEntry[]>()
  const quarantined: MemoryEntry[] = []
  for (const path of listEntryPaths(storeDir)) {
    try {
      const e = await readEntry(path)
      if (e.status === "quarantined") quarantined.push(e)
      else if (e.status === "active" || e.status === "candidate") {
        const list = byProject.get(e.project) ?? []
        list.push(e)
        byProject.set(e.project, list)
      }
    } catch {
      // unparseable entry: skip in index rendering
    }
  }
  const lines: string[] = ["# Memory Index", ""]
  for (const [project, entries] of [...byProject.entries()].sort()) {
    lines.push(`## ${project}`, "")
    for (const e of entries.sort((a, b) => a.type.localeCompare(b.type) || b.confidence - a.confidence))
      lines.push(`- [${e.title}](memories/${e.project}/${e.id}.md) — ${e.type}, confidence ${e.confidence}, ${e.status}`)
    lines.push("")
  }
  if (quarantined.length > 0) {
    lines.push("## Quarantine", "")
    for (const e of quarantined) lines.push(`- ${e.id}: ${e.title}`)
    lines.push("")
  }
  await mkdir(storeDir, { recursive: true })
  await Bun.write(join(storeDir, "INDEX.md"), lines.join("\n"))
}
```

Note for the implementer: `relative` is unused — do not import it (the snippet above intentionally lists final imports; remove any import your editor flags as unused before committing).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test distiller/pipeline.test.ts && bun run typecheck && bun test`
Expected: PASS (5 tests), typecheck clean, full suite green.

- [ ] **Step 5: Commit**

```bash
git add distiller/pipeline.ts distiller/pipeline.test.ts
git commit -m "feat(distiller): pipeline orchestration with ledger idempotency and quarantine"
```

---

### Task 8: distiller/cli.ts — run / reindex / review / stats

**Files:**
- Create: `distiller/cli.ts`
- Test: `distiller/cli.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CliDeps { llm?: LlmClient; out?: (line: string) => void; err?: (line: string) => void }
  export async function runCli(argv: string[], env: Record<string, string | undefined>, deps?: CliDeps): Promise<number>
  ```
  plus `if (import.meta.main)` guard calling `runCli(process.argv.slice(2), process.env)` and `process.exit(code)`.
- Commands:
  - `run [--project <slug>]` — builds cfg from env, LLM from `clientFromEnv(env)` (or injected), `idleHours` from `AGENT_MEMORY_IDLE_HOURS` (float, ≥0), `salienceMin` from `AGENT_MEMORY_SALIENCE_MIN` (int 0-10); prints one summary line: `distill done: X added, Y updated, Z superseded, N nooped, Q quarantined, R rejected, E errors (scanned S, eligible G, already-done D, triaged T)`.
  - `reindex` — `MemoryIndex.rebuildFrom(storeDir)`, prints `reindexed N memories`.
  - `review` — lists quarantined entries: `id — title (reasons from last note)`, or `quarantine empty`.
  - `stats` — prints `memories: <byStatus json>; types: <byType json>; sessions processed: <n>`.
  - Unknown/missing command → usage to `err`, exit 1. Invalid env numbers → descriptive `err`, exit 1. `index.db` lives at `<storeDir>/index.db`; created on demand; `close()` always called.

- [ ] **Step 1: Write the failing tests**

`distiller/cli.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "./cli"
import type { LlmClient } from "./llm"

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-cli-"))
  const env = { AGENT_MEMORY_HOME: dir, AGENT_MEMORY_IDLE_HOURS: "0" }
  const out: string[] = []
  const err: string[] = []
  const deps = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }
  return { dir, env, out, err, deps }
}

const PAD = "\n\npadding ".repeat(60)
const transcript = `---
session_id: ses_1
project_dir: "/x/proja"
title: "t"
model: m
time_start: 2026-07-10T00:00:00.000Z
time_end: 2026-07-10T01:00:00.000Z
turns: 2
tokens: { input: 1, output: 1 }
content_hash: sha256:h1
exported_at: 2026-07-10T02:00:00.000Z
---
## T1 [00:00] User {#msg_u1}

question${PAD}

## T2 [00:01] Assistant {#msg_a1}

answer
`

const llm: LlmClient = {
  describe: () => "fake",
  complete: async () =>
    JSON.stringify([{ type: "know_how", title: "Tip", trigger: "when", lesson: "Do it.", domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: 8, volatile: false }]),
}

test("run distills and prints summary; stats and review reflect state", async () => {
  const { dir, env, out, deps } = setup()
  mkdirSync(join(dir, "transcripts", "proja"), { recursive: true })
  writeFileSync(join(dir, "transcripts", "proja", "ses_1.md"), transcript)
  expect(await runCli(["run"], env, { ...deps, llm })).toBe(0)
  expect(out.join("\n")).toContain("1 added")

  out.length = 0
  expect(await runCli(["stats"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain('"active":1')

  out.length = 0
  expect(await runCli(["review"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain("quarantine empty")
})

test("reindex rebuilds from markdown after index.db deletion", async () => {
  const { dir, env, out, deps } = setup()
  mkdirSync(join(dir, "transcripts", "proja"), { recursive: true })
  writeFileSync(join(dir, "transcripts", "proja", "ses_1.md"), transcript)
  await runCli(["run"], env, { ...deps, llm })
  const { rmSync } = await import("node:fs")
  rmSync(join(dir, "store", "index.db"))
  out.length = 0
  expect(await runCli(["reindex"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain("reindexed 1")
})

test("unknown command and bad env are friendly errors", async () => {
  const { env, err, deps } = setup()
  expect(await runCli(["yolo"], env, deps)).toBe(1)
  expect(err.join("\n")).toContain("usage")
  expect(await runCli(["run"], { ...env, AGENT_MEMORY_IDLE_HOURS: "banana" }, deps)).toBe(1)
  expect(err.join("\n")).toContain("AGENT_MEMORY_IDLE_HOURS")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test distiller/cli.test.ts`
Expected: FAIL — cannot resolve `./cli`.

- [ ] **Step 3: Implement**

`distiller/cli.ts`:
```ts
import { join } from "node:path"
import { loadConfig } from "../shared/config"
import { clientFromEnv, type LlmClient } from "./llm"
import { MemoryIndex } from "./ledger"
import { runPipeline } from "./pipeline"

export interface CliDeps { llm?: LlmClient; out?: (line: string) => void; err?: (line: string) => void }

const USAGE = "usage: distiller <run [--project <slug>] | reindex | review | stats>"

const numEnv = (
  env: Record<string, string | undefined>, key: string, fallback: number,
  check: (n: number) => boolean,
): number => {
  const raw = env[key]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !check(n)) throw new Error(`${key} must be a valid number (got "${raw}")`)
  return n
}

export async function runCli(
  argv: string[], env: Record<string, string | undefined>, deps: CliDeps = {},
): Promise<number> {
  const out = deps.out ?? console.log
  const err = deps.err ?? console.error
  const [command, ...rest] = argv
  const cfg = loadConfig(env)
  try {
    switch (command) {
      case "run": {
        const idleHours = numEnv(env, "AGENT_MEMORY_IDLE_HOURS", 6, (n) => n >= 0)
        const salienceMin = numEnv(env, "AGENT_MEMORY_SALIENCE_MIN", 6, (n) => n >= 0 && n <= 10)
        const pi = rest.indexOf("--project")
        const project = pi >= 0 ? rest[pi + 1] : undefined
        if (pi >= 0 && !project) throw new Error("--project needs a value")
        const llm = deps.llm ?? clientFromEnv(env)
        const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
        try {
          const s = await runPipeline(cfg, { llm, index }, { project, idleHours, salienceMin })
          out(
            `distill done: ${s.ops.added} added, ${s.ops.updated} updated, ${s.ops.superseded} superseded, ` +
              `${s.ops.nooped} nooped, ${s.quarantined} quarantined, ${s.rejected} rejected, ${s.errors} errors ` +
              `(scanned ${s.scanned}, eligible ${s.eligible}, already-done ${s.skippedProcessed}, triaged ${s.triagedOut})`,
          )
          return s.errors > 0 ? 2 : 0
        } finally {
          index.close()
        }
      }
      case "reindex": {
        const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
        try {
          out(`reindexed ${await index.rebuildFrom(cfg.storeDir)} memories`)
          return 0
        } finally {
          index.close()
        }
      }
      case "review": {
        const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
        try {
          const hits = index.search("*", {})
          void hits
          const rows = index.stats().byStatus.quarantined ?? 0
          if (rows === 0) {
            out("quarantine empty")
            return 0
          }
          const { listEntryPaths, readEntry } = await import("./store")
          let shown = 0
          for (const p of listEntryPaths(cfg.storeDir)) {
            const e = await readEntry(p)
            if (e.status === "quarantined") {
              out(`${e.id} — ${e.title} (${e.notes.at(-1) ?? "no note"})`)
              shown++
            }
          }
          const { readdirSync } = await import("node:fs")
          try {
            for (const n of readdirSync(join(cfg.storeDir, "quarantine"))) {
              const e = await readEntry(join(cfg.storeDir, "quarantine", n))
              out(`${e.id} — ${e.title} (${e.notes.at(-1) ?? "no note"})`)
              shown++
            }
          } catch {
            // no quarantine dir
          }
          if (shown === 0) out("quarantine empty")
          return 0
        } finally {
          index.close()
        }
      }
      case "stats": {
        const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
        try {
          const s = index.stats()
          out(`memories: ${JSON.stringify(s.byStatus)}; types: ${JSON.stringify(s.byType)}; sessions processed: ${s.sessions}`)
          return 0
        } finally {
          index.close()
        }
      }
      default:
        err(USAGE)
        return 1
    }
  } catch (e) {
    err(`distiller: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2), process.env))
}
```

Implementer note: quarantined entries live under `quarantine/` (not `memories/`), so `listEntryPaths` will not see them — the readdir loop over `quarantine/` is the one that finds them; the `listEntryPaths` pass exists for any quarantined entries later moved into `memories/` by a human. Remove the dead `index.search("*")` lines if you find a cleaner structure — the tests define the behavior, not this sketch's exact statements. The `review` command MUST print `quarantine empty` when nothing is quarantined and one line per quarantined entry otherwise.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test distiller/cli.test.ts && bun run typecheck && bun test`
Expected: PASS (3 tests), typecheck clean, full suite green.

- [ ] **Step 5: Add package.json script**

Add to `package.json` scripts: `"distill": "bun distiller/cli.ts"`. Run `bun run distill stats` once against the default env to confirm it executes (any output is fine).

- [ ] **Step 6: Commit**

```bash
git add distiller/cli.ts distiller/cli.test.ts package.json
git commit -m "feat(distiller): cli with run, reindex, review, and stats commands"
```

---

### Task 9: docs + VERIFY (distiller)

**Files:**
- Modify: `README.md`, `LLM_WIKI.md`
- Create: `docs/superpowers/VERIFY-distiller.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Update `README.md`**

Add a "Distiller" section after the collector docs: pipeline stages diagram (INGEST → TRIAGE → EXTRACT → VALIDATE → RECONCILE → COMMIT → PUBLISH), CLI usage (`bun run distill run|reindex|review|stats`), env config table (`AGENT_MEMORY_LLM`, `AGENT_MEMORY_VLLM_URL`, `AGENT_MEMORY_VLLM_MODEL`, `AGENT_MEMORY_VLLM_KEY`, `AGENT_MEMORY_IDLE_HOURS`, `AGENT_MEMORY_SALIENCE_MIN`), memory entry format sample (spec §7), store layout (`memories/`, `quarantine/`, `index.db` rebuildable, `INDEX.md`), scheduling examples (cron line `0 3 * * * cd <repo> && bun run distill run`, launchd note), and the "opencode-run backend is the dev fallback; vLLM guided json is production" note.

- [ ] **Step 2: Update `LLM_WIKI.md`**

新增 distiller 章節（繁中）：管線階段與每階段責任、六型分類、confidence 公式（0.5 基準的 spec 修正緣由）、冪等 ledger 鍵、quarantine 審查流程（`bun run distill review`）、與 collector 的介面（transcript frontmatter 契約）、已知陷阱補充（FTS 查詢須 sanitize、opencode-run 訊息在 flags 前、vLLM 需 guided decoding、index.db 可隨時 `reindex` 重建）。

- [ ] **Step 3: Write `docs/superpowers/VERIFY-distiller.md`**

```markdown
# VERIFY — distiller (Plan 2)

Status: PENDING

Headless items (executor MUST run these, not defer):
1. `bun test` — all green.
2. `bun run typecheck` — clean.
3. Real end-to-end on this machine (opencode-run backend, zero idle window):
   `AGENT_MEMORY_IDLE_HOURS=0 bun run distill run --project tmp`
   → the verify-collector transcript distills; summary line prints; then
   `bun run distill stats` shows the entries and
   `sqlite3 ~/.agent-memory/store/index.db "SELECT id, status FROM memories"` lists them.
4. `bun run distill reindex` after deleting index.db → same stats.
5. Idempotency: re-run item 3's command → `already-done >= 1`, no new entries.

Interactive items (user):
6. Inspect one generated memory file under ~/.agent-memory/store/memories/ —
   frontmatter fields sensible, lesson readable, evidence anchors point at real
   transcript turns.
7. (When a vLLM endpoint is reachable) AGENT_MEMORY_LLM=vllm + URL/MODEL envs:
   rerun item 3 against a fresh AGENT_MEMORY_HOME; extraction quality acceptable.
```

- [ ] **Step 4: Run full gates**

Run: `bun test && bun run typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add README.md LLM_WIKI.md docs/superpowers/VERIFY-distiller.md
git commit -m "docs: distiller usage, wiki notes, and verification checklist"
```

