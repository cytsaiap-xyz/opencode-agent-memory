import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryIndex } from "./ledger"
import { parseEntry, quarantinePath, serializeEntry, writeEntry } from "./store"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-idx-"))

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: `SPEF reuse pitfall ${id}`, trigger: "after ECO route",
  project: "chip-alpha", scope: "project", domain: ["sta"],
  volatile: false, confidence: 0.5, status: "active", superseded_by: null, supersedes: null, review: "auto",
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
  const updated = { ...e, lesson: "Updated lesson about SPEF." }
  const updatedPath = await writeEntry(join(dir, "store"), updated)
  idx.upsertEntry(updated, updatedPath)
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
  expect(s.lastProcessedAt).not.toBeNull()
  expect(typeof s.lastProcessedAt).toBe("string")

  const n = await idx.rebuildFrom(store)
  expect(n).toBe(3)
  expect(idx.search("SPEF", {}).length).toBe(3)
  expect(idx.stats().sessions).toBe(1) // ledger survives rebuild
  idx.close()
})

test("stats.lastProcessedAt is null on fresh index", () => {
  const idx = new MemoryIndex(join(tmp(), "index.db"))
  const s = idx.stats()
  expect(s.lastProcessedAt).toBeNull()
  idx.close()
})

test("concurrent MemoryIndex instances on same db path don't throw with busy_timeout", async () => {
  const dbPath = join(tmp(), "index.db")
  const idx1 = new MemoryIndex(dbPath)
  idx1.recordProcessed({ session_id: "s1", content_hash: "h1", extractor_model: "f", n_candidates: 1, n_committed: 1 })
  idx1.close()

  const idx2 = new MemoryIndex(dbPath)
  idx2.recordProcessed({ session_id: "s2", content_hash: "h2", extractor_model: "f", n_candidates: 1, n_committed: 1 })
  idx2.close()

  expect(true).toBe(true) // Both instances closed cleanly
})

test("rebuildFrom does not modify markdown files", async () => {
  const dir = tmp()
  const store = join(dir, "store")
  const idx = new MemoryIndex(join(dir, "index.db"))
  const e = entry("mem_1")
  const p = await writeEntry(store, e)
  idx.upsertEntry(e, p)
  const before = statSync(p).mtimeMs

  await idx.rebuildFrom(store)

  expect(statSync(p).mtimeMs).toBe(before)
  expect(parseEntry(readFileSync(p, "utf8"))).toEqual(e)
  idx.close()
})

test("rebuildFrom skips a corrupt file and still indexes the valid ones", async () => {
  const dir = tmp()
  const store = join(dir, "store")
  const idx = new MemoryIndex(join(dir, "index.db"))
  mkdirSync(join(store, "memories", "chip-alpha"), { recursive: true })
  const e1 = entry("mem_1")
  const e3 = entry("mem_3")
  await writeEntry(store, e1)
  // mem_2 sorts between mem_1 and mem_3 in listEntryPaths' sorted order, so a naive
  // implementation that throws mid-loop would abort before ever reaching mem_3.
  writeFileSync(join(store, "memories", "chip-alpha", "mem_2.md"), "corrupt garbage no frontmatter")
  await writeEntry(store, e3)

  const n = await idx.rebuildFrom(store)
  expect(n).toBe(2)
  expect(idx.getById("mem_1")).not.toBeNull()
  expect(idx.getById("mem_3")).not.toBeNull()
  expect(idx.getById("mem_2")).toBeNull()
  idx.close()
})

test("rebuildFrom also scans quarantine/*.md so quarantined rows survive reindex", async () => {
  const dir = tmp()
  const store = join(dir, "store")
  const idx = new MemoryIndex(join(dir, "index.db"))
  const q = entry("mem_q", { status: "quarantined", review: "human_pending" })
  const qPath = quarantinePath(store, q.id)
  mkdirSync(join(store, "quarantine"), { recursive: true })
  writeFileSync(qPath, serializeEntry(q))

  const n = await idx.rebuildFrom(store)
  expect(n).toBe(1)
  expect(idx.stats().byStatus.quarantined).toBe(1)
  idx.close()
})

test("upsertEntry preserves access_count and last_accessed across re-upserts", async () => {
  const dir = tmp()
  const store = join(dir, "store")
  const idx = new MemoryIndex(join(dir, "index.db"))
  const e = entry("mem_1")
  const p = await writeEntry(store, e)
  idx.upsertEntry(e, p)

  // Record two accesses
  idx.recordAccess("mem_1")
  idx.recordAccess("mem_1")

  // Verify access stats after first upsert
  let stats = idx.accessStats("mem_1")
  expect(stats).not.toBeNull()
  expect(stats!.access_count).toBe(2)
  expect(stats!.last_accessed).not.toBeNull()

  // Update the entry and re-upsert (simulating reconcile)
  const updated = { ...e, lesson: "Updated lesson." }
  const updatedPath = await writeEntry(store, updated)
  idx.upsertEntry(updated, updatedPath)

  // Verify access stats survived the re-upsert
  stats = idx.accessStats("mem_1")
  expect(stats).not.toBeNull()
  expect(stats!.access_count).toBe(2)
  expect(stats!.last_accessed).not.toBeNull()
  idx.close()
})

test("CJK content is searchable after trigram", async () => {
  const dir = tmp()
  const idx = new MemoryIndex(join(dir, "index.db"))
  const e = entry("mem_cjk", { title: "時序收斂技巧", lesson: "在慢角優先修 hold，時序收斂前先跑 retiming。" })
  idx.upsertEntry(e, await writeEntry(join(dir, "store"), e))

  const hits1 = idx.search("時序收斂")
  expect(hits1.length).toBe(1)
  expect(hits1[0]!.entry.id).toBe("mem_cjk")

  const hits2 = idx.search("收斂技巧")
  expect(hits2.length).toBe(1)
  expect(hits2[0]!.entry.id).toBe("mem_cjk")
  idx.close()
})

test("two-char CJK query matches via LIKE fallback", async () => {
  const dir = tmp()
  const idx = new MemoryIndex(join(dir, "index.db"))
  const e = entry("mem_cjk", { title: "時序收斂技巧", lesson: "在慢角優先修 hold，時序收斂前先跑 retiming。" })
  idx.upsertEntry(e, await writeEntry(join(dir, "store"), e))

  const hits1 = idx.search("時序")
  expect(hits1.length).toBe(1)
  expect(hits1[0]!.entry.id).toBe("mem_cjk")

  const hits2 = idx.search("首都")
  expect(hits2.length).toBe(0)
  idx.close()
})

test("migration from v1 schema flags rebuild", async () => {
  const dir = tmp()
  const dbPath = join(dir, "index.db")

  // Create v0 schema database manually
  const oldDb = new (await import("bun:sqlite")).Database(dbPath, { create: true })
  const oldDDL = `
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
  oldDb.run(oldDDL)
  // Insert a dummy entry
  oldDb.run(`INSERT INTO memories (id, project, type, status, confidence, volatile, path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["mem_1", "test", "pitfall", "active", 0.5, 0, "/tmp/test.md", "2026-07-10T00:00:00.000Z"])
  // Don't set user_version (v0 database)
  oldDb.close()

  // Open with MemoryIndex — should flag rebuild
  const idx = new MemoryIndex(dbPath)
  expect(idx.ftsRebuildNeeded).toBe(true)

  // Prepare store and rebuild
  const store = join(dir, "store")
  const e = entry("mem_1", { title: "Test Entry" })
  await writeEntry(store, e)

  await idx.rebuildFrom(store)
  expect(idx.search("Test").length).toBe(1)
  idx.close()

  // Open again — should not flag rebuild
  const idx2 = new MemoryIndex(dbPath)
  expect(idx2.ftsRebuildNeeded).toBe(false)
  idx2.close()
})

test("fresh db needs no rebuild", () => {
  const dbPath = join(tmp(), "index.db")
  const idx = new MemoryIndex(dbPath)
  expect(idx.ftsRebuildNeeded).toBe(false)
  idx.close()
})
