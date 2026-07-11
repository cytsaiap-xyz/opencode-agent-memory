import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openMemoryIndex } from "./indexes"
import { quarantinePath, serializeEntry } from "./store"
import { writeQuarantineEntry } from "./quarantine"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-quar-"))

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: "Some Secret", trigger: "when x", project: "proja", scope: "project",
  domain: ["d"], volatile: false, confidence: 0.5, status: "quarantined", superseded_by: null, supersedes: null, promoted_from: null,
  review: "human_pending",
  evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-11T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z",
  lesson: "lesson", notes: [],
  ...over,
})

const setup = () => {
  const dir = tmp()
  const storeDir = join(dir, "store")
  mkdirSync(storeDir, { recursive: true })
  const index = openMemoryIndex(storeDir, { ok: true })
  return { storeDir, index }
}

test("writes entry to quarantine and upserts index when id is fresh", async () => {
  const { storeDir, index } = setup()
  const e = entry("mem_20260711_aaaaaa")
  const result = await writeQuarantineEntry(storeDir, index, e)
  expect(result.id).toBe("mem_20260711_aaaaaa")
  expect(existsSync(quarantinePath(storeDir, "mem_20260711_aaaaaa"))).toBe(true)
  const hit = index.getById("mem_20260711_aaaaaa")
  expect(hit).not.toBeNull()
  expect(hit!.entry.title).toBe("Some Secret")
})

test("uniquifies against an existing quarantine file on disk", async () => {
  const { storeDir, index } = setup()
  const id = "mem_20260711_bbbbbb"
  // Pre-existing quarantine file NOT known to the index (simulates a stray/transitional file).
  mkdirSync(join(storeDir, "quarantine"), { recursive: true })
  writeFileSync(quarantinePath(storeDir, id), serializeEntry(entry(id)))

  const e = entry(id, { title: "Another Secret" })
  const result = await writeQuarantineEntry(storeDir, index, e)
  expect(result.id).toBe(`${id}-2`)
  expect(existsSync(quarantinePath(storeDir, `${id}-2`))).toBe(true)
  const hit = index.getById(`${id}-2`)
  expect(hit).not.toBeNull()
  expect(hit!.entry.title).toBe("Another Secret")
})

test("uniquifies against an id already known to the index (e.g. an active memory)", async () => {
  const { storeDir, index } = setup()
  const id = "mem_20260711_cccccc"
  const active = entry(id, { status: "active", review: "auto" })
  const activePath = join(storeDir, "memories", "proja", `${id}.md`)
  mkdirSync(join(storeDir, "memories", "proja"), { recursive: true })
  writeFileSync(activePath, serializeEntry(active))
  index.upsertEntry(active, activePath)

  const e = entry(id, { title: "Secret Colliding With Active" })
  const result = await writeQuarantineEntry(storeDir, index, e)
  expect(result.id).toBe(`${id}-2`)

  // The active entry must remain untouched, still resolving via getById.
  const activeHit = index.getById(id)
  expect(activeHit).not.toBeNull()
  expect(activeHit!.entry.status).toBe("active")
  expect(activeHit!.path).toBe(activePath)

  const quarantineHit = index.getById(`${id}-2`)
  expect(quarantineHit).not.toBeNull()
  expect(quarantineHit!.entry.title).toBe("Secret Colliding With Active")
})
