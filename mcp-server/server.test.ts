import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { openMemoryIndex } from "../distiller/indexes"
import { writeEntry, serializeEntry, readEntry } from "../distiller/store"
import type { MemoryEntry } from "../distiller/types"
import { buildServer } from "./server"

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: `SPEF pitfall ${id}`, trigger: "after ECO", project: "proja", scope: "project",
  domain: ["sta"], volatile: false, confidence: 0.65, status: "active", superseded_by: null, supersedes: null,
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
  mkdirSync(storeDir, { recursive: true })
  const index = openMemoryIndex(storeDir, { ok: true })
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
  expect(stats.mode).toBe("sqlite")
  expect(stats.accessAvailable).toBe(true)
})

test("server is read-only over the store content", async () => {
  const { client, path, entryA } = await setup()
  await client.callTool({ name: "search_memory", arguments: { query: "SPEF" } })
  await client.callTool({ name: "get_memory", arguments: { id: "mem_a" } })
  expect(await readEntry(path)).toEqual(entryA) // markdown untouched (access stats live in index.db only)
})
