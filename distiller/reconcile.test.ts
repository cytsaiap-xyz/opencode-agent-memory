import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmClient } from "./llm"
import { MemoryIndex } from "./ledger"
import { parseReconcileOp, reconcileCandidate } from "./reconcile"
import { entryId, entryPath, readEntry, writeEntry } from "./store"
import type { Candidate } from "./extract"
import type { TranscriptMeta } from "./transcripts"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-rec-"))

const meta: TranscriptMeta = {
  path: "/s/proja/ses_2.md", sessionId: "ses_2", project: "proja",
  contentHash: "sha256:bb", timeEnd: "2026-07-11T00:00:00.000Z", exportedAt: "2026-07-11T01:00:00.000Z",
  title: "t", body: "## T1 [00:00] User {#msg_1}\n\nx\n",
}

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  type: "pitfall", title: "SPEF reuse after ECO", trigger: "after ECO route",
  lesson: "Re-extract parasitics before STA.", domain: ["sta"],
  evidence: [{ message_id: "msg_1" }], salience: 7, volatile: false,
  ...over,
})

const existing = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: "SPEF reuse after ECO", trigger: "after ECO route",
  project: "proja", scope: "project", domain: ["sta"],
  volatile: false, confidence: 0.5, status: "active", superseded_by: null, supersedes: null, review: "auto",
  evidence: [{ session: "ses_1", anchors: ["msg_a"], observed_at: "2026-07-10T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z",
  lesson: "Re-extract parasitics before STA.", notes: [],
  ...over,
})

const fakeLlm = (reply: string): LlmClient => ({ describe: () => "fake", complete: async () => reply })

const setup = async (seed?: MemoryEntry) => {
  const dir = tmp()
  const storeDir = join(dir, "store")
  mkdirSync(storeDir, { recursive: true })
  const index = new MemoryIndex(join(storeDir, "index.db"))
  if (seed) index.upsertEntry(seed, await writeEntry(storeDir, seed))
  return { storeDir, index }
}

const deps = (o: { llm: LlmClient; index: MemoryIndex; storeDir: string }) => ({
  ...o, now: new Date("2026-07-11T02:00:00.000Z"), extractorLabel: "distiller v0.1 / fake", promptHash: "sha256:pp",
})

test("parseReconcileOp validates op and target membership", () => {
  expect(parseReconcileOp('{"op":"ADD"}', ["m1"])) .toEqual({ op: "ADD" })
  expect(parseReconcileOp('{"op":"UPDATE","target_id":"m1","note":"n"}', ["m1"]).op).toBe("UPDATE")
  expect(() => parseReconcileOp('{"op":"UPDATE","target_id":"mX","note":"n"}', ["m1"])).toThrow(/target/)
  expect(() => parseReconcileOp('{"op":"YOLO"}', [])).toThrow(/op/)
  expect(() => parseReconcileOp("garbage", [])).toThrow()
})

test("no neighbors -> ADD without any LLM call", async () => {
  const { storeDir, index } = await setup()
  let called = 0
  const llm: LlmClient = { describe: () => "f", complete: async () => { called++; return '{"op":"ADD"}' } }
  const r = await reconcileCandidate(cand(), meta, deps({ llm, index, storeDir }))
  expect(r.op).toBe("ADD")
  expect(called).toBe(0)
  expect(r.entry!.confidence).toBe(0.5)
  expect(r.entry!.evidence[0]!.session).toBe("ses_2")
  expect(index.search("SPEF").length).toBe(1)
  const onDisk = await readEntry(index.search("SPEF")[0]!.path)
  expect(onDisk.id).toBe(r.entry!.id)
})

test("UPDATE appends evidence + note and raises confidence", async () => {
  const seed = existing("mem_20260710_aaaaaa")
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand(), meta,
    deps({ llm: fakeLlm('{"op":"UPDATE","target_id":"mem_20260710_aaaaaa","note":"confirmed again"}'), index, storeDir }),
  )
  expect(r.op).toBe("UPDATE")
  expect(r.entry!.evidence.length).toBe(2)
  expect(r.entry!.confidence).toBe(0.65)
  expect(r.entry!.notes.some((n) => n.includes("confirmed again"))).toBe(true)
  expect(r.entry!.updated_at).toBe("2026-07-11T02:00:00.000Z")
})

test("UPDATE from another project flags promotion candidate", async () => {
  const seed = existing("mem_20260710_aaaaaa", { project: "projb" })
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand(), meta,
    deps({ llm: fakeLlm('{"op":"UPDATE","target_id":"mem_20260710_aaaaaa","note":"n"}'), index, storeDir }),
  )
  expect(r.entry!.notes.some((n) => n.includes("promotion candidate"))).toBe(true)
})

test("SUPERSEDE creates new entry and tombstones the old one", async () => {
  const seed = existing("mem_20260710_aaaaaa", { lesson: "Old wrong advice." })
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand({ lesson: "New corrected advice." }), meta,
    deps({ llm: fakeLlm('{"op":"SUPERSEDE","target_id":"mem_20260710_aaaaaa","reason":"flow changed"}'), index, storeDir }),
  )
  expect(r.op).toBe("SUPERSEDE")
  const old = index.search("SPEF", { status: "superseded" })
  expect(old.length).toBe(1)
  expect(old[0]!.entry.superseded_by).toBe(r.entry!.id)
  expect(old[0]!.entry.notes.some((n) => n.includes("flow changed"))).toBe(true)
  const active = index.search("SPEF", { status: "active" })
  expect(active.length).toBe(1)
  expect(active[0]!.entry.lesson).toBe("New corrected advice.")
})

test("SUPERSEDE against decision-type target is intercepted into review queue", async () => {
  const seed = existing("mem_20260710_aaaaaa", {
    type: "decision", title: "Ban useful-skew", trigger: "clock tree", lesson: "Never use useful skew.",
  })
  const { storeDir, index } = await setup(seed)
  const before = await readEntry(entryPath(storeDir, seed))
  const r = await reconcileCandidate(
    cand({ type: "decision", title: "Ban useful-skew", trigger: "clock tree", lesson: "Useful skew is now allowed." }),
    meta,
    deps({
      llm: fakeLlm('{"op":"SUPERSEDE","target_id":"mem_20260710_aaaaaa","reason":"process improved"}'),
      index, storeDir,
    }),
  )
  expect(r.op).toBe("SUPERSEDE_PENDING")
  expect(r.entry).toBeDefined()

  // Target untouched: still active, not superseded, file unchanged.
  const target = index.getById("mem_20260710_aaaaaa")!
  expect(target.entry.status).toBe("active")
  expect(target.entry.superseded_by).toBeNull()
  const after = await readEntry(entryPath(storeDir, seed))
  expect(after).toEqual(before)

  // A quarantine entry exists carrying the pending-review shape.
  const qHit = index.getById(r.entry!.id)!
  expect(qHit.entry.status).toBe("quarantined")
  expect(qHit.entry.review).toBe("human_pending")
  expect(qHit.entry.supersedes).toBe("mem_20260710_aaaaaa")
  expect(qHit.entry.notes.some((n) => n.includes("pending review"))).toBe(true)
  expect(existsSync(qHit.path)).toBe(true)
  expect(qHit.path).toContain("quarantine")
})

test("SUPERSEDE against convention-type target is intercepted into review queue", async () => {
  const seed = existing("mem_20260710_aaaaaa", {
    type: "convention", title: "Naming convention", trigger: "new module", lesson: "Prefix modules with mod_.",
  })
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand({ type: "convention", title: "Naming convention", trigger: "new module", lesson: "Prefix modules with m_." }),
    meta,
    deps({
      llm: fakeLlm('{"op":"SUPERSEDE","target_id":"mem_20260710_aaaaaa","reason":"style changed"}'),
      index, storeDir,
    }),
  )
  expect(r.op).toBe("SUPERSEDE_PENDING")
  const target = index.getById("mem_20260710_aaaaaa")!
  expect(target.entry.status).toBe("active")
  expect(target.entry.superseded_by).toBeNull()
  const qHit = index.getById(r.entry!.id)!
  expect(qHit.entry.status).toBe("quarantined")
  expect(qHit.entry.review).toBe("human_pending")
  expect(qHit.entry.supersedes).toBe("mem_20260710_aaaaaa")
  expect(qHit.entry.notes.some((n) => n.includes("pending review"))).toBe(true)
})

test("NOOP writes nothing", async () => {
  const seed = existing("mem_20260710_aaaaaa")
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand(), meta,
    deps({ llm: fakeLlm('{"op":"NOOP","target_id":"mem_20260710_aaaaaa","reason":"same fact"}'), index, storeDir }),
  )
  expect(r.op).toBe("NOOP")
  const e = index.search("SPEF")[0]!.entry
  expect(e.evidence.length).toBe(1)
  expect(e.updated_at).toBe("2026-07-10T00:00:00.000Z")
})

const NOW = new Date("2026-07-11T02:00:00.000Z")

test("ADD collision with non-active existing entry uniquifies id, leaves existing untouched", async () => {
  const targetId = entryId(meta.project, cand().title, NOW)
  const seed = existing(targetId, { status: "quarantined" })
  const { storeDir, index } = await setup(seed)
  const before = await readEntry(entryPath(storeDir, seed))
  let called = 0
  const llm: LlmClient = { describe: () => "f", complete: async () => { called++; return '{"op":"ADD"}' } }
  const r = await reconcileCandidate(cand(), meta, deps({ llm, index, storeDir }))
  expect(r.op).toBe("ADD")
  expect(called).toBe(0) // quarantined entry isn't an active neighbor -> no LLM call
  const after = await readEntry(entryPath(storeDir, seed))
  expect(after).toEqual(before) // existing quarantined entry's file is untouched
  const uniquified = index.getById(`${targetId}-2`)
  expect(uniquified).not.toBeNull()
  expect(r.entry!.id).toBe(`${targetId}-2`)
})

test("ADD collision with active existing entry degrades to UPDATE instead of overwriting", async () => {
  const targetId = entryId(meta.project, cand().title, NOW)
  const seed = existing(targetId) // active by default, same title so it also FTS-matches
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(cand(), meta, deps({ llm: fakeLlm('{"op":"ADD"}'), index, storeDir }))
  expect(r.op).toBe("UPDATE")
  expect(r.entry!.evidence.length).toBe(2)
  expect(r.entry!.id).toBe(targetId)
  const hits = index.search("SPEF")
  expect(hits.length).toBe(1) // only one entry exists for this id, no duplicate written
})

test("UPDATE re-reconciling the same session again does not duplicate the note", async () => {
  // Seed already carries evidence for the SAME session as the incoming candidate — this
  // simulates a same-session re-extraction (e.g. a rerun) reconciling to UPDATE again.
  const seed = existing("mem_20260710_aaaaaa", {
    evidence: [{ session: "ses_2", anchors: ["msg_a"], observed_at: "2026-07-10T00:00:00.000Z" }],
  })
  const { storeDir, index } = await setup(seed)
  const r = await reconcileCandidate(
    cand(), meta,
    deps({ llm: fakeLlm('{"op":"UPDATE","target_id":"mem_20260710_aaaaaa","note":"confirmed again"}'), index, storeDir }),
  )
  expect(r.op).toBe("UPDATE")
  expect(r.entry!.evidence.length).toBe(1) // no new evidence added for an already-seen session
  expect(r.entry!.notes.length).toBe(0) // and no duplicate note pushed
})

test("UPDATE target drifted out of the index (file deleted) falls back to ADD", async () => {
  const seed = existing("mem_20260710_aaaaaa")
  const { storeDir, index } = await setup(seed)
  const seedPath = entryPath(storeDir, seed)
  const llm: LlmClient = {
    describe: () => "f",
    complete: async () => {
      rmSync(seedPath) // index row still points at this path -> getById now misses
      return '{"op":"UPDATE","target_id":"mem_20260710_aaaaaa","note":"n"}'
    },
  }
  const r = await reconcileCandidate(cand(), meta, deps({ llm, index, storeDir }))
  expect(r.op).toBe("ADD")
  expect(r.entry).toBeDefined()
  expect(index.getById(r.entry!.id)).not.toBeNull()
})

test("UPDATE target superseded mid-flight falls back to ADD without polluting the tombstone", async () => {
  const seed = existing("mem_20260710_aaaaaa")
  const { storeDir, index } = await setup(seed)
  const llm: LlmClient = {
    describe: () => "f",
    complete: async () => {
      const superseded: MemoryEntry = { ...seed, status: "superseded", updated_at: "2026-07-10T12:00:00.000Z" }
      const path = await writeEntry(storeDir, superseded)
      index.upsertEntry(superseded, path)
      return '{"op":"UPDATE","target_id":"mem_20260710_aaaaaa","note":"n"}'
    },
  }
  const r = await reconcileCandidate(cand(), meta, deps({ llm, index, storeDir }))
  expect(r.op).toBe("ADD")
  const after = await readEntry(entryPath(storeDir, seed))
  expect(after.status).toBe("superseded")
  expect(after.evidence.length).toBe(1)
  expect(after.notes.length).toBe(0)
})
