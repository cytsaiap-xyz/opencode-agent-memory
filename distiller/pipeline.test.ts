import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../shared/config"
import type { LlmClient, LlmRequest } from "./llm"
import { openMemoryIndex } from "./indexes"
import { renderIndexMd, runPipeline } from "./pipeline"
import { entryPath, quarantinePath, serializeEntry } from "./store"
import type { MemoryEntry } from "./types"

const PAD = "\n\npadding ".repeat(60) // pushes body length past the 400-char triage floor

const transcript = (sessionId: string, hash: string, text: string) => `---
session_id: ${sessionId}
project_dir: "/x/proja"
title: "t"
model: m
time_start: 2026-07-10T00:00:00.000Z
time_end: 2026-07-10T01:00:00.000Z
turns: 2
tokens: { input: 1, output: 1 }
content_hash: ${hash}
exported_at: 2026-07-10T02:00:00.000Z
---
## T1 [00:00] User {#msg_u1}

${text}${PAD}

## T2 [00:01] Assistant {#msg_a1}

answer
`

const candidateJson = (title: string, lesson: string, over: Record<string, unknown> = {}) =>
  JSON.stringify([{ type: "pitfall", title, trigger: "when x", lesson, domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: 8, volatile: false, ...over }])

const candidatesJson = (items: Array<{ title: string; lesson: string; trigger?: string; salience?: number }>) =>
  JSON.stringify(
    items.map((it) => ({
      type: "pitfall", title: it.title, trigger: it.trigger ?? `when ${it.title}`, lesson: it.lesson,
      domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: it.salience ?? 7, volatile: false,
    })),
  )

const triageJson = (worth: boolean, why = "test") => JSON.stringify({ worth_extracting: worth, why })
const judgeJson = (salience: number) => JSON.stringify({ salience, reason: "test" })

const scriptedLlm = (replies: string[]): LlmClient & { calls: number } => {
  const c = {
    calls: 0,
    describe: () => "fake",
    complete: async () => {
      const r = replies[c.calls] ?? "[]"
      c.calls++
      return r
    },
  }
  return c
}

// Like scriptedLlm, but an entry may be an Error to simulate that call throwing (used for
// per-run extraction-failure tests) instead of returning a scripted reply.
const scriptedLlmErrors = (replies: Array<string | Error>): LlmClient & { calls: number } => {
  const c = {
    calls: 0,
    describe: () => "fake",
    complete: async () => {
      const r = replies[c.calls] ?? "[]"
      c.calls++
      if (r instanceof Error) throw r
      return r
    },
  }
  return c
}

// Like scriptedLlmErrors, but call index N (0-indexed, matching extractRuns fan-out order)
// can be "gated" so its complete() doesn't settle until release(N) is invoked. Used to
// prove that the parallel extract-runs loop (Promise.all in pipeline.ts) concatenates
// results in run-index order regardless of which run's LLM call actually SETTLES first —
// the property Promise.all buys over a sequential for-loop.
const gatedExtractLlm = (
  replies: Array<string | Error>,
  gatedIndices: number[] = [],
): LlmClient & { calls: number; release: (i: number) => void } => {
  const gates = new Map<number, () => void>()
  const obj = {
    calls: 0,
    describe: () => "fake",
    complete: async () => {
      const idx = obj.calls
      obj.calls++
      if (gatedIndices.includes(idx)) {
        await new Promise<void>((resolve) => gates.set(idx, resolve))
      }
      const r = replies[idx] ?? "[]"
      if (r instanceof Error) throw r
      return r
    },
    release: (i: number) => gates.get(i)?.(),
  }
  return obj
}

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-pipe-"))
  const cfg = loadConfig({ AGENT_MEMORY_HOME: dir })
  mkdirSync(join(cfg.transcriptsDir, "proja"), { recursive: true })
  mkdirSync(cfg.storeDir, { recursive: true })
  const index = openMemoryIndex(cfg.storeDir, { ok: true })
  return { dir, cfg, index }
}
const NOW = new Date("2026-07-11T00:00:00.000Z") // 23h after time_end -> eligible at idleHours=6

// Legacy pinning: these tests script exact FakeLlm reply sequences (one reply per LLM
// call). The quality pack's new defaults (llm triage, extractRuns=2, judges=3) issue many
// more calls per session than the old single-pass pipeline did, which would desync every
// scripted sequence below. Pin the pre-quality-pack semantics explicitly so this file keeps
// testing exactly what it always tested; the new defaults get their own dedicated tests.
const LEGACY = { triage: "heuristic" as const, extractRuns: 1, judges: 0, concurrency: 1 }

test("end-to-end: extract -> add; rerun is idempotent; INDEX.md rendered", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "how to fix X"))
  const llm = scriptedLlm([candidateJson("Fix X", "Do Y because Z.")])
  const s1 = await runPipeline(cfg, { llm, index }, { now: NOW, ...LEGACY })
  expect(s1.eligible).toBe(1)
  expect(s1.ops.added).toBe(1)
  expect(s1.errors).toBe(0)
  expect(index.search("Fix X", { status: "active" }).length).toBe(1)
  const indexMd = readFileSync(join(cfg.storeDir, "INDEX.md"), "utf8")
  expect(indexMd).toContain("Fix X")

  const s2 = await runPipeline(cfg, { llm, index }, { now: NOW, ...LEGACY })
  expect(s2.skippedProcessed).toBe(1)
  expect(s2.ops.added).toBe(0)
  expect(llm.calls).toBe(1) // no second extraction
})

test("idle window and thin transcripts are respected", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "text"))
  const early = await runPipeline(cfg, { llm: scriptedLlm([]), index }, { now: new Date("2026-07-10T02:00:00.000Z"), ...LEGACY })
  expect(early.eligible).toBe(0)

  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_thin.md"),
    transcript("ses_thin", "sha256:h2", "hi").replace(PAD, "")) // short body
  const s = await runPipeline(cfg, { llm: scriptedLlm([]), index }, { now: NOW, ...LEGACY })
  expect(s.triagedOut).toBe(1)
  expect(index.ledger.isProcessed("ses_thin", "sha256:h2")).toBe(true) // thin sessions are ledgered, not retried
})

test("second session on same topic reconciles as UPDATE", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "topic"))
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_2.md"), transcript("ses_2", "sha256:h2", "same topic again"))
  const llm = scriptedLlm([
    candidateJson("SPEF pitfall", "Re-extract parasitics."),           // extract ses_1 -> ADD (no neighbors, no llm call)
    candidateJson("SPEF pitfall", "Re-extract parasitics."),           // extract ses_2
    "", // placeholder — replaced below after we know the id
  ])
  const s1 = await runPipeline(cfg, { llm, index }, { now: NOW, ...LEGACY })
  expect(s1.ops.added).toBe(1)
  const id = index.search("SPEF")[0]!.entry.id
  ;(llm as { complete: LlmClient["complete"] }).complete = (() => {
    let call = 0
    return async () => {
      call++
      if (call === 1) return candidateJson("SPEF pitfall", "Re-extract parasitics.")
      return JSON.stringify({ op: "UPDATE", target_id: id, note: "confirmed" })
    }
  })()
  const s2 = await runPipeline(cfg, { llm, index }, { now: NOW, ...LEGACY })
  expect(s2.ops.updated).toBe(1)
  expect(index.search("SPEF")[0]!.entry.evidence.length).toBe(2)
})

test("secret candidates land in quarantine, not the store", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "leaky"))
  const llm = scriptedLlm([candidateJson("Key setup", "Set AKIA0123456789ABCDEF first.")])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, ...LEGACY })
  expect(s.quarantined).toBe(1)
  expect(s.ops.added).toBe(0)
  expect(index.search("Key setup", { status: "quarantined" }).length).toBe(1)
  expect(existsSync(join(cfg.storeDir, "quarantine"))).toBe(true)
})

test("LLM failure counts an error, leaves session unprocessed for retry", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "text"))
  const llm: LlmClient = { describe: () => "f", complete: async () => { throw new Error("llm down") } }
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, ...LEGACY })
  expect(s.errors).toBe(1)
  expect(index.ledger.isProcessed("ses_1", "sha256:h1")).toBe(false)
  const retry = await runPipeline(cfg, { llm: scriptedLlm([candidateJson("Fix X", "Do Y.")]), index }, { now: NOW, ...LEGACY })
  expect(retry.ops.added).toBe(1)
})

test("quarantined entries render in INDEX.md under ## Quarantine section", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "leaky"))
  const llm = scriptedLlm([candidateJson("Key setup", "Set AKIA0123456789ABCDEF first.")])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, ...LEGACY })
  expect(s.quarantined).toBe(1)
  const indexMd = readFileSync(join(cfg.storeDir, "INDEX.md"), "utf8")
  expect(indexMd).toContain("## Quarantine")
  expect(indexMd).toContain("Key setup")
})

test("secret candidate colliding with an active memory's id does not hijack it", async () => {
  const { cfg, index } = setup()
  // Same title -> same deterministic entryId(project, title, day) for both runs.
  const title = "Same Title"
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "clean topic"))
  const s1 = await runPipeline(cfg, { llm: scriptedLlm([candidateJson(title, "Do the thing.")]), index }, { now: NOW, ...LEGACY })
  expect(s1.ops.added).toBe(1)
  const activeId = index.search(title, { status: "active" })[0]!.entry.id

  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_2.md"), transcript("ses_2", "sha256:h2", "leaky topic"))
  const s2 = await runPipeline(
    cfg,
    { llm: scriptedLlm([candidateJson(title, "Set AKIA0123456789ABCDEF first.")]), index },
    { now: NOW, ...LEGACY },
  )
  expect(s2.quarantined).toBe(1)

  // The active memory must still resolve via getById with status "active" and a path
  // under memories/, not have been repointed at the quarantine file.
  const activeHit = index.getById(activeId)
  expect(activeHit).not.toBeNull()
  expect(activeHit!.entry.status).toBe("active")
  expect(activeHit!.path).toContain(`${join("memories", "proja")}`)

  // The quarantine entry must exist under a uniquified (suffixed) id, not the same id.
  const quarantineHit = index.search(title, { status: "quarantined" })[0]!
  expect(quarantineHit.entry.id).not.toBe(activeId)
  expect(existsSync(quarantineHit.path)).toBe(true)
})

test("colliding quarantine entries are uniquified with numeric suffixes", async () => {
  const { cfg, index } = setup()
  // Two sessions with same project and title but different content hashes
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "leaky 1"))
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_2.md"), transcript("ses_2", "sha256:h2", "leaky 2"))
  const secretTitle = "AWS Credentials"
  const llm = scriptedLlm([
    candidateJson(secretTitle, "Never set AKIA0123456789ABCDEF as env var."),
    candidateJson(secretTitle, "Never set AKIA9876543210FEDCBA as env var."),
  ])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, ...LEGACY })
  expect(s.quarantined).toBe(2)
  const quarantineDir = join(cfg.storeDir, "quarantine")
  const files = readdirSync(quarantineDir)
  expect(files.length).toBe(2)
  // Both files should exist
  expect(files.every((f) => f.endsWith(".md"))).toBe(true)
})

test("renderIndexMd dedupes a quarantined id that shows up under both memories/ and quarantine/", async () => {
  const { cfg } = setup()
  const q: MemoryEntry = {
    id: "mem_20260711_dupdup", memory_class: "semantic", type: "pitfall",
    title: "Duplicated Quarantine Entry", trigger: "when x", project: "proja", scope: "project",
    domain: ["d"], volatile: false, confidence: 0.5, status: "quarantined", superseded_by: null, supersedes: null, promoted_from: null, absorbs: null,
    review: "human_pending",
    evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-11T00:00:00.000Z" }],
    provenance: { extractor: "t", prompt_hash: "sha256:aa" },
    created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z",
    lesson: "lesson", notes: [],
  }
  // Same id present both under memories/ (stray/transitional state) and quarantine/
  // (canonical location) — INDEX.md must still list it exactly once.
  mkdirSync(join(cfg.storeDir, "memories", "proja"), { recursive: true })
  mkdirSync(join(cfg.storeDir, "quarantine"), { recursive: true })
  writeFileSync(entryPath(cfg.storeDir, q), serializeEntry(q))
  writeFileSync(quarantinePath(cfg.storeDir, q.id), serializeEntry(q))

  await renderIndexMd(cfg.storeDir)
  const indexMd = readFileSync(join(cfg.storeDir, "INDEX.md"), "utf8")
  const occurrences = indexMd.split("\n").filter((l) => l.includes(q.id)).length
  expect(occurrences).toBe(1)
})

// ============ Quality pack: llm triage, extract runs, judges ============

test("llm triage: worth_extracting=false is ledgered as triagedLlm, no extraction call made", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "just a greeting"))
  const llm = scriptedLlm([triageJson(false, "nothing durable here")])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "llm", extractRuns: 1, judges: 0 })
  expect(s.triagedOut).toBe(1)
  expect(s.triagedLlm).toBe(1)
  expect(s.triagedHeuristic).toBe(0)
  expect(s.candidates).toBe(0)
  expect(llm.calls).toBe(1) // triage only — extraction never called
  expect(index.ledger.isProcessed("ses_1", "sha256:h1")).toBe(true)
})

test("80-char hard floor always heuristic-skips, even in llm triage mode (never calls the LLM)", async () => {
  const { cfg, index } = setup()
  // body "hi" without PAD is well under the 80-char hard floor.
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "hi").replace(PAD, ""))
  const llm = scriptedLlm([])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "llm", extractRuns: 1, judges: 0 })
  expect(s.triagedOut).toBe(1)
  expect(s.triagedHeuristic).toBe(1)
  expect(s.triagedLlm).toBe(0)
  expect(llm.calls).toBe(0) // never reaches llmTriage
})

test("llm triage failure fails open: proceeds to extraction instead of dropping the session", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "how to fix X"))
  const llm = scriptedLlm(["not json at all", candidateJson("Fix X", "Do Y because Z.")])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "llm", extractRuns: 1, judges: 0 })
  expect(s.triagedOut).toBe(0)
  expect(s.ops.added).toBe(1)
  expect(index.search("Fix X", { status: "active" }).length).toBe(1)
})

test("extractRuns=2: union of both runs' candidates lands in the pool (run1 misses a candidate run2 has)", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "two topics"))
  // Deliberately non-overlapping vocabulary between the two titles/lessons (including
  // common short words like "the") — the FTS neighbor search in reconcileCandidate ORs
  // together every token of length >= 3 codepoints across title/trigger/lesson/domain, so
  // any shared word would make candidate B's reconcile search spuriously match candidate
  // A's just-committed entry and route it through the (here unscripted) reconcile LLM call
  // instead of a plain ADD.
  const llm = scriptedLlm([
    candidatesJson([{ title: "Alpha Cache Bug", lesson: "Clear cache eagerly on cold start." }]),
    candidatesJson([
      { title: "Alpha Cache Bug", lesson: "Clear cache eagerly on cold start." },
      { title: "Bravo Timeout Issue", lesson: "Raise socket deadline before retry." },
    ]),
  ])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 2, judges: 0 })
  expect(s.poolRaw).toBe(3) // Alpha (run1) + Alpha (run2) + Bravo (run2), pre-dedup
  expect(s.candidates).toBe(2) // Alpha merged, Bravo unique -> post-dedup pool of 2
  expect(s.ops.added).toBe(2)
  expect(index.search("Alpha Cache", { status: "active" }).length).toBe(1)
  expect(index.search("Bravo Timeout", { status: "active" }).length).toBe(1)
})

test("extractRuns=2: the SAME secret candidate in both runs dedupes to exactly one quarantine file", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "leaky both runs"))
  // Both extraction runs independently "discover" the identical secret candidate — this
  // is the realistic shape (extractRuns re-prompts the same transcript, so a real secret
  // in the transcript gets flagged by every run that spots it), and dedupSecrets (the
  // secret-pool sibling of dedupPool) must merge them into a single quarantine write
  // instead of one per run.
  const secretJson = candidateJson("AWS Key Setup", "Never set AKIA0123456789ABCDEF as env var.")
  const llm = scriptedLlm([secretJson, secretJson])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 2, judges: 0 })
  expect(s.quarantined).toBe(1)
  const quarantineDir = join(cfg.storeDir, "quarantine")
  const files = readdirSync(quarantineDir)
  expect(files.length).toBe(1)
})

test("judges=0: no per-entry judge note (legacy self-score stands, judge branch never runs)", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "no judging"))
  const llm = scriptedLlm([candidateJson("No Judge Note", "Do the thing.")])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 1, judges: 0 })
  expect(s.ops.added).toBe(1)
  const hit = index.search("No Judge Note", { status: "active" })[0]!
  expect(hit.entry.notes.some((n) => n.includes("judged:"))).toBe(false)
})

test("extractRuns=2: one run erroring is tolerated (logged), the other run's candidates still commit", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "flaky extraction"))
  const llm = scriptedLlmErrors([new Error("llm hiccup"), candidateJson("Fix X", "Do Y because Z.")])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 2, judges: 0 })
  expect(s.errors).toBe(0) // one-run error is tolerated, not a batch failure
  expect(s.ops.added).toBe(1)
  expect(index.ledger.isProcessed("ses_1", "sha256:h1")).toBe(true)
})

test("extractRuns=2: ALL runs erroring fails the transcript (errors++, not ledgered, retried next run)", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "always fails"))
  const failingLlm = scriptedLlmErrors([new Error("down 1"), new Error("down 2")])
  const s = await runPipeline(cfg, { llm: failingLlm, index }, { now: NOW, triage: "heuristic", extractRuns: 2, judges: 0 })
  expect(s.errors).toBe(1)
  expect(s.ops.added).toBe(0)
  expect(index.ledger.isProcessed("ses_1", "sha256:h1")).toBe(false)

  // Retry next run succeeds once the LLM is healthy again.
  const retryLlm = scriptedLlm([candidateJson("Fix X", "Do Y because Z.")])
  const retry = await runPipeline(cfg, { llm: retryLlm, index }, { now: NOW, triage: "heuristic", extractRuns: 1, judges: 0 })
  expect(retry.ops.added).toBe(1)
})

// ============ parallel extract-runs tests ============
//
// The extract loop now fans out N runs via Promise.all instead of a sequential for-loop
// (see pipeline.ts). These tests use gatedExtractLlm to force run 1 (call index 0) to
// SETTLE strictly after run 2 (call index 1), proving the pool concatenation still follows
// run-index order (not settle order) — the invariant dedupPool's greedy left-to-right merge
// depends on for determinism.

const racingCandidateJson = (lesson: string) =>
  JSON.stringify([
    { type: "pitfall", title: "Racing Duplicate", trigger: "when racing", lesson, domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: 7, volatile: false },
  ])

test("extractRuns=2 (parallel): run 1 resolving AFTER run 2 still concatenates in run-index order (tie-break merge proves it)", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "two runs racing"))
  // Both runs report the SAME (duplicate) candidate with equal-length lessons that differ
  // only in a marker letter — mergeCandidates' tie-break on equal lesson length keeps
  // whichever candidate is "a" (i.e., appears FIRST in dedupPool's result array), so the
  // surviving marker directly exposes concatenation order.
  const llm = gatedExtractLlm(
    [racingCandidateJson("Order marker AAAA text."), racingCandidateJson("Order marker BBBB text.")],
    [0], // run 1 (call index 0) is gated; run 2 (call index 1) resolves immediately
  )
  const pipelinePromise = runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 2, judges: 0 })
  // Let run 2's already-fired call resolve first, then release the slow run 1.
  await Promise.resolve()
  await Promise.resolve()
  llm.release(0)
  const s = await pipelinePromise

  expect(s.poolRaw).toBe(2)
  expect(s.candidates).toBe(1) // the two runs' candidates are duplicates -> merged to 1
  expect(s.ops.added).toBe(1)
  const hit = index.search("Racing Duplicate", { status: "active" })[0]!
  // Run 1 (index 0) is "a" in the merge despite settling last -> its lesson survives the tie.
  expect(hit.entry.lesson).toBe("Order marker AAAA text.")
})

test("extractRuns=2 (parallel): one run rejecting AFTER a delay is tolerated, the other run's candidate still commits", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "flaky racing extraction"))
  const llm = gatedExtractLlm(
    [new Error("llm hiccup, settles late"), candidateJson("Fix X", "Do Y because Z.")],
    [0], // run 1 throws, but only after being released (settles after run 2)
  )
  const pipelinePromise = runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 2, judges: 0 })
  await Promise.resolve()
  await Promise.resolve()
  llm.release(0)
  const s = await pipelinePromise

  expect(s.errors).toBe(0) // one-run error tolerated, not a batch failure
  expect(s.ops.added).toBe(1)
  expect(index.ledger.isProcessed("ses_1", "sha256:h1")).toBe(true)
})

test("extractRuns=2 (parallel): BOTH runs rejecting (one delayed) fails the transcript, not ledgered", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "always fails racing"))
  const llm = gatedExtractLlm(
    [new Error("down 1, settles late"), new Error("down 2")],
    [0], // run 1 fails late (after release); run 2 fails immediately
  )
  const pipelinePromise = runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 2, judges: 0 })
  await Promise.resolve()
  await Promise.resolve()
  llm.release(0)
  const s = await pipelinePromise

  expect(s.errors).toBe(1)
  expect(s.ops.added).toBe(0)
  expect(index.ledger.isProcessed("ses_1", "sha256:h1")).toBe(false)
})

test("judges: drops a low-median candidate, keeps a high-median one, records per-candidate judge note (not a run-level label suffix)", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "mixed quality session"))
  // Non-overlapping vocabulary (see the extractRuns=2 test above for why) — also matters
  // here so a search for the dropped candidate's title can't spuriously match the kept one.
  const llm = scriptedLlm([
    candidatesJson([
      { title: "Trivial Aside Note", lesson: "Marginal detail, low value.", salience: 7 },
      { title: "Critical Root Cause Fix", lesson: "Verified fix for the outage.", salience: 7 },
    ]),
    judgeJson(2), judgeJson(3), judgeJson(4), // Trivial Aside Note: median 3, panel 3/3 -> below salienceMin(6), dropped
    judgeJson(7), judgeJson(8), judgeJson(9), // Critical Root Cause Fix: median 8, panel 3/3 -> kept
  ])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 1, judges: 3 })
  expect(s.ops.added).toBe(1)
  expect(index.search("Trivial Aside", { status: "active" }).length).toBe(0)
  const kept = index.search("Critical Root Cause", { status: "active" })
  expect(kept.length).toBe(1)
  // The run-level " judges:N" suffix is gone from the extractor label...
  expect(kept[0]!.entry.provenance.extractor).not.toContain("judges:")
  // ...replaced by a per-candidate judge note on the entry itself (median of [7,8,9]=8,
  // 3/3 judges voted).
  expect(kept[0]!.entry.notes.some((n) => n.includes("judged: median 8 (3/3)"))).toBe(true)
})

test("full quality-pack defaults (triage llm, extractRuns 2, judges 3) run end to end", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "a full session"))
  const llm = scriptedLlm([
    triageJson(true, "contains a decision"),
    candidateJson("Full Pack Candidate", "Do it because Z."), // run 1
    candidateJson("Full Pack Candidate", "Do it because Z."), // run 2 (duplicate -> pool dedup to 1)
    judgeJson(6), judgeJson(7), judgeJson(8), // median 7, kept
  ])
  // No triage/extractRuns/judges overrides — exercises the real defaults ("llm", 2, 3).
  const s = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s.triagedOut).toBe(0)
  expect(s.poolRaw).toBe(2)
  expect(s.candidates).toBe(1)
  expect(s.ops.added).toBe(1)
  expect(llm.calls).toBe(6)
  const hit = index.search("Full Pack Candidate", { status: "active" })[0]!
  expect(hit.entry.provenance.extractor).not.toContain("judges:")
  // median of [6,7,8] = 7 (odd, middle value), 3/3 judges voted.
  expect(hit.entry.notes.some((n) => n.includes("judged: median 7 (3/3)"))).toBe(true)
})

// ============ Task 3: two-phase pipeline + determinism equivalence ============
//
// These tests use a FileScan (ledger.jsonl) store instead of the sqlite setup() helper
// above for two reasons: (1) ledger.jsonl is trivially readable/parseable straight from the
// test (no need to open a second raw sqlite connection just to inspect ledger rows), and
// (2) it keeps storeDir free of an index.db binary, so "recursively compare the store tree"
// only ever means markdown files.

const setupFilescan = () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-pipe2-"))
  const cfg = loadConfig({ AGENT_MEMORY_HOME: dir })
  mkdirSync(join(cfg.transcriptsDir, "proja"), { recursive: true })
  mkdirSync(cfg.storeDir, { recursive: true })
  const index = openMemoryIndex(cfg.storeDir, { ok: false, reason: "test" }, { warn: () => {} })
  return { dir, cfg, index }
}

// Same frontmatter shape as `transcript` above but with a parametrized time_end, so three
// transcripts processed in one run can be given a strict, unambiguous dispatch order
// (scanSpool sorts by time_end) independent of filesystem directory-listing order.
const transcriptAt = (sessionId: string, hash: string, timeEnd: string, text: string) => `---
session_id: ${sessionId}
project_dir: "/x/proja"
title: "t"
model: m
time_start: 2026-07-10T00:00:00.000Z
time_end: ${timeEnd}
turns: 2
tokens: { input: 1, output: 1 }
content_hash: ${hash}
exported_at: 2026-07-10T02:00:00.000Z
---
## T1 [00:00] User {#msg_u1}

${text}${PAD}

## T2 [00:01] Assistant {#msg_a1}

answer
`

// Recursively reads every file under `dir` into a flat { relativePath: content } object —
// used to diff two scratch stores' memories/ or quarantine/ trees byte-for-byte. A plain
// object (not a Map) so bun:test's toEqual does a real deep structural comparison.
const collectFiles = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (d: string, prefix: string) => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      const full = join(d, n)
      const rel = prefix ? `${prefix}/${n}` : n
      if (statSync(full).isDirectory()) walk(full, rel)
      else out[rel] = readFileSync(full, "utf8")
    }
  }
  walk(dir, "")
  return out
}

const readLedgerRows = (storeDir: string): Array<Record<string, unknown>> => {
  let raw: string
  try {
    raw = readFileSync(join(storeDir, "ledger.jsonl"), "utf8")
  } catch {
    return []
  }
  return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))
}

test("EQUIVALENCE: concurrency 1 vs 4 produce byte-identical store trees, equal ledger row sets (ignoring processed_at), and equal summaries", async () => {
  // Content-keyed markers embedded in each transcript's body — the FakeLlm below picks its
  // reply by inspecting req.prompt/req.system content, NEVER by call order/index, so it is
  // safe to reuse across two runs whose Phase A tasks race each other differently.
  const MARKER_A = "TRANSCRIPT-MARKER-ALPHA"
  const MARKER_B = "TRANSCRIPT-MARKER-BRAVO"
  const MARKER_C = "TRANSCRIPT-MARKER-CHARLIE"

  // All three transcripts extract the SAME candidate title (overlapping candidates) — the
  // first transcript processed in Phase B commits ADD, the other two's reconcile calls
  // collide on the same deterministic entryId(project, title, now) and fall through
  // addEntry's auto-degrade-to-UPDATE path, so both UPDATE reconcile outcomes actually fire.
  const sharedCandidateJson = (marker: string) =>
    candidateJson("Cache Warm Bug", `Warm the cache eagerly on cold start. (${marker})`)

  // ses_c's extraction ALSO reports a secret candidate alongside the shared one, so the
  // equivalence check has a non-empty quarantine/ tree to compare too, not just memories/.
  const mixedCandidateJson = () =>
    JSON.stringify([
      { type: "pitfall", title: "Cache Warm Bug", trigger: "when x", lesson: `Warm the cache eagerly on cold start. (${MARKER_C})`, domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: 7, volatile: false },
      { type: "know_how", title: "Leaked Key", trigger: "when deploying", lesson: "Never set AKIA0123456789ABCDEF as env var.", domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: 7, volatile: false },
    ])

  const buildContentKeyedLlm = (): LlmClient & { calls: number } => {
    const c = {
      calls: 0,
      describe: () => "content-fake",
      complete: async (req: LlmRequest): Promise<string> => {
        c.calls++
        // Reconcile calls are recognized by their system prompt content (never by call
        // order): always reply ADD — for the 2nd/3rd overlapping candidate this still
        // surfaces as an UPDATE because addEntry degrades an ADD to UPDATE when the
        // computed entryId collides with an already-active entry.
        if (req.system?.includes("You reconcile a candidate memory")) return JSON.stringify({ op: "ADD" })
        if (req.prompt.includes(MARKER_A)) return sharedCandidateJson(MARKER_A)
        if (req.prompt.includes(MARKER_B)) return sharedCandidateJson(MARKER_B)
        if (req.prompt.includes(MARKER_C)) return mixedCandidateJson()
        return "[]"
      },
    }
    return c
  }

  const buildStore = async (concurrency: number) => {
    const { cfg, index } = setupFilescan()
    writeFileSync(join(cfg.transcriptsDir, "proja", "ses_a.md"), transcriptAt("ses_a", "sha256:ha", "2026-07-10T01:00:00.000Z", MARKER_A))
    writeFileSync(join(cfg.transcriptsDir, "proja", "ses_b.md"), transcriptAt("ses_b", "sha256:hb", "2026-07-10T02:00:00.000Z", MARKER_B))
    writeFileSync(join(cfg.transcriptsDir, "proja", "ses_c.md"), transcriptAt("ses_c", "sha256:hc", "2026-07-10T03:00:00.000Z", MARKER_C))
    const llm = buildContentKeyedLlm()
    const summary = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 1, judges: 0, concurrency })
    return { cfg, summary, llmCalls: llm.calls }
  }

  const run1 = await buildStore(1)
  const run4 = await buildStore(4)

  // Sanity: the overlapping-candidate reconcile path actually fired (1 ADD, 2 UPDATEs), not
  // just 3 independent ADDs — this is the scenario the brief specifically asks for.
  expect(run1.summary.ops.added).toBe(1)
  expect(run1.summary.ops.updated).toBe(2)
  expect(run1.summary.quarantined).toBe(1)

  expect(run1.summary).toEqual(run4.summary)
  expect(run1.llmCalls).toBe(run4.llmCalls)

  expect(collectFiles(join(run1.cfg.storeDir, "memories"))).toEqual(collectFiles(join(run4.cfg.storeDir, "memories")))
  expect(collectFiles(join(run1.cfg.storeDir, "quarantine"))).toEqual(collectFiles(join(run4.cfg.storeDir, "quarantine")))
  expect(readFileSync(join(run1.cfg.storeDir, "INDEX.md"), "utf8")).toBe(readFileSync(join(run4.cfg.storeDir, "INDEX.md"), "utf8"))

  const strip = (rows: Array<Record<string, unknown>>) =>
    rows
      .map(({ processed_at: _processed_at, ...rest }) => rest)
      .sort((a, b) => (a.session_id as string).localeCompare(b.session_id as string))
  expect(strip(readLedgerRows(run1.cfg.storeDir))).toEqual(strip(readLedgerRows(run4.cfg.storeDir)))
})

test("phase-B ordering: transcript 1's Phase A task finishing LAST does not reorder its Phase B commit — ledger insertion order still follows metas order", async () => {
  const { cfg, index } = setupFilescan()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_first.md"), transcriptAt("ses_first", "sha256:h1", "2026-07-10T01:00:00.000Z", "gated first transcript"))
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_second.md"), transcriptAt("ses_second", "sha256:h2", "2026-07-10T02:00:00.000Z", "fast second transcript"))

  // ses_first's (metas-first) extraction call is gated — it won't settle until release()
  // is called — while ses_second's call resolves immediately. With concurrency >= 2 both
  // Phase A tasks start together, but ses_first's Phase A finishes strictly LAST.
  let releaseFirst: (() => void) | undefined
  const llm: LlmClient & { calls: number } = {
    calls: 0,
    describe: () => "gated-content-fake",
    complete: async (req: LlmRequest): Promise<string> => {
      llm.calls++
      if (req.prompt.includes("gated first transcript")) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
      }
      return "[]" // no candidates from either transcript — this test only cares about commit/ledger order
    },
  }

  const pipelinePromise = runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 1, judges: 0, concurrency: 2 })
  // Let ses_second's already-fired (ungated) call resolve first...
  await Promise.resolve()
  await Promise.resolve()
  expect(releaseFirst).toBeDefined() // ses_first's call has started and is parked on the gate
  // ...then release ses_first so its Phase A task settles last.
  releaseFirst!()
  const summary = await pipelinePromise

  expect(summary.errors).toBe(0)
  expect(summary.triagedOut).toBe(0) // both bodies clear the heuristic floor; extraction just returns "[]"
  expect(summary.candidates).toBe(0)
  const rows = readLedgerRows(cfg.storeDir)
  expect(rows.map((r) => r.session_id)).toEqual(["ses_first", "ses_second"]) // metas order, not settle order
})

test("Phase A write-freeze: every transcript's Phase A task throwing leaves the store completely untouched — no memories/, no quarantine/, no ledger row for any of them", async () => {
  const { cfg, index } = setupFilescan()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcriptAt("ses_1", "sha256:h1", "2026-07-10T01:00:00.000Z", "always fails one"))
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_2.md"), transcriptAt("ses_2", "sha256:h2", "2026-07-10T02:00:00.000Z", "always fails two"))
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_3.md"), transcriptAt("ses_3", "sha256:h3", "2026-07-10T03:00:00.000Z", "always fails three"))

  const llm: LlmClient = { describe: () => "always-throws", complete: async () => { throw new Error("llm down for every call") } }
  const summary = await runPipeline(cfg, { llm, index }, { now: NOW, triage: "heuristic", extractRuns: 1, judges: 0, concurrency: 4 })

  expect(summary.errors).toBe(3)
  expect(summary.ops).toEqual({ added: 0, updated: 0, superseded: 0, nooped: 0 })
  expect(summary.quarantined).toBe(0)
  expect(summary.candidates).toBe(0)
  expect(summary.poolRaw).toBe(0)

  // No Phase-A writes: neither memories/ nor quarantine/ was ever created.
  expect(existsSync(join(cfg.storeDir, "memories"))).toBe(false)
  expect(existsSync(join(cfg.storeDir, "quarantine"))).toBe(false)
  // No Phase-B writes either: nothing was ever ledgered (the ledger.jsonl file itself is
  // never created, since recordProcessed is never reached for an error-kind transcript).
  expect(existsSync(join(cfg.storeDir, "ledger.jsonl"))).toBe(false)
  for (const id of ["ses_1", "ses_2", "ses_3"]) expect(index.ledger.isProcessed(id, `sha256:h${id.slice(-1)}`)).toBe(false)
  // renderIndexMd still runs unconditionally (PUBLISH-once-at-the-end is not a Phase-A
  // write) but with nothing to list — this is the one file the store dir is allowed to
  // contain after a total Phase-A wipeout.
  const indexMd = readFileSync(join(cfg.storeDir, "INDEX.md"), "utf8")
  expect(indexMd).toBe("# Memory Index\n")
})

test("all-error transcript is not ledgered at concurrency 4 (error semantics unchanged by the two-phase refactor)", async () => {
  const { cfg, index } = setupFilescan()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcriptAt("ses_1", "sha256:h1", "2026-07-10T01:00:00.000Z", "always fails"))
  const failingLlm = scriptedLlmErrors([new Error("down 1"), new Error("down 2")])
  const s = await runPipeline(cfg, { llm: failingLlm, index }, { now: NOW, triage: "heuristic", extractRuns: 2, judges: 0, concurrency: 4 })
  expect(s.errors).toBe(1)
  expect(s.ops.added).toBe(0)
  expect(index.ledger.isProcessed("ses_1", "sha256:h1")).toBe(false)

  const retryLlm = scriptedLlm([candidateJson("Fix X", "Do Y because Z.")])
  const retry = await runPipeline(cfg, { llm: retryLlm, index }, { now: NOW, triage: "heuristic", extractRuns: 1, judges: 0, concurrency: 4 })
  expect(retry.ops.added).toBe(1)
})
