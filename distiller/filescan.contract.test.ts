import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { openMemoryIndex } from "./indexes"
import type { MemoryQuery } from "./indexes"
import { quarantinePath, serializeEntry, writeEntry } from "./store"
import type { MemoryEntry } from "./types"
import { PIPELINE_VERSION } from "./types"

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

    test("ledger: isProcessed false before recordProcessed, true after; different hash stays false", () => {
      expect(idx.ledger.isProcessed("ses_1", "hash_a")).toBe(false)

      idx.ledger.recordProcessed({ session_id: "ses_1", content_hash: "hash_a", extractor_model: "gpt-x", n_candidates: 3, n_committed: 2 })

      expect(idx.ledger.isProcessed("ses_1", "hash_a")).toBe(true)
      expect(idx.ledger.isProcessed("ses_1", "hash_b")).toBe(false)
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

  // Carry-forward from Task 3 review: production writes quarantined entries via
  // quarantinePath() + fs directly (see distiller/quarantine.ts), never through
  // writeEntry. Assert the filescan index sees files written that same way.
  test("an entry written directly into quarantine/ (mirroring production's quarantine write path) is visible via getById/search/stats", () => {
    const e = entry("mem_q1", { status: "quarantined" })
    const path = quarantinePath(dir, e.id)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, serializeEntry(e))

    expect(idx.getById("mem_q1")?.entry.id).toBe("mem_q1")
    expect(idx.search("SPEF").some((h) => h.entry.id === "mem_q1")).toBe(true)
    expect(idx.stats().byStatus.quarantined).toBe(1)
  })

  test("ledger.jsonl has one valid JSON line per record with all required fields", () => {
    idx.ledger.recordProcessed({ session_id: "ses_1", content_hash: "hash_a", extractor_model: "gpt-x", n_candidates: 3, n_committed: 2 })
    idx.ledger.recordProcessed({ session_id: "ses_2", content_hash: "hash_b", extractor_model: "gpt-x", n_candidates: 1, n_committed: 1 })

    const raw = readFileSync(join(dir, "ledger.jsonl"), "utf8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(2)
    for (const line of lines) {
      const rec = JSON.parse(line)
      expect(typeof rec.session_id).toBe("string")
      expect(typeof rec.content_hash).toBe("string")
      expect(rec.pipeline_version).toBe(PIPELINE_VERSION)
      expect(typeof rec.extractor_model).toBe("string")
      expect(typeof rec.processed_at).toBe("string")
      expect(typeof rec.n_candidates).toBe("number")
      expect(typeof rec.n_committed).toBe("number")
    }
  })

  test("a torn last line in ledger.jsonl is tolerated by a fresh FileScanIndex over the same storeDir", () => {
    idx.ledger.recordProcessed({ session_id: "ses_1", content_hash: "hash_a", extractor_model: "gpt-x", n_candidates: 1, n_committed: 1 })
    appendFileSync(join(dir, "ledger.jsonl"), '{"session_id":"x')

    const fresh = openMemoryIndex(dir, { ok: false, reason: "test" }, { warn: () => {} })
    expect(() => fresh.ledger.isProcessed("ses_1", "hash_a")).not.toThrow()
    expect(fresh.ledger.isProcessed("ses_1", "hash_a")).toBe(true)
    fresh.close()
  })

  test("a second FileScanIndex instance over the same storeDir sees prior recordProcessed calls (persistence)", () => {
    idx.ledger.recordProcessed({ session_id: "ses_1", content_hash: "hash_a", extractor_model: "gpt-x", n_candidates: 1, n_committed: 1 })

    const second = openMemoryIndex(dir, { ok: false, reason: "test" }, { warn: () => {} })
    expect(second.ledger.isProcessed("ses_1", "hash_a")).toBe(true)
    second.close()
  })

  test("stats().sessions and lastProcessedAt reflect ledger records", () => {
    expect(idx.stats().sessions).toBe(0)
    expect(idx.stats().lastProcessedAt).toBeNull()

    idx.ledger.recordProcessed({ session_id: "ses_1", content_hash: "hash_a", extractor_model: "gpt-x", n_candidates: 1, n_committed: 1 })
    idx.ledger.recordProcessed({ session_id: "ses_2", content_hash: "hash_b", extractor_model: "gpt-x", n_candidates: 1, n_committed: 1 })

    const s = idx.stats()
    expect(s.sessions).toBe(2)
    expect(s.lastProcessedAt).not.toBeNull()
  })

  // Carry-forward from Task 4 review: a long-lived process (mcp-server) holds a
  // FileLedger whose lazy-loaded Set can go stale if the nightly distiller — a
  // SEPARATE process — appends to ledger.jsonl in the background. Instance A must
  // pick up instance B's writes on its NEXT isProcessed()/stats() call, not just on
  // fresh construction (that was already covered by the "second instance sees prior
  // writes" test above — this one is about an instance that was ALREADY loaded
  // before the external write happened).
  test("an already-loaded instance sees a record written by a second instance afterward (mtime-triggered reload)", () => {
    // Force instance A (idx, from beforeEach) to load and cache its (empty) state.
    expect(idx.stats().sessions).toBe(0)
    expect(idx.ledger.isProcessed("ses_ext", "hash_ext")).toBe(false)

    // A second instance over the same storeDir — simulating a separate process —
    // writes a record instance A never saw.
    const writer = openMemoryIndex(dir, { ok: false, reason: "test" }, { warn: () => {} })
    writer.ledger.recordProcessed({ session_id: "ses_ext", content_hash: "hash_ext", extractor_model: "gpt-x", n_candidates: 1, n_committed: 1 })
    writer.close()

    // Instance A (already loaded, never reconstructed) must see the external write
    // on its next call — both isProcessed() and stats().
    expect(idx.ledger.isProcessed("ses_ext", "hash_ext")).toBe(true)
    expect(idx.stats().sessions).toBe(1)
    expect(idx.stats().lastProcessedAt).not.toBeNull()
  })
})
