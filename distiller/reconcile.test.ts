import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmClient } from "./llm"
import { MemoryIndex } from "./ledger"
import { parseReconcileOp, reconcileCandidate } from "./reconcile"
import { readEntry, writeEntry } from "./store"
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
  volatile: false, confidence: 0.5, status: "active", superseded_by: null, review: "auto",
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
