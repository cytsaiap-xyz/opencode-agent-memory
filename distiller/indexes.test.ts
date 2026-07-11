import { expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openMemoryIndex } from "./indexes"
import { writeEntry } from "./store"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-idx-abstraction-"))

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: `SPEF reuse pitfall ${id}`, trigger: "after ECO route",
  project: "chip-alpha", scope: "project", domain: ["sta"],
  volatile: false, confidence: 0.5, status: "active", superseded_by: null, supersedes: null, promoted_from: null, absorbs: null, review: "auto",
  evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-10T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z",
  lesson: "Re-extract parasitics before STA.", notes: [],
  ...over,
})

test("factory returns sqlite-backed index when probe ok, mode is 'sqlite', db created at storeDir/index.db", async () => {
  const dir = tmp()
  const idx = openMemoryIndex(dir, { ok: true })
  expect(idx.mode).toBe("sqlite")
  expect(existsSync(join(dir, "index.db"))).toBe(true)
  idx.close()
})

test("sqlite wrapper delegates upsert -> search -> getById -> ledger roundtrip against a real tmp store", async () => {
  const dir = tmp()
  const idx = openMemoryIndex(dir, { ok: true })
  const e = entry("mem_1")
  const path = await writeEntry(join(dir, "store"), e)
  idx.upsertEntry(e, path)

  const hits = idx.search("SPEF parasitics")
  expect(hits.map((h) => h.entry.id)).toEqual(["mem_1"])

  const got = idx.getById("mem_1")
  expect(got?.entry.id).toBe("mem_1")
  expect(idx.getById("mem_nope")).toBeNull()

  expect(idx.ledger.isProcessed("ses_1", "sha256:aa")).toBe(false)
  idx.ledger.recordProcessed({ session_id: "ses_1", content_hash: "sha256:aa", extractor_model: "fake", n_candidates: 2, n_committed: 1 })
  expect(idx.ledger.isProcessed("ses_1", "sha256:aa")).toBe(true)

  idx.recordAccess("mem_1")
  const access = idx.accessStats("mem_1")
  expect(access?.access_count).toBe(1)

  const stats = idx.stats()
  expect(stats.accessAvailable).toBe(true)
  expect(stats.byStatus.active).toBe(1)
  expect(stats.sessions).toBe(1)

  idx.removeEntry("mem_1")
  expect(idx.getById("mem_1")).toBeNull()

  idx.close()
})

test("dbPath override is honored: db created at the given path, not storeDir/index.db", () => {
  const dir = tmp()
  const customPath = join(dir, "custom", "somewhere.db")
  const idx = openMemoryIndex(dir, { ok: true }, { dbPath: customPath })
  expect(existsSync(customPath)).toBe(true)
  expect(existsSync(join(dir, "index.db"))).toBe(false)
  idx.close()
})

test("factory returns filescan index + warns exactly once when probe not ok", () => {
  const dir = tmp()
  const warnings: string[] = []
  const idx = openMemoryIndex(dir, { ok: false, reason: "disabled by AGENT_MEMORY_NO_SQLITE" }, { warn: (line) => warnings.push(line) })
  expect(idx.mode).toBe("filescan")
  expect(warnings.length).toBe(1)
  expect(warnings[0]!.startsWith("agent-memory: sqlite unavailable")).toBe(true)
  expect(warnings[0]).toContain("disabled by AGENT_MEMORY_NO_SQLITE")
  idx.close()
})

test("filescan index: search/getById/stats/recordAccess/accessStats/ledger/rebuildFrom are all implemented; close() is a no-op", async () => {
  const dir = tmp()
  const idx = openMemoryIndex(dir, { ok: false, reason: "test" }, { warn: () => {} })
  expect(idx.mode).toBe("filescan")
  expect(() => idx.search("x")).not.toThrow()
  expect(idx.getById("x")).toBeNull()
  expect(() => idx.stats()).not.toThrow()
  expect(() => idx.recordAccess("x")).not.toThrow()
  expect(idx.accessStats("x")).toBeNull()
  expect(idx.ledger.isProcessed("a", "b")).toBe(false)
  idx.ledger.recordProcessed({ session_id: "a", content_hash: "b", extractor_model: "fake", n_candidates: 1, n_committed: 1 })
  expect(idx.ledger.isProcessed("a", "b")).toBe(true)
  expect(await idx.rebuildFrom(dir)).toBe(0) // no-op in filescan mode: returns current entry count, writes nothing
  expect(() => idx.close()).not.toThrow()
})

// Hardening regression: distiller/indexes.ts must not statically value-import ledger.ts
// (whose line 1 is `import { Database } from "bun:sqlite"`), so that a missing/broken
// bun:sqlite native binding can't crash the process before probeSqlite ever runs — the
// lazy require() inside SqliteIndex's constructor (only reached when probe.ok) is what
// makes this possible. We can't simulate an actually-missing bun:sqlite binding from a
// normal test run (it's genuinely present here); that end-to-end proof is VERIFY item 6,
// exercised only in the corporate/no-native-binding environment the spec targets. What we
// *can* prove in-process: the module loads and openMemoryIndex still returns a working
// filescan index — without ever touching sqlite — when probe.ok is false, spawned as a
// fresh subprocess so this test can't be fooled by sqlite already being loaded elsewhere
// in the same process.
test("module loads and openMemoryIndex(..., {ok: false}, ...) returns filescan without touching sqlite (subprocess)", async () => {
  const dir = tmp()
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      `const { openMemoryIndex } = await import("${join(import.meta.dir, "indexes.ts")}");
       const idx = openMemoryIndex(process.argv[1], { ok: false, reason: "t" }, { warn: () => {} });
       console.log(idx.mode);`,
      dir,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe("filescan")
})
