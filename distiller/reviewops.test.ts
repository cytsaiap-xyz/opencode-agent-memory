import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openMemoryIndex } from "./indexes"
import type { MemoryQuery } from "./indexes"
import { approveEntry, rejectEntry } from "./reviewops"
import { entryPath, quarantinePath, serializeEntry } from "./store"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-review-"))

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: "Pending Lesson", trigger: "when x", project: "proja", scope: "project",
  domain: ["d"], volatile: false, confidence: 0.5, status: "quarantined", superseded_by: null, supersedes: null,
  review: "human_pending",
  evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-11T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z",
  lesson: "lesson body", notes: [],
  ...over,
})

const setup = () => {
  const dir = tmp()
  const storeDir = join(dir, "store")
  mkdirSync(storeDir, { recursive: true })
  const index = openMemoryIndex(storeDir, { ok: true })
  return { storeDir, index }
}

const seedQuarantined = (storeDir: string, index: MemoryQuery, e: MemoryEntry): string => {
  const path = quarantinePath(storeDir, e.id)
  mkdirSync(join(storeDir, "quarantine"), { recursive: true })
  writeFileSync(path, serializeEntry(e))
  index.upsertEntry(e, path)
  return path
}

const seedActive = (storeDir: string, index: MemoryQuery, e: MemoryEntry): string => {
  const path = entryPath(storeDir, e)
  mkdirSync(join(storeDir, "memories", e.project), { recursive: true })
  writeFileSync(path, serializeEntry(e))
  index.upsertEntry(e, path)
  return path
}

const now = new Date("2026-07-11T02:00:00.000Z")

test("approve moves quarantined entry into memories/, activates it, and it is searchable", async () => {
  const { storeDir, index } = setup()
  const id = "mem_20260711_aaaaaa"
  const qPath = seedQuarantined(storeDir, index, entry(id))

  const result = await approveEntry(storeDir, index, id, now)

  expect(result.entry.status).toBe("active")
  expect(result.entry.review).toBe("human_approved")
  expect(result.entry.confidence).toBe(0.7)
  expect(result.movedTo).toBe(entryPath(storeDir, result.entry))
  expect(existsSync(qPath)).toBe(false)
  expect(existsSync(result.movedTo!)).toBe(true)
  expect(result.entry.notes.at(-1)).toContain("approved by human")

  const hits = index.search("Pending Lesson", { status: "active" })
  expect(hits.some((h) => h.entry.id === id)).toBe(true)
})

test("approve with supersedes tombstones the target with the final approved id", async () => {
  const { storeDir, index } = setup()
  const targetId = "mem_20260711_target1"
  seedActive(storeDir, index, entry(targetId, {
    type: "decision", status: "active", review: "auto", supersedes: null,
  }))

  const id = "mem_20260711_bbbbbb"
  seedQuarantined(storeDir, index, entry(id, { supersedes: targetId }))

  const result = await approveEntry(storeDir, index, id, now)

  expect(result.entry.status).toBe("active")
  expect(result.supersededTarget).toBe(targetId)
  expect(result.warning).toBeUndefined()

  const targetHit = index.getById(targetId)
  expect(targetHit).not.toBeNull()
  expect(targetHit!.entry.status).toBe("superseded")
  expect(targetHit!.entry.superseded_by).toBe(result.entry.id)
})

test("approve with missing supersedes target sets a warning and does not throw", async () => {
  const { storeDir, index } = setup()
  const id = "mem_20260711_cccccc"
  seedQuarantined(storeDir, index, entry(id, { supersedes: "mem_does_not_exist" }))

  const result = await approveEntry(storeDir, index, id, now)

  expect(result.entry.status).toBe("active")
  expect(result.supersededTarget).toBeNull()
  expect(result.warning).toMatch(/mem_does_not_exist/)
  expect(result.warning).toMatch(/not found/)
})

test("approve id collision uniquifies with -2 suffix, leaving the original untouched", async () => {
  const { storeDir, index } = setup()
  const id = "mem_20260711_dddddd"
  // A file already occupies the destination path (e.g. an active memory the index has
  // since lost track of — the realistic drift case the "file exists" collision check
  // guards against; a live index row can never coexist under the same id, since ids are
  // the sqlite primary key). This must survive approveEntry completely untouched.
  const activeEntry = entry(id, { status: "active", review: "auto", title: "Original Active Entry" })
  const activePath = entryPath(storeDir, activeEntry)
  mkdirSync(join(storeDir, "memories", activeEntry.project), { recursive: true })
  writeFileSync(activePath, serializeEntry(activeEntry))

  seedQuarantined(storeDir, index, entry(id, { title: "Newly Approved Entry" }))

  const result = await approveEntry(storeDir, index, id, now)

  expect(result.entry.id).toBe(`${id}-2`)
  expect(result.entry.title).toBe("Newly Approved Entry")

  // Original file on disk is byte-for-byte untouched.
  expect(existsSync(activePath)).toBe(true)
  expect(Bun.file(activePath).text()).resolves.toBe(serializeEntry(activeEntry))

  const renamedHit = index.getById(`${id}-2`)
  expect(renamedHit).not.toBeNull()
  expect(renamedHit!.entry.status).toBe("active")
  expect(existsSync(entryPath(storeDir, { ...entry(id), id: `${id}-2` }))).toBe(true)
})

test("reject archives the entry in place with a dated reason note", async () => {
  const { storeDir, index } = setup()
  const id = "mem_20260711_eeeeee"
  const qPath = seedQuarantined(storeDir, index, entry(id))

  const rejected = await rejectEntry(storeDir, index, id, "duplicate of mem_x", now)

  expect(rejected.status).toBe("archived")
  expect(rejected.notes.at(-1)).toContain("rejected by human")
  expect(rejected.notes.at(-1)).toContain("duplicate of mem_x")
  expect(existsSync(qPath)).toBe(true)

  const hits = index.search("Pending Lesson", { status: "active" })
  expect(hits.some((h) => h.entry.id === id)).toBe(false)
})

test("guards: unknown id, approving an active entry, and rejecting twice all throw not-pending/not-found", async () => {
  const { storeDir, index } = setup()

  await expect(approveEntry(storeDir, index, "mem_nope", now)).rejects.toThrow(/not found/)
  await expect(rejectEntry(storeDir, index, "mem_nope", undefined, now)).rejects.toThrow(/not found/)

  const activeId = "mem_20260711_ffffff"
  seedActive(storeDir, index, entry(activeId, { status: "active", review: "auto" }))
  await expect(approveEntry(storeDir, index, activeId, now)).rejects.toThrow(/not pending/)

  const rejectId = "mem_20260711_gggggg"
  seedQuarantined(storeDir, index, entry(rejectId))
  await rejectEntry(storeDir, index, rejectId, "first reject", now)
  await expect(rejectEntry(storeDir, index, rejectId, "second reject", now)).rejects.toThrow(/not pending/)
})
