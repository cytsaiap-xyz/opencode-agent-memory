# MCP Server (Plan 3 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The query interface: an MCP stdio server exposing `search_memory` / `get_memory` / `list_domains` / `memory_stats` over the memory store, read-only except access-stat recording.

**Architecture:** Pure query layer (`mcp-server/query.ts`) over the existing `MemoryIndex` + store; MCP wiring (`mcp-server/server.ts`, testable via `InMemoryTransport`); stdio entry (`mcp-server/main.ts`) + an in-process probe CLI. Spec §8; SDK shapes validated by Spike B (`docs/superpowers/SPIKE.md`).

**Tech Stack:** TypeScript + Bun, `bun:test`, `@modelcontextprotocol/sdk` (exact 1.29.0), `zod` (exact 4.4.3) — the repo's FIRST runtime dependencies, sanctioned by spec §8.

## Global Constraints

- Runtime dependencies allowed: EXACTLY `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3` (bunfig exact pinning). Nothing else.
- **stdout belongs to the MCP protocol** — all human logging goes to stderr. Never `console.log` in server/main code paths.
- **Read-only guarantee:** the server never mutates markdown or index content; the ONLY writes are `recordAccess` (access_count/last_accessed).
- Default serve filter: `status = "active" AND confidence >= 0.5`; `include_tentative: true` drops the confidence floor (status stays active-only). Max limit 50, default 10.
- Tests use `InMemoryTransport` (Spike B), not stdio spawning — except one spawn smoke test in Task 3.
- SDK arg validation (zod) covers shapes; handlers still guard semantics and wrap errors as `isError` content (never throw through the transport).
- Tests: per-test tmp dirs; poll, never fixed sleeps.
- Commits: conventional, scope `mcp`/`distiller` as fits, trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01ALAk5sCENNGXZyy6mSg8tF`

---

### Task 1: dependencies + ledger concurrency prep + query layer

**Files:**
- Modify: `package.json` (deps), `distiller/ledger.ts` (busy_timeout + stats.lastProcessedAt), `distiller/ledger.test.ts`
- Create: `mcp-server/query.ts`
- Test: `mcp-server/query.test.ts`

**Interfaces:**
- `MemoryIndex` gains: `PRAGMA busy_timeout = 5000` in the constructor (deferred Plan-2 item — the mcp-server and a distiller cron may now open index.db concurrently); `stats()` return gains `lastProcessedAt: string | null` (`MAX(processed_at)` over processed_sessions).
- `mcp-server/query.ts` produces:
  ```ts
  export interface SearchOpts {
    query: string; project?: string; type?: string; domain?: string
    include_tentative?: boolean; limit?: number
  }
  export interface MemorySummary {
    id: string; title: string; trigger: string; lesson: string
    type: string; project: string; domain: string[]
    confidence: number; updated_at: string
  }
  export function searchMemory(index: MemoryIndex, opts: SearchOpts, now?: Date): MemorySummary[]
  export function getMemory(index: MemoryIndex, id: string): (MemoryEntry & { path: string }) | null
  export function listDomains(storeDir: string, project?: string): {
    domains: Record<string, number>; types: Record<string, number>; projects: Record<string, number>
  }
  export function memoryStats(index: MemoryIndex, storeDir: string): {
    byStatus: Record<string, number>; byType: Record<string, number>
    sessions: number; lastProcessedAt: string | null; quarantineFiles: number
  }
  ```
- `searchMemory` semantics: fetch up to 30 via `index.search(query, { project, type, status: "active", minConfidence: include_tentative ? 0 : 0.5, limit: 30 })`; post-filter by `domain` (entry.domain includes it) when given; **re-rank** by composite score `bm25 + (-2 * confidence) + (updated within 30 days of now ? -0.5 : 0)` ascending (bm25 is more-negative-is-better, so boosts subtract); slice to `min(limit ?? 10, 50)`; `recordAccess` each RETURNED id; map to `MemorySummary`.
- `getMemory`: `index.getById(id)`; on hit `recordAccess(id)` and return `{ ...entry, path }`; else null.
- `listDomains`: walk `listEntryPaths(storeDir)` with `readFileSync` + `parseEntry` (per-file try/catch skip), count `domain[i]`/`type`/`project` over entries with `status === "active"` (optionally filtered by `project` arg).
- `memoryStats`: `index.stats()` spread + `quarantineFiles` = count of `.md` files in `<storeDir>/quarantine` (readdirSync in try/catch, 0 when absent).

- [ ] **Step 1: Add dependencies**

Run: `cd <repo> && bun add @modelcontextprotocol/sdk@1.29.0 zod@4.4.3`
Verify `package.json` gains a `dependencies` block with exactly those two, exact versions (bunfig `exact = true`).

- [ ] **Step 2: Write the failing ledger tests (extend existing)**

In `distiller/ledger.test.ts`, extend the stats test: after `recordProcessed`, `idx.stats().lastProcessedAt` is a non-null ISO string; on a fresh index it is `null`. Add: two `MemoryIndex` instances on the SAME db path can both `recordProcessed` without throwing (busy_timeout smoke — sequential calls, both close cleanly).

- [ ] **Step 3: Write the failing query tests**

`mcp-server/query.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryIndex } from "../distiller/ledger"
import { serializeEntry, writeEntry } from "../distiller/store"
import type { MemoryEntry } from "../distiller/types"
import { getMemory, listDomains, memoryStats, searchMemory } from "./query"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-q-"))

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: `SPEF pitfall ${id}`, trigger: "after ECO", project: "proja", scope: "project",
  domain: ["sta"], volatile: false, confidence: 0.65, status: "active", superseded_by: null,
  review: "auto",
  evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-01T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
  lesson: "Re-extract SPEF parasitics before STA.", notes: [],
  ...over,
})

const setup = async (entries: MemoryEntry[]) => {
  const dir = tmp()
  const storeDir = join(dir, "store")
  const index = new MemoryIndex(join(storeDir, "index.db"))
  for (const e of entries) index.upsertEntry(e, await writeEntry(storeDir, e))
  return { storeDir, index }
}
const NOW = new Date("2026-07-10T00:00:00.000Z")

test("searchMemory: default filter hides tentative; include_tentative reveals", async () => {
  const { index } = await setup([
    entry("mem_hi", { confidence: 0.65 }),
    entry("mem_lo", { confidence: 0.5 - 0.05, title: "SPEF hunch mem_lo" }),
  ])
  const strict = searchMemory(index, { query: "SPEF" }, NOW)
  expect(strict.map((h) => h.id)).toEqual(["mem_hi"])
  const loose = searchMemory(index, { query: "SPEF", include_tentative: true }, NOW)
  expect(loose.map((h) => h.id).sort()).toEqual(["mem_hi", "mem_lo"])
})

test("searchMemory: confidence and recency boost the ranking", async () => {
  const { index } = await setup([
    entry("mem_old", { confidence: 0.5, updated_at: "2026-01-01T00:00:00.000Z" }),
    entry("mem_fresh", { confidence: 0.95, updated_at: "2026-07-09T00:00:00.000Z" }),
  ])
  const hits = searchMemory(index, { query: "SPEF parasitics" }, NOW)
  expect(hits[0]!.id).toBe("mem_fresh")
})

test("searchMemory: domain filter, limit cap, access recording", async () => {
  const { index } = await setup([
    entry("mem_a", { domain: ["sta"] }),
    entry("mem_b", { domain: ["drc"], title: "SPEF drc note" }),
  ])
  const hits = searchMemory(index, { query: "SPEF", domain: "drc" }, NOW)
  expect(hits.map((h) => h.id)).toEqual(["mem_b"])
  expect(index.accessStats("mem_b")!.access_count).toBe(1)
  expect(index.accessStats("mem_a")!.access_count).toBe(0) // filtered-out hits are not recorded
  expect(searchMemory(index, { query: "SPEF", limit: 999 }, NOW).length).toBeLessThanOrEqual(50)
})

test("getMemory returns full entry with path and records access; null on miss", async () => {
  const { index } = await setup([entry("mem_a", { notes: ["a note"] })])
  const got = getMemory(index, "mem_a")
  expect(got!.notes).toEqual(["a note"])
  expect(got!.path.endsWith("mem_a.md")).toBe(true)
  expect(index.accessStats("mem_a")!.access_count).toBe(1)
  expect(getMemory(index, "mem_nope")).toBeNull()
})

test("listDomains aggregates active entries only, optionally per project", async () => {
  const { storeDir } = await setup([
    entry("mem_a", { domain: ["sta", "eco"] }),
    entry("mem_b", { project: "projb", domain: ["sta"], title: "other" }),
    entry("mem_dead", { status: "superseded", domain: ["dead"] }),
  ])
  const all = listDomains(storeDir)
  expect(all.domains).toEqual({ sta: 2, eco: 1 })
  expect(all.projects).toEqual({ proja: 1, projb: 1 })
  expect(all.types.pitfall).toBe(2)
  expect(listDomains(storeDir, "projb").domains).toEqual({ sta: 1 })
})

test("memoryStats includes quarantine file count and lastProcessedAt", async () => {
  const { storeDir, index } = await setup([entry("mem_a")])
  mkdirSync(join(storeDir, "quarantine"), { recursive: true })
  writeFileSync(join(storeDir, "quarantine", "mem_q.md"), serializeEntry(entry("mem_q", { status: "quarantined" })))
  index.recordProcessed({ session_id: "s", content_hash: "h", extractor_model: "f", n_candidates: 1, n_committed: 1 })
  const s = memoryStats(index, storeDir)
  expect(s.quarantineFiles).toBe(1)
  expect(s.byStatus.active).toBe(1)
  expect(typeof s.lastProcessedAt).toBe("string")
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test mcp-server/query.test.ts` → FAIL (cannot resolve ./query). `bun test distiller/ledger.test.ts` → FAIL on the new stats assertions.

- [ ] **Step 5: Implement**

`distiller/ledger.ts` deltas: constructor adds `this.db.run("PRAGMA busy_timeout = 5000")`; `stats()` adds `lastProcessedAt: (this.db.query("SELECT MAX(processed_at) AS m FROM processed_sessions").get() as { m: string | null }).m`.

`mcp-server/query.ts`:
```ts
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
```

Note: `projects` counts entries per project (not domain occurrences) — the test pins `{ proja: 1, projb: 1 }`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test mcp-server/query.test.ts distiller/ledger.test.ts && bun run typecheck && bun test`
Expected: PASS (6 new + extended), full suite green.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock distiller/ledger.ts distiller/ledger.test.ts mcp-server/query.ts mcp-server/query.test.ts
git commit -m "feat(mcp): query layer with ranking, domain aggregation, and concurrency prep"
```

---

### Task 2: mcp-server/server.ts — MCP tool wiring

**Files:**
- Create: `mcp-server/server.ts`
- Test: `mcp-server/server.test.ts`

**Interfaces:**
- Produces: `buildServer(deps: { index: MemoryIndex; storeDir: string }): McpServer` — registers exactly 4 tools:
  - `search_memory` — args `{ query: z.string().min(1), project: z.string().optional(), type: z.enum(["decision","root_cause","pitfall","know_how","convention","workflow"]).optional(), domain: z.string().optional(), include_tentative: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional() }`; returns JSON text of `MemorySummary[]`. Description must tell the agent what this is for: "Search the team's distilled engineering memory (debugging root causes, pitfalls, decisions, know-how extracted from past agent sessions). Returns matching lessons with confidence scores. Use trigger/lesson text in results to decide relevance."
  - `get_memory` — args `{ id: z.string() }`; full entry JSON incl. evidence/notes/path; unknown id → `isError: true` content `memory not found: <id>`.
  - `list_domains` — args `{ project: z.string().optional() }`; JSON of `{ domains, types, projects }`.
  - `memory_stats` — args `{}`; JSON of memoryStats.
- Every handler wraps its body in try/catch → on error returns `{ isError: true, content: [{ type: "text", text: "..." }] }` (never throws through the transport).
- Server metadata: name `agent-memory`, version read from package.json (import with `{ type: "json" }` or hardcode `"0.1.0"` — hardcode, simpler).

- [ ] **Step 1: Write the failing tests**

`mcp-server/server.test.ts` (InMemoryTransport pattern from Spike B):
```ts
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { MemoryIndex } from "../distiller/ledger"
import { writeEntry, serializeEntry, readEntry } from "../distiller/store"
import type { MemoryEntry } from "../distiller/types"
import { buildServer } from "./server"

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: `SPEF pitfall ${id}`, trigger: "after ECO", project: "proja", scope: "project",
  domain: ["sta"], volatile: false, confidence: 0.65, status: "active", superseded_by: null,
  review: "auto",
  evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-01T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
  lesson: "Re-extract SPEF parasitics before STA.", notes: [],
  ...over,
})

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-srv-"))
  const storeDir = join(dir, "store")
  const index = new MemoryIndex(join(storeDir, "index.db"))
  const e = entry("mem_a")
  const path = await writeEntry(storeDir, e)
  index.upsertEntry(e, path)
  const server = buildServer({ index, storeDir })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(ct)
  return { client, index, storeDir, path, entryA: e }
}

const textOf = (res: unknown): string =>
  ((res as { content: Array<{ type: string; text: string }> }).content[0] ?? { text: "" }).text

test("exposes exactly the four tools", async () => {
  const { client } = await setup()
  const tools = (await client.listTools()).tools.map((t) => t.name).sort()
  expect(tools).toEqual(["get_memory", "list_domains", "memory_stats", "search_memory"])
})

test("search_memory returns summaries as JSON text", async () => {
  const { client } = await setup()
  const res = await client.callTool({ name: "search_memory", arguments: { query: "SPEF" } })
  const hits = JSON.parse(textOf(res)) as Array<{ id: string; lesson: string }>
  expect(hits.length).toBe(1)
  expect(hits[0]!.id).toBe("mem_a")
  expect(hits[0]!.lesson).toContain("parasitics")
})

test("get_memory returns full entry; unknown id is isError", async () => {
  const { client } = await setup()
  const ok = await client.callTool({ name: "get_memory", arguments: { id: "mem_a" } })
  const full = JSON.parse(textOf(ok)) as { evidence: unknown[]; path: string }
  expect(full.evidence.length).toBe(1)
  const missing = await client.callTool({ name: "get_memory", arguments: { id: "mem_zzz" } })
  expect((missing as { isError?: boolean }).isError).toBe(true)
  expect(textOf(missing)).toContain("memory not found")
})

test("list_domains and memory_stats return JSON shapes", async () => {
  const { client } = await setup()
  const domains = JSON.parse(textOf(await client.callTool({ name: "list_domains", arguments: {} })))
  expect(domains.domains.sta).toBe(1)
  const stats = JSON.parse(textOf(await client.callTool({ name: "memory_stats", arguments: {} })))
  expect(stats.byStatus.active).toBe(1)
  expect(stats.quarantineFiles).toBe(0)
})

test("server is read-only over the store content", async () => {
  const { client, path, entryA } = await setup()
  await client.callTool({ name: "search_memory", arguments: { query: "SPEF" } })
  await client.callTool({ name: "get_memory", arguments: { id: "mem_a" } })
  expect(await readEntry(path)).toEqual(entryA) // markdown untouched (access stats live in index.db only)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test mcp-server/server.test.ts` → FAIL (cannot resolve ./server).

- [ ] **Step 3: Implement**

`mcp-server/server.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { MemoryIndex } from "../distiller/ledger"
import { getMemory, listDomains, memoryStats, searchMemory } from "./query"

const MEMORY_TYPES = ["decision", "root_cause", "pitfall", "know_how", "convention", "workflow"] as const

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] })
const fail = (message: string): ToolResult => ({ isError: true, content: [{ type: "text", text: message }] })

const guarded = <A>(fn: (args: A) => ToolResult) => async (args: A): Promise<ToolResult> => {
  try {
    return fn(args)
  } catch (e) {
    return fail(`tool failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function buildServer(deps: { index: MemoryIndex; storeDir: string }): McpServer {
  const server = new McpServer({ name: "agent-memory", version: "0.1.0" })

  server.registerTool(
    "search_memory",
    {
      description:
        "Search the team's distilled engineering memory — debugging root causes, pitfalls, " +
        "decisions, conventions, workflows and know-how extracted from past AI-agent sessions. " +
        "Returns lessons with confidence scores; use trigger/lesson text to judge relevance. " +
        "Call this before solving a problem that teammates may have hit before.",
      inputSchema: {
        query: z.string().min(1).describe("Full-text query (error messages, tool names, concepts)"),
        project: z.string().optional().describe("Restrict to one project slug"),
        type: z.enum(MEMORY_TYPES).optional(),
        domain: z.string().optional().describe("Restrict to a domain tag, e.g. 'sta'"),
        include_tentative: z.boolean().optional().describe("Include low-confidence (<0.5) memories"),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    guarded((args) => ok(searchMemory(deps.index, args))),
  )

  server.registerTool(
    "get_memory",
    {
      description: "Fetch one memory entry in full (lesson, evidence pointers, notes, provenance) by id.",
      inputSchema: { id: z.string().describe("Memory id, e.g. mem_20260710_a3f9c1") },
    },
    guarded(({ id }) => {
      const entry = getMemory(deps.index, id)
      return entry ? ok(entry) : fail(`memory not found: ${id}`)
    }),
  )

  server.registerTool(
    "list_domains",
    {
      description: "List active-memory counts by domain tag, type, and project — use to orient before searching.",
      inputSchema: { project: z.string().optional() },
    },
    guarded(({ project }) => ok(listDomains(deps.storeDir, project))),
  )

  server.registerTool(
    "memory_stats",
    {
      description: "Store totals: memories by status/type, sessions processed, last distill time, quarantine count.",
      inputSchema: {},
    },
    guarded(() => ok(memoryStats(deps.index, deps.storeDir))),
  )

  return server
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test mcp-server/server.test.ts && bun run typecheck && bun test`
Expected: PASS (5 tests), full suite green.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/server.ts mcp-server/server.test.ts
git commit -m "feat(mcp): server wiring with four memory tools"
```

---

### Task 3: main.ts stdio entry + probe CLI + spawn smoke test

**Files:**
- Create: `mcp-server/main.ts`, `mcp-server/probe.ts`
- Modify: `package.json` (scripts)
- Test: `mcp-server/main.test.ts`

**Interfaces:**
- `mcp-server/main.ts`: `import.meta.main`-guarded stdio entry — `loadConfig()`, `mkdirSync(storeDir, { recursive: true })`, open `MemoryIndex(<storeDir>/index.db)`, `buildServer`, connect `StdioServerTransport` (`@modelcontextprotocol/sdk/server/stdio.js`); on SIGINT/SIGTERM close index and exit 0. Startup line to STDERR only: `agent-memory mcp server ready (store: <path>)`.
- `mcp-server/probe.ts`: dev/verification CLI — `bun mcp-server/probe.ts <query> [--project p]` builds the server against the REAL config store, connects an in-memory client, calls `search_memory`, prints the JSON result to stdout (this is a CLI, not the protocol — stdout fine), exits 0. `--stats` flag calls `memory_stats` instead.
- `package.json` scripts: `"mcp": "bun mcp-server/main.ts"`, `"mcp:probe": "bun mcp-server/probe.ts"`.

- [ ] **Step 1: Write the failing spawn smoke test**

`mcp-server/main.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("stdio entry answers initialize and tools/list over real stdio", async () => {
  const home = mkdtempSync(join(tmpdir(), "amem-main-"))
  const proc = Bun.spawn(["bun", "mcp-server/main.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, AGENT_MEMORY_HOME: home },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const send = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + "\n")
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  proc.stdin.flush()

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !buf.includes('"tools"')) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
    ])
    if (done && !value) break
    if (value) buf += decoder.decode(value)
  }
  proc.kill()
  expect(buf).toContain('"serverInfo"')
  expect(buf).toContain("agent-memory")
  expect(buf).toContain("search_memory")
}, 15_000)
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test mcp-server/main.test.ts` → FAIL (main.ts missing / no output).

- [ ] **Step 3: Implement**

`mcp-server/main.ts`:
```ts
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "../shared/config"
import { MemoryIndex } from "../distiller/ledger"
import { buildServer } from "./server"

if (import.meta.main) {
  const cfg = loadConfig()
  mkdirSync(cfg.storeDir, { recursive: true })
  const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
  const server = buildServer({ index, storeDir: cfg.storeDir })
  const shutdown = () => {
    index.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  await server.connect(new StdioServerTransport())
  console.error(`agent-memory mcp server ready (store: ${cfg.storeDir})`)
}
```

`mcp-server/probe.ts`:
```ts
// Dev/verification probe: query the real store through the actual MCP server
// (in-memory transport). Usage: bun mcp-server/probe.ts <query> [--project p] | --stats
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { loadConfig } from "../shared/config"
import { MemoryIndex } from "../distiller/ledger"
import { buildServer } from "./server"

const args = process.argv.slice(2)
const cfg = loadConfig()
mkdirSync(cfg.storeDir, { recursive: true })
const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
const server = buildServer({ index, storeDir: cfg.storeDir })
const [ct, st] = InMemoryTransport.createLinkedPair()
await server.connect(st)
const client = new Client({ name: "probe", version: "0.0.1" })
await client.connect(ct)

let res: unknown
if (args[0] === "--stats") {
  res = await client.callTool({ name: "memory_stats", arguments: {} })
} else {
  const query = args[0]
  if (!query) {
    console.error("usage: bun mcp-server/probe.ts <query> [--project p] | --stats")
    process.exit(1)
  }
  const pi = args.indexOf("--project")
  const project = pi >= 0 ? args[pi + 1] : undefined
  res = await client.callTool({ name: "search_memory", arguments: { query, project } })
}
console.log((res as { content: Array<{ text: string }> }).content[0]?.text ?? "no content")
index.close()
process.exit(0)
```

`package.json` scripts: add `"mcp": "bun mcp-server/main.ts"`, `"mcp:probe": "bun mcp-server/probe.ts"`.

- [ ] **Step 4: Run tests + probe smoke**

Run: `bun test mcp-server/main.test.ts && bun run typecheck && bun test`
Then: `AGENT_MEMORY_HOME=$(mktemp -d) bun run mcp:probe --stats` → prints a JSON stats object (empty store), exit 0.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/main.ts mcp-server/probe.ts mcp-server/main.test.ts package.json
git commit -m "feat(mcp): stdio entry, probe cli, and spawn smoke test"
```

---

### Task 4: registration docs + VERIFY

**Files:**
- Modify: `README.md`, `LLM_WIKI.md`
- Create: `docs/superpowers/VERIFY-mcp.md`

- [ ] **Step 1: README.md — "MCP Server" section**

Cover: the four tools (table: name, args, what it returns, when an agent should call it); registration in **opencode** (global `~/.config/opencode/opencode.json`):
```json
{
  "mcp": {
    "agent-memory": {
      "type": "local",
      "command": ["bun", "/ABSOLUTE/PATH/TO/opencode-agent-memory/mcp-server/main.ts"]
    }
  }
}
```
(field shapes verified against @opencode-ai/sdk McpLocalConfig: `type: "local"`, `command: string[]`, optional `environment`); registration in **Claude Code**: `claude mcp add agent-memory -- bun /ABSOLUTE/PATH/mcp-server/main.ts`; the probe CLI for verification without any MCP host (`bun run mcp:probe "<query>"`, `--stats`); concurrency note (WAL + busy_timeout; distiller cron and server can coexist); read-only guarantee.

- [ ] **Step 2: LLM_WIKI.md — 繁中 mcp-server 章節**

架構（query 層 / server 層 / stdio 入口）、四個 tool 與預設過濾（active + confidence ≥ 0.5、`include_tentative` 例外）、排序公式（bm25 + confidence + 30 天 recency boost）、註冊方式（opencode / Claude Code / probe）、已知注意事項（stdout 是協定通道 log 全走 stderr、access 統計是唯一寫入、index.db 併發靠 WAL + busy_timeout、CJK 查詢受 FTS tokenizer 限制）。

- [ ] **Step 3: `docs/superpowers/VERIFY-mcp.md`**

```markdown
# VERIFY — mcp-server (Plan 3)

Status: PENDING

Headless items (executor MUST run these, not defer):
1. `bun test` — all green.
2. `bun run typecheck` — clean.
3. Real-store probe: `bun run mcp:probe --stats` → JSON with the real store's
   counts (10+ active memories from Plan 2's run).
4. Real-store search: `bun run mcp:probe "opencode plugin"` → at least one hit
   from the test_folder memories with sensible lesson text.
5. Access recording: run item 4 twice, then
   `sqlite3 ~/.agent-memory/store/index.db "SELECT id, access_count FROM memories WHERE access_count > 0"`
   → returned ids show access_count >= 2.

Interactive items (user):
6. Register in opencode (opencode.json mcp block per README), restart, ask the
   agent: "search our engineering memory for SPEF" (or any known topic) → agent
   calls search_memory and cites a stored lesson.
7. Optional: register in Claude Code and repeat.
```

- [ ] **Step 4: Gates**

Run: `bun test && bun run typecheck` — green (docs-only).

- [ ] **Step 5: Commit**

```bash
git add README.md LLM_WIKI.md docs/superpowers/VERIFY-mcp.md
git commit -m "docs: mcp server registration, tool reference, and verification checklist"
```
