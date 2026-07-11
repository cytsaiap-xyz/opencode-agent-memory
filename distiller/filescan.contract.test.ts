import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openMemoryIndex } from "./indexes"
import type { MemoryQuery } from "./indexes"
import { writeEntry } from "./store"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-filescan-contract-"))

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

// Both MemoryQuery implementations must answer these queries identically — sqlite
// (real probe) and filescan (NO_SQLITE-style probe). Everything in this loop is
// shared semantics; filescan-only behavior (no-cache visibility, corrupt-file
// tolerance, disabled access stats) is asserted separately below.
const modes: Array<{ name: "sqlite" | "filescan"; open: (dir: string) => MemoryQuery }> = [
  { name: "sqlite", open: (dir) => openMemoryIndex(dir, { ok: true }) },
  { name: "filescan", open: (dir) => openMemoryIndex(dir, { ok: false, reason: "test" }, { warn: () => {} }) },
]

for (const mode of modes) {
  describe(`MemoryQuery contract: ${mode.name}`, () => {
    let dir: string
    let idx: MemoryQuery

    beforeEach(() => {
      dir = tmp()
      idx = mode.open(dir)
    })

    afterEach(() => {
      idx.close()
    })

    // writeEntry always puts the file on disk; upsertEntry is additionally called
    // here so the sqlite-backed index picks it up too (filescan: no-op, the file
    // is already visible via the filesystem scan).
    const put = async (e: MemoryEntry): Promise<string> => {
      const path = await writeEntry(dir, e)
      idx.upsertEntry(e, path)
      return path
    }

    test("search finds by keyword; status/minConfidence/project/type filters apply", async () => {
      const e1 = entry("mem_1", { lesson: "Re-extract SPEF parasitics before STA after ECO." })
      const e2 = entry("mem_2", { type: "know_how", title: "Innovus flow tip", lesson: "Use -no_html for faster reports.", domain: ["innovus"] })
      const e3 = entry("mem_3", { status: "superseded", lesson: "Old SPEF advice." })
      const e4 = entry("mem_4", { confidence: 0.3, lesson: "Tentative SPEF hunch." })
      const e5 = entry("mem_5", { project: "chip-beta", lesson: "SPEF notes for chip-beta." })
      for (const e of [e1, e2, e3, e4, e5]) await put(e)

      const hits = idx.search("SPEF parasitics", { status: "active", minConfidence: 0.5 })
      // superseded (mem_3) + low-confidence (mem_4) excluded by the filters; mem_1 and mem_5
      // both survive (every entry's default title includes "SPEF") but mem_1 ranks first
      // since it also matches "parasitics" (higher hit count -> lower/more-negative score).
      expect(hits.map((h) => h.entry.id)).toEqual(["mem_1", "mem_5"])

      expect(idx.search("SPEF", {}).length).toBeGreaterThanOrEqual(3) // no filters sees all SPEF entries

      expect(idx.search("innovus reports", { type: "know_how" })[0]!.entry.id).toBe("mem_2")

      expect(idx.search("SPEF", { project: "chip-beta" }).map((h) => h.entry.id)).toEqual(["mem_5"])
    })

    test("multi-keyword search ranks the entry with more/higher-weighted hits first", async () => {
      const r1 = entry("mem_r1", { title: "Retiming clock skew fix", lesson: "Unrelated content here." })
      const r2 = entry("mem_r2", { title: "Unrelated title", lesson: "Retiming clock skew mentioned once, in passing." })
      for (const e of [r1, r2]) await put(e)

      const hits = idx.search("retiming skew")
      expect(hits.length).toBeGreaterThanOrEqual(2)
      expect(hits[0]!.entry.id).toBe("mem_r1") // both tokens in title (weight 3) beat both in lesson (weight 1)
    })

    test("getById: hit returns the entry, miss returns null", async () => {
      const e = entry("mem_1")
      await put(e)
      expect(idx.getById("mem_1")?.entry.id).toBe("mem_1")
      expect(idx.getById("mem_nope")).toBeNull()
    })

    test("stats counts byStatus/byType", async () => {
      const es = [entry("mem_1"), entry("mem_2", { type: "know_how" }), entry("mem_3", { status: "quarantined" })]
      for (const e of es) await put(e)

      const s = idx.stats()
      expect(s.byStatus.active).toBe(2)
      expect(s.byStatus.quarantined).toBe(1)
      expect(s.byType.pitfall).toBe(2)
      expect(s.byType.know_how).toBe(1)
    })

    test("CJK 2-char query matches a CJK-lesson entry", async () => {
      const e = entry("mem_cjk", { title: "時序收斂技巧", lesson: "在慢角優先修 hold，時序收斂前先跑 retiming。" })
      await put(e)

      const hits = idx.search("時序")
      expect(hits.some((h) => h.entry.id === "mem_cjk")).toBe(true)
    })
  })
}

describe("FileScanIndex-only behavior", () => {
  let dir: string
  let idx: MemoryQuery

  beforeEach(() => {
    dir = tmp()
    idx = openMemoryIndex(dir, { ok: false, reason: "test" }, { warn: () => {} })
  })

  afterEach(() => {
    idx.close()
  })

  test("a corrupt file is skipped by search/getById/stats, valid entries still found", async () => {
    const good = entry("mem_good")
    await writeEntry(dir, good)
    mkdirSync(join(dir, "memories", "chip-alpha"), { recursive: true })
    writeFileSync(join(dir, "memories", "chip-alpha", "mem_bad.md"), "not a valid memory entry, no frontmatter here")

    const hits = idx.search("SPEF")
    expect(hits.map((h) => h.entry.id)).toEqual(["mem_good"])
    expect(idx.getById("mem_bad")).toBeNull()
    expect(idx.stats().byStatus.active).toBe(1)
  })

  test("write-then-search is immediately visible WITHOUT calling upsertEntry (no caching)", async () => {
    const e = entry("mem_1")
    await writeEntry(dir, e) // deliberately no idx.upsertEntry(e, path) call

    expect(idx.search("SPEF").map((h) => h.entry.id)).toEqual(["mem_1"])
    expect(idx.getById("mem_1")?.entry.id).toBe("mem_1")
  })

  test("accessStats is null; recordAccess is a no-op that doesn't throw", async () => {
    const e = entry("mem_1")
    await writeEntry(dir, e)

    expect(() => idx.recordAccess("mem_1")).not.toThrow()
    expect(idx.accessStats("mem_1")).toBeNull()
  })

  test("upsertEntry/removeEntry are no-ops that don't break subsequent reads", async () => {
    const e = entry("mem_1")
    const path = await writeEntry(dir, e)

    expect(() => idx.upsertEntry(e, path)).not.toThrow()
    expect(idx.getById("mem_1")?.entry.id).toBe("mem_1") // file still on disk

    expect(() => idx.removeEntry("mem_1")).not.toThrow()
    expect(idx.getById("mem_1")?.entry.id).toBe("mem_1") // removeEntry doesn't delete the file
  })
})
