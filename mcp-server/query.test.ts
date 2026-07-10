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
  domain: ["sta"], volatile: false, confidence: 0.65, status: "active", superseded_by: null, supersedes: null,
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
  mkdirSync(storeDir, { recursive: true })
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

test("searchMemory: relevance stays primary — dense strong match beats diluted high-confidence match", async () => {
  const { index } = await setup([
    entry("mem_strong", {
      confidence: 0.5,
      updated_at: "2026-01-01T00:00:00.000Z", // stale
      title: "parasitics note",
      trigger: "after ECO",
      lesson: "Parasitics parasitics parasitics matter a lot for timing sign-off during STA convergence checks.",
    }),
    entry("mem_b", {
      confidence: 0.65,
      updated_at: "2026-06-01T00:00:00.000Z",
      title: "unrelated note about routing congestion",
      trigger: "after floorplan change",
      lesson:
        "Routing congestion fix unrelated to parasitics topic here mentions it once only for filler " +
        "purposes in this short note about congestion near the die edge macros.",
    }),
    entry("mem_c", {
      confidence: 0.65,
      updated_at: "2026-06-01T00:00:00.000Z",
      title: "clock tree synthesis note",
      trigger: "after CTS run",
      lesson:
        "Clock tree synthesis buffer sizing guidance completely unrelated except mentioning parasitics once " +
        "here as filler text for this note about CTS buffers and skew targets.",
    }),
    entry("mem_weak", {
      confidence: 0.95,
      updated_at: "2026-07-09T00:00:00.000Z", // recent
      title: "quarterly review meeting notes summary",
      trigger: "weekly sync",
      lesson:
        "Team discussed roadmap priorities, staffing plans, budget allocation, vendor negotiations, office " +
        "relocation timeline, holiday schedule, onboarding process improvements, and one attendee briefly " +
        "mentioned parasitics in passing during an unrelated tangent about lab equipment calibration " +
        "procedures and vendor support contracts renewal timeline for next fiscal year planning cycle.",
    }),
  ])
  const hits = searchMemory(index, { query: "parasitics" }, NOW)
  expect(hits[0]!.id).toBe("mem_strong")
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

test("searchMemory: internal fetch pool grows with limit so 31-50 are honorable", async () => {
  const entries = Array.from({ length: 40 }, (_, i) => entry(`mem_${i}`))
  const { index } = await setup(entries)
  // Previously the internal index.search() fetch was hardcoded to 30, so no requested
  // limit above 30 could ever be satisfied even when enough matches existed.
  expect(searchMemory(index, { query: "SPEF", limit: 40 }, NOW).length).toBe(40)
})

test("searchMemory: recordAccess failures (e.g. SQLITE_BUSY) are swallowed, results still returned", async () => {
  const { index } = await setup([entry("mem_a")])
  index.recordAccess = () => {
    throw new Error("SQLITE_BUSY")
  }
  const hits = searchMemory(index, { query: "SPEF" }, NOW)
  expect(hits.map((h) => h.id)).toEqual(["mem_a"])
})

test("getMemory returns full entry with path and records access; null on miss", async () => {
  const { index } = await setup([entry("mem_a", { notes: ["a note"] })])
  const got = getMemory(index, "mem_a")
  expect(got!.notes).toEqual(["a note"])
  expect(got!.path.endsWith("mem_a.md")).toBe(true)
  expect(index.accessStats("mem_a")!.access_count).toBe(1)
  expect(getMemory(index, "mem_nope")).toBeNull()
})

test("getMemory: recordAccess failures (e.g. SQLITE_BUSY) are swallowed, entry still returned", async () => {
  const { index } = await setup([entry("mem_a")])
  index.recordAccess = () => {
    throw new Error("SQLITE_BUSY")
  }
  const got = getMemory(index, "mem_a")
  expect(got!.id).toBe("mem_a")
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
