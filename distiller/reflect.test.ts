import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MemoryConfig } from "../shared/config"
import type { Cluster } from "./cluster"
import { openMemoryIndex } from "./indexes"
import type { MemoryQuery } from "./indexes"
import type { LlmClient } from "./llm"
import { buildReflectPrompt, parseReflectOp, REFLECT_SCHEMA, runReflect, type ReflectDeps } from "./reflect"
import { readEntry, writeEntry } from "./store"
import type { MemoryEntry } from "./types"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-reflect-"))

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: "default title", trigger: "default trigger", project: "proja", scope: "project",
  domain: ["d"], volatile: false, confidence: 0.5, status: "active", superseded_by: null, supersedes: null, promoted_from: null,
  review: "auto",
  evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-10T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z",
  lesson: "default lesson", notes: [],
  ...over,
})

const setup = () => {
  const dir = tmp()
  const storeDir = join(dir, "store")
  const transcriptsDir = join(dir, "transcripts")
  mkdirSync(storeDir, { recursive: true })
  const index = openMemoryIndex(storeDir, { ok: true })
  const cfg: MemoryConfig = {
    home: dir, transcriptsDir, storeDir, logFile: join(dir, "log"), ignoredProjects: [], minUserTurns: 2,
  }
  return { dir, storeDir, transcriptsDir, index, cfg }
}

const seedActive = async (storeDir: string, index: MemoryQuery, e: MemoryEntry): Promise<string> => {
  const path = await writeEntry(storeDir, e)
  index.upsertEntry(e, path)
  return path
}

const NOW = new Date("2026-07-11T02:00:00.000Z")

const fakeLlm = (reply: string): LlmClient => ({ describe: () => "fake", complete: async () => reply })
const queueLlm = (replies: string[]): LlmClient => {
  let i = 0
  return { describe: () => "fake", complete: async () => replies[Math.min(i++, replies.length - 1)]! }
}

const baseDeps = (over: Partial<ReflectDeps> & { index: MemoryQuery; storeDir: string; llm: LlmClient }): ReflectDeps => ({
  judges: 0, salienceMin: 6, now: NOW, dryRun: false, log: () => {}, ...over,
})

const mdFilesUnder = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// parseReflectOp validation matrix
// ---------------------------------------------------------------------------

test("parseReflectOp: none op", () => {
  expect(parseReflectOp('{"op":"none","reason":"coincidence"}', ["a", "b"])).toEqual({ op: "none", reason: "coincidence" })
})

test("parseReflectOp: none op defaults reason when missing", () => {
  expect(parseReflectOp('{"op":"none"}', ["a", "b"])).toEqual({ op: "none", reason: "unspecified" })
})

test("parseReflectOp: valid insight op", () => {
  const raw = '{"op":"insight","type":"know_how","title":"T","trigger":"Tr","lesson":"L","domain":["d"],"cites":["a","b"]}'
  expect(parseReflectOp(raw, ["a", "b", "c"])).toEqual({
    op: "insight", type: "know_how", title: "T", trigger: "Tr", lesson: "L", domain: ["d"], cites: ["a", "b"],
  })
})

test("parseReflectOp: insight with invalid type throws", () => {
  const raw = '{"op":"insight","type":"bogus","title":"T","trigger":"Tr","lesson":"L","domain":["d"],"cites":["a","b"]}'
  expect(() => parseReflectOp(raw, ["a", "b"])).toThrow(/type/)
})

test("parseReflectOp: insight with fewer than 2 cites throws", () => {
  const raw = '{"op":"insight","type":"know_how","title":"T","trigger":"Tr","lesson":"L","domain":["d"],"cites":["a"]}'
  expect(() => parseReflectOp(raw, ["a", "b"])).toThrow(/cites/)
})

test("parseReflectOp: insight citing a non-member id throws", () => {
  const raw = '{"op":"insight","type":"know_how","title":"T","trigger":"Tr","lesson":"L","domain":["d"],"cites":["a","z"]}'
  expect(() => parseReflectOp(raw, ["a", "b"])).toThrow(/cites/)
})

test("parseReflectOp: insight missing required text fields throws per-field", () => {
  expect(() => parseReflectOp('{"op":"insight","type":"know_how","trigger":"Tr","lesson":"L","domain":["d"],"cites":["a","b"]}', ["a", "b"])).toThrow(/title/)
  expect(() => parseReflectOp('{"op":"insight","type":"know_how","title":"T","lesson":"L","domain":["d"],"cites":["a","b"]}', ["a", "b"])).toThrow(/trigger/)
  expect(() => parseReflectOp('{"op":"insight","type":"know_how","title":"T","trigger":"Tr","domain":["d"],"cites":["a","b"]}', ["a", "b"])).toThrow(/lesson/)
  expect(() => parseReflectOp('{"op":"insight","type":"know_how","title":"T","trigger":"Tr","lesson":"L","cites":["a","b"]}', ["a", "b"])).toThrow(/domain/)
})

test("parseReflectOp: valid merge op", () => {
  const raw = '{"op":"merge","keep":"a","absorb":["b"],"reason":"same lesson"}'
  expect(parseReflectOp(raw, ["a", "b"])).toEqual({ op: "merge", keep: "a", absorb: ["b"], reason: "same lesson" })
})

test("parseReflectOp: merge.keep not a cluster member throws", () => {
  expect(() => parseReflectOp('{"op":"merge","keep":"z","absorb":["b"],"reason":"r"}', ["a", "b"])).toThrow(/keep/)
})

test("parseReflectOp: merge.absorb empty throws", () => {
  expect(() => parseReflectOp('{"op":"merge","keep":"a","absorb":[],"reason":"r"}', ["a", "b"])).toThrow(/absorb/)
})

test("parseReflectOp: merge.absorb containing a non-member throws", () => {
  expect(() => parseReflectOp('{"op":"merge","keep":"a","absorb":["z"],"reason":"r"}', ["a", "b"])).toThrow(/absorb/)
})

test("parseReflectOp: merge.keep also present in absorb throws", () => {
  expect(() => parseReflectOp('{"op":"merge","keep":"a","absorb":["a","b"],"reason":"r"}', ["a", "b"])).toThrow(/absorb/)
})

test("parseReflectOp: unknown op throws", () => {
  expect(() => parseReflectOp('{"op":"YOLO"}', ["a"])).toThrow(/op/)
})

test("parseReflectOp: unparseable input throws", () => {
  expect(() => parseReflectOp("not json", ["a"])).toThrow()
})

test("REFLECT_SCHEMA declares the op enum", () => {
  expect(REFLECT_SCHEMA.type).toBe("object")
  expect((REFLECT_SCHEMA.properties as Record<string, { enum?: string[] }>).op!.enum).toEqual(["insight", "merge", "none"])
})

test("buildReflectPrompt includes member ids/titles and the cluster domain", () => {
  const cluster: Cluster = {
    domain: "sta",
    members: [
      { entry: entry("mem_a", { title: "Hold violations after ECO", trigger: "route change" }), path: "/a" },
      { entry: entry("mem_b", { title: "Hold slack negative post route", trigger: "route change" }), path: "/b" },
    ],
  }
  const { system, prompt } = buildReflectPrompt(cluster)
  expect(system).toContain("insight")
  expect(system).toContain("merge")
  expect(prompt).toContain("mem_a")
  expect(prompt).toContain("mem_b")
  expect(prompt).toContain("sta")
})

// ---------------------------------------------------------------------------
// insight creation
// ---------------------------------------------------------------------------

test("insight: creates a new active entry with derived-from note, common project, and evidence union", async () => {
  const { storeDir, index, cfg } = setup()
  const a = entry("mem_20260710_aaaaaa", {
    title: "hold violations after ECO route", trigger: "post route ECO", domain: ["sta"],
    evidence: [{ session: "ses_x1", anchors: ["m1"], observed_at: "2026-07-10T00:00:00.000Z" }],
  })
  const b = entry("mem_20260710_bbbbbb", {
    title: "hold slack negative after ECO route", trigger: "post route ECO", domain: ["sta"],
    evidence: [{ session: "ses_x2", anchors: ["m2"], observed_at: "2026-07-10T00:00:00.000Z" }],
  })
  await seedActive(storeDir, index, a)
  await seedActive(storeDir, index, b)

  const insightReply = JSON.stringify({
    op: "insight", type: "know_how", title: "ECO route hold pattern",
    trigger: "after ECO route change", lesson: "Recheck hold slack after every ECO route.",
    domain: ["sta"], cites: [a.id, b.id],
  })

  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: fakeLlm(insightReply) }))
  expect(summary.clusters).toBe(1)
  expect(summary.insights).toBe(1)
  expect(summary.skipped).toBe(0)
  expect(summary.errors).toBe(0)

  const files = mdFilesUnder(join(storeDir, "memories", "proja"))
  expect(files.length).toBe(3)
  const insightFile = files.find((f) => !f.includes("aaaaaa") && !f.includes("bbbbbb"))!
  const insightEntry = await readEntry(join(storeDir, "memories", "proja", insightFile))

  expect(insightEntry.title).toBe("ECO route hold pattern")
  expect(insightEntry.type).toBe("know_how")
  expect(insightEntry.memory_class).toBe("semantic")
  expect(insightEntry.status).toBe("active")
  expect(insightEntry.review).toBe("auto")
  expect(insightEntry.project).toBe("proja")
  expect(insightEntry.scope).toBe("project")
  expect(insightEntry.promoted_from).toBeNull()
  expect(insightEntry.supersedes).toBeNull()
  expect(insightEntry.notes.length).toBe(1)
  expect(insightEntry.notes[0]).toBe(`2026-07-11: derived from: ${[a.id, b.id].sort().join(",")}`)
  expect(insightEntry.evidence.map((e) => e.session).sort()).toEqual(["ses_x1", "ses_x2"])
  expect(insightEntry.confidence).toBe(0.65) // computeConfidence({sessions:2,...})
})

test("insight: members spanning >1 project fall back to project 'global' and scope 'global'", async () => {
  const { storeDir, index, cfg } = setup()
  const a = entry("mem_20260710_vvvvvv", {
    project: "proja", title: "flaky ci runner timeout alpha", trigger: "ci pipeline flake", domain: ["ci"],
  })
  const b = entry("mem_20260710_wwwwww", {
    project: "projb", title: "flaky ci runner timeout beta", trigger: "ci pipeline flake", domain: ["ci"],
  })
  await seedActive(storeDir, index, a)
  await seedActive(storeDir, index, b)

  const insightReply = JSON.stringify({
    op: "insight", type: "know_how", title: "CI flake insight",
    trigger: "ci pipeline flake", lesson: "Retry flaky CI runners with backoff.",
    domain: ["ci"], cites: [a.id, b.id],
  })
  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: fakeLlm(insightReply) }))
  expect(summary.insights).toBe(1)

  const files = mdFilesUnder(join(storeDir, "memories", "global"))
  expect(files.length).toBe(1)
  const insightEntry = await readEntry(join(storeDir, "memories", "global", files[0]!))
  expect(insightEntry.project).toBe("global")
  expect(insightEntry.scope).toBe("global")
})

test("insight: judge gate drops below-threshold insights (skipped++, nothing written)", async () => {
  const { storeDir, index, cfg } = setup()
  const a = entry("mem_20260710_cccccc", { title: "flaky retry backoff pattern alpha", trigger: "network timeout", domain: ["infra"] })
  const b = entry("mem_20260710_dddddd", { title: "flaky retry backoff pattern beta", trigger: "network timeout", domain: ["infra"] })
  await seedActive(storeDir, index, a)
  await seedActive(storeDir, index, b)

  const insightReply = JSON.stringify({
    op: "insight", type: "know_how", title: "Retry backoff insight",
    trigger: "network timeout", lesson: "Use exponential backoff for retries.",
    domain: ["infra"], cites: [a.id, b.id],
  })
  const judgeReplies = [insightReply, '{"salience":2,"reason":"weak"}', '{"salience":3,"reason":"weak"}', '{"salience":2,"reason":"weak"}']
  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: queueLlm(judgeReplies), judges: 3, salienceMin: 6 }))

  expect(summary.clusters).toBe(1)
  expect(summary.insights).toBe(0)
  expect(summary.skipped).toBe(1)
  expect(mdFilesUnder(join(storeDir, "memories", "proja")).length).toBe(2)
})

test("insight: judge gate above threshold passes and records the judge note", async () => {
  const { storeDir, index, cfg } = setup()
  const a = entry("mem_20260710_xxxxxx", { title: "kafka consumer rebalance storm alpha", trigger: "rebalance loop", domain: ["kafka"] })
  const b = entry("mem_20260710_yyyyyy", { title: "kafka consumer rebalance storm beta", trigger: "rebalance loop", domain: ["kafka"] })
  await seedActive(storeDir, index, a)
  await seedActive(storeDir, index, b)

  const insightReply = JSON.stringify({
    op: "insight", type: "root_cause", title: "Kafka rebalance storm",
    trigger: "rebalance loop", lesson: "Pin consumer group session timeout to stop rebalance storms.",
    domain: ["kafka"], cites: [a.id, b.id],
  })
  const judgeReplies = [insightReply, '{"salience":8,"reason":"good"}', '{"salience":9,"reason":"good"}', '{"salience":8,"reason":"good"}']
  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: queueLlm(judgeReplies), judges: 3, salienceMin: 6 }))

  expect(summary.insights).toBe(1)
  const files = mdFilesUnder(join(storeDir, "memories", "proja"))
  const insightFile = files.find((f) => !f.includes("xxxxxx") && !f.includes("yyyyyy"))!
  const insightEntry = await readEntry(join(storeDir, "memories", "proja", insightFile))
  expect(insightEntry.notes.some((n) => n.includes("judged: median 8"))).toBe(true)
})

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

test("merge: absorbs a non-policy member directly, keep gains evidence + note", async () => {
  const { storeDir, index, cfg } = setup()
  const keep = entry("mem_20260710_eeeeee", {
    type: "pitfall", title: "stale spef reused after eco route change", trigger: "after eco route", domain: ["sta2"],
    evidence: [{ session: "ses_k1", anchors: ["mk1"], observed_at: "2026-07-10T00:00:00.000Z" }],
  })
  const absorb = entry("mem_20260710_ffffff", {
    type: "pitfall", title: "stale spef reused post eco route change", trigger: "after eco route", domain: ["sta2"],
    evidence: [{ session: "ses_a1", anchors: ["ma1"], observed_at: "2026-07-10T00:00:00.000Z" }],
  })
  await seedActive(storeDir, index, keep)
  await seedActive(storeDir, index, absorb)

  const mergeReply = JSON.stringify({ op: "merge", keep: keep.id, absorb: [absorb.id], reason: "same lesson, different wording" })
  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: fakeLlm(mergeReply) }))

  expect(summary.clusters).toBe(1)
  expect(summary.merges).toBe(1)
  expect(summary.mergesPending).toBe(0)

  const absorbedHit = index.getById(absorb.id)!
  expect(absorbedHit.entry.status).toBe("superseded")
  expect(absorbedHit.entry.superseded_by).toBe(keep.id)

  const keepHit = index.getById(keep.id)!
  expect(keepHit.entry.evidence.map((e) => e.session).sort()).toEqual(["ses_a1", "ses_k1"])
  expect(keepHit.entry.notes.some((n) => n.includes("absorbed") && n.includes(absorb.id))).toBe(true)
})

test("merge: absorbing a policy-type (decision/convention) member routes to quarantine review (mergesPending++), target untouched", async () => {
  const { storeDir, index, cfg } = setup()
  const keep = entry("mem_20260710_gggggg", {
    type: "convention", title: "naming prefix rule module names", trigger: "new module created", domain: ["style1"],
  })
  const absorb = entry("mem_20260710_hhhhhh", {
    type: "convention", title: "naming prefix rule for modules", trigger: "new module created", domain: ["style1"],
  })
  await seedActive(storeDir, index, keep)
  await seedActive(storeDir, index, absorb)

  const mergeReply = JSON.stringify({ op: "merge", keep: keep.id, absorb: [absorb.id], reason: "duplicate convention" })
  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: fakeLlm(mergeReply) }))

  expect(summary.merges).toBe(0)
  expect(summary.mergesPending).toBe(1)

  const absorbHit = index.getById(absorb.id)!
  expect(absorbHit.entry.status).toBe("active")

  const qFiles = mdFilesUnder(join(storeDir, "quarantine"))
  expect(qFiles.length).toBe(1)
  const qEntry = await readEntry(join(storeDir, "quarantine", qFiles[0]!))
  expect(qEntry.status).toBe("quarantined")
  expect(qEntry.review).toBe("human_pending")
  expect(qEntry.supersedes).toBe(absorb.id)
})

test("merge: an absorb member already superseded earlier in the same run (multi-domain overlap) is skipped on the later cluster", async () => {
  const { storeDir, index, cfg } = setup()
  const a = entry("mem_20260710_aaaaaa", { type: "pitfall", title: "shared timing glitch pattern one", trigger: "trig1", domain: ["style2", "extra"] })
  const b = entry("mem_20260710_bbbbbb", { type: "pitfall", title: "shared timing glitch pattern two", trigger: "trig1", domain: ["style2"] })
  const c = entry("mem_20260710_cccccc", { type: "pitfall", title: "shared timing glitch pattern three", trigger: "trig1", domain: ["extra"] })
  await seedActive(storeDir, index, a)
  await seedActive(storeDir, index, b)
  await seedActive(storeDir, index, c)

  const reply1 = JSON.stringify({ op: "merge", keep: b.id, absorb: [a.id], reason: "same lesson" })
  const reply2 = JSON.stringify({ op: "merge", keep: c.id, absorb: [a.id], reason: "same lesson again" })
  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: queueLlm([reply1, reply2]) }))

  expect(summary.clusters).toBe(2)
  expect(summary.merges).toBe(1)
  expect(summary.skipped).toBe(1)

  const aHit = index.getById(a.id)!
  expect(aHit.entry.status).toBe("superseded")
  expect(aHit.entry.superseded_by).toBe(b.id)
  const cHit = index.getById(c.id)!
  expect(cHit.entry.status).toBe("active")
})

// ---------------------------------------------------------------------------
// promotion
// ---------------------------------------------------------------------------

test("promotion: a project-scoped entry flagged 'promotion candidate' gets a pending global copy", async () => {
  const { storeDir, index, cfg } = setup()
  const e = entry("mem_20260710_iiiiii", {
    title: "unique isolated lesson about caching layer bugs", trigger: "cache invalidation bug",
    domain: ["cache"], notes: ["2026-07-10: promotion candidate: seen in projb"],
  })
  await seedActive(storeDir, index, e)

  const throwingLlm: LlmClient = { describe: () => "fake", complete: async () => { throw new Error("should not be called") } }
  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: throwingLlm }))

  expect(summary.clusters).toBe(0) // isolated entry never forms a cluster
  expect(summary.promotions).toBe(1)

  const qFiles = mdFilesUnder(join(storeDir, "quarantine"))
  expect(qFiles.length).toBe(1)
  const pending = await readEntry(join(storeDir, "quarantine", qFiles[0]!))
  expect(pending.project).toBe("global")
  expect(pending.scope).toBe("global")
  expect(pending.status).toBe("quarantined")
  expect(pending.review).toBe("human_pending")
  expect(pending.promoted_from).toBe(e.id)
  expect(pending.supersedes).toBeNull()

  const sourceHit = index.getById(e.id)!
  expect(sourceHit.entry.status).toBe("active") // source is NOT superseded, both stay active
})

test("promotion: a source that already has a promoted_from copy is skipped on rerun", async () => {
  const { storeDir, index, cfg } = setup()
  const e = entry("mem_20260710_jjjjjj", {
    title: "another unique isolated lesson about queue backpressure", trigger: "queue overflow event",
    domain: ["queue"], notes: ["2026-07-10: promotion candidate: seen in projb"],
  })
  await seedActive(storeDir, index, e)
  const throwingLlm: LlmClient = { describe: () => "fake", complete: async () => { throw new Error("should not be called") } }

  const first = await runReflect(cfg, baseDeps({ index, storeDir, llm: throwingLlm }))
  expect(first.promotions).toBe(1)

  const second = await runReflect(cfg, baseDeps({ index, storeDir, llm: throwingLlm }))
  expect(second.promotions).toBe(0)
  expect(second.skipped).toBe(1)

  expect(mdFilesUnder(join(storeDir, "quarantine")).length).toBe(1)
})

// ---------------------------------------------------------------------------
// idempotency reruns
// ---------------------------------------------------------------------------

test("idempotent rerun: an already-derived insight cluster is skipped without a second LLM call", async () => {
  const { storeDir, index, cfg } = setup()
  const a = entry("mem_20260710_kkkkkk", { title: "gpu memory leak during long training runs", trigger: "long training run", domain: ["ml"] })
  const b = entry("mem_20260710_llllll", { title: "gpu memory leak during long training jobs", trigger: "long training run", domain: ["ml"] })
  await seedActive(storeDir, index, a)
  await seedActive(storeDir, index, b)

  const insightReply = JSON.stringify({
    op: "insight", type: "know_how", title: "GPU memory leak insight",
    trigger: "long training run", lesson: "Watch GPU memory across long runs.",
    domain: ["ml"], cites: [a.id, b.id],
  })
  let calls = 0
  const countingLlm: LlmClient = { describe: () => "fake", complete: async () => { calls++; return insightReply } }

  const first = await runReflect(cfg, baseDeps({ index, storeDir, llm: countingLlm }))
  expect(first.insights).toBe(1)
  expect(calls).toBe(1)

  const filesBefore = mdFilesUnder(join(storeDir, "memories", "proja"))
  const second = await runReflect(cfg, baseDeps({ index, storeDir, llm: countingLlm }))
  expect(second.insights).toBe(0)
  expect(second.skipped).toBe(1)
  expect(calls).toBe(1) // idempotency skip happens BEFORE calling the LLM again

  expect(mdFilesUnder(join(storeDir, "memories", "proja")).length).toBe(filesBefore.length)
})

test("idempotent rerun: after a direct merge, the shrunk cluster no longer reforms", async () => {
  const { storeDir, index, cfg } = setup()
  const keep = entry("mem_20260710_mmmmmm", { type: "pitfall", title: "leaked file handle on retry path", trigger: "retry after failure", domain: ["io"] })
  const absorb = entry("mem_20260710_nnnnnn", { type: "pitfall", title: "leaked file handle on retry attempt", trigger: "retry after failure", domain: ["io"] })
  await seedActive(storeDir, index, keep)
  await seedActive(storeDir, index, absorb)

  const mergeReply = JSON.stringify({ op: "merge", keep: keep.id, absorb: [absorb.id], reason: "dup" })
  let calls = 0
  const countingLlm: LlmClient = { describe: () => "fake", complete: async () => { calls++; return mergeReply } }

  const first = await runReflect(cfg, baseDeps({ index, storeDir, llm: countingLlm }))
  expect(first.merges).toBe(1)
  expect(calls).toBe(1)

  const second = await runReflect(cfg, baseDeps({ index, storeDir, llm: countingLlm }))
  expect(second.clusters).toBe(0) // only `keep` remains active — no cluster of size >=2 forms
  expect(second.merges).toBe(0)
  expect(calls).toBe(1)
})

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

test("dry-run: writes nothing to disk (md file set + mtimes unchanged) while still reporting planned ops", async () => {
  const { storeDir, index, cfg } = setup()
  const a = entry("mem_20260710_oooooo", { title: "docker layer cache invalidation issue", trigger: "rebuild after dep change", domain: ["docker"] })
  const b = entry("mem_20260710_pppppp", { title: "docker layer cache invalidation problem", trigger: "rebuild after dep change", domain: ["docker"] })
  const promo = entry("mem_20260710_qqqqqq", {
    title: "isolated promotion worthy lesson about retries", trigger: "cross project retry bug",
    domain: ["retry"], notes: ["2026-07-10: promotion candidate: seen in projb"],
  })
  await seedActive(storeDir, index, a)
  await seedActive(storeDir, index, b)
  await seedActive(storeDir, index, promo)

  const insightReply = JSON.stringify({
    op: "insight", type: "know_how", title: "Docker cache insight",
    trigger: "rebuild after dep change", lesson: "Bust the layer cache explicitly after dependency changes.",
    domain: ["docker"], cites: [a.id, b.id],
  })

  const snapshot = () => {
    const files: Array<{ path: string; mtime: number }> = []
    const walk = (dir: string) => {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const n of names) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith(".md")) files.push({ path: p, mtime: statSync(p).mtimeMs })
      }
    }
    walk(storeDir)
    return files.sort((x, y) => x.path.localeCompare(y.path))
  }

  const before = snapshot()
  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: fakeLlm(insightReply), dryRun: true }))
  const after = snapshot()

  expect(summary.insights).toBe(1)
  expect(summary.promotions).toBe(1)
  expect(after).toEqual(before)
})

// ---------------------------------------------------------------------------
// project filter
// ---------------------------------------------------------------------------

test("project filter: reflect only clusters/mutates the given project's entries", async () => {
  const { storeDir, index, cfg } = setup()
  const aProjA = entry("mem_20260710_rrrrrr", { project: "proja", title: "webpack bundle split issue alpha", trigger: "large bundle warning", domain: ["build"] })
  const bProjA = entry("mem_20260710_ssssss", { project: "proja", title: "webpack bundle split issue beta", trigger: "large bundle warning", domain: ["build"] })
  const aProjB = entry("mem_20260710_tttttt", { project: "projb", title: "webpack bundle split issue gamma", trigger: "large bundle warning", domain: ["build"] })
  const bProjB = entry("mem_20260710_uuuuuu", { project: "projb", title: "webpack bundle split issue delta", trigger: "large bundle warning", domain: ["build"] })
  await seedActive(storeDir, index, aProjA)
  await seedActive(storeDir, index, bProjA)
  await seedActive(storeDir, index, aProjB)
  await seedActive(storeDir, index, bProjB)

  const insightReply = JSON.stringify({
    op: "insight", type: "know_how", title: "Webpack bundle split insight",
    trigger: "large bundle warning", lesson: "Split vendor bundles explicitly.",
    domain: ["build"], cites: [aProjA.id, bProjA.id],
  })

  const summary = await runReflect(cfg, baseDeps({ index, storeDir, llm: fakeLlm(insightReply) }), { project: "proja" })
  expect(summary.clusters).toBe(1)
  expect(summary.insights).toBe(1)

  const projbFiles = mdFilesUnder(join(storeDir, "memories", "projb"))
  expect(projbFiles.length).toBe(2) // no new file, no mutation
  const bHit = index.getById(aProjB.id)!
  expect(bHit.entry.status).toBe("active")
  expect(bHit.entry.notes.length).toBe(0)
})
