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
  supersedes: null,
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
    // defect 1: a "## Notes" heading mid-lesson with no trailing bullets is not a real
    // notes section, so it must stay part of the lesson verbatim.
    entry({ lesson: "Header line\n## Notes\nstill lesson text here", notes: [] }),
    // defect 1: "\n## Notes\n" can also appear mid-lesson while a *real* notes section
    // (anchored bullets at the end) still exists — both must parse correctly.
    entry({
      lesson:
        "Intro text.\n## Notes\nThis part is still lesson, not notes, since no bullets follow immediately after it.",
      notes: ["note one"],
    }),
    // defect 2: a raw-safe string that would be sniffed as a JSON scalar by the parser
    // (all-digits, leading "-digit", or true/false/null) must still round-trip as a string.
    entry({ title: "123" }),
    entry({ title: "true" }),
    entry({ trigger: "-42" }),
    entry({ supersedes: "mem_target" }),
  ]
  for (const e of entries) expect(parseEntry(serializeEntry(e))).toEqual(e)
})

test("defect 3: lesson whitespace is normalized (trimmed) on both write and read", () => {
  const e = entry({ lesson: "  padded  " })
  const parsed = parseEntry(serializeEntry(e))
  expect(parsed.lesson).toBe("padded")
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

test("parseEntry defaults missing supersedes to null (legacy files)", () => {
  const serialized = serializeEntry(entry())
  const legacy = serialized.replace(/^supersedes: .*$/m, "")
  const parsed = parseEntry(legacy)
  expect(parsed.supersedes).toBe(null)
  expect(parsed).toEqual({ ...entry(), supersedes: null })
})

test("parseEntry rejects wrong-typed supersedes", () => {
  const bad = serializeEntry(entry()).replace(/^supersedes: .*$/m, "supersedes: 42")
  expect(() => parseEntry(bad)).toThrow(/supersedes/)
})

test("computeConfidence follows the spec formula with clamping", () => {
  expect(computeConfidence({ sessions: 1, humanApproved: false, contradicted: false })).toBe(0.5)
  expect(computeConfidence({ sessions: 3, humanApproved: false, contradicted: false })).toBe(0.8)
  expect(computeConfidence({ sessions: 1, humanApproved: true, contradicted: false })).toBe(0.7)
  expect(computeConfidence({ sessions: 1, humanApproved: false, contradicted: true })).toBe(0.25)
  expect(computeConfidence({ sessions: 9, humanApproved: true, contradicted: false })).toBe(0.95)
  expect(computeConfidence({ sessions: 1, humanApproved: false, contradicted: true }) >= 0.1).toBe(true)
})
