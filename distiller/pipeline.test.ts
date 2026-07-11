import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../shared/config"
import type { LlmClient } from "./llm"
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

const candidateJson = (title: string, lesson: string) =>
  JSON.stringify([{ type: "pitfall", title, trigger: "when x", lesson, domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: 8, volatile: false }])

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

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-pipe-"))
  const cfg = loadConfig({ AGENT_MEMORY_HOME: dir })
  mkdirSync(join(cfg.transcriptsDir, "proja"), { recursive: true })
  mkdirSync(cfg.storeDir, { recursive: true })
  const index = openMemoryIndex(cfg.storeDir, { ok: true })
  return { dir, cfg, index }
}
const NOW = new Date("2026-07-11T00:00:00.000Z") // 23h after time_end -> eligible at idleHours=6

test("end-to-end: extract -> add; rerun is idempotent; INDEX.md rendered", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "how to fix X"))
  const llm = scriptedLlm([candidateJson("Fix X", "Do Y because Z.")])
  const s1 = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s1.eligible).toBe(1)
  expect(s1.ops.added).toBe(1)
  expect(s1.errors).toBe(0)
  expect(index.search("Fix X", { status: "active" }).length).toBe(1)
  const indexMd = readFileSync(join(cfg.storeDir, "INDEX.md"), "utf8")
  expect(indexMd).toContain("Fix X")

  const s2 = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s2.skippedProcessed).toBe(1)
  expect(s2.ops.added).toBe(0)
  expect(llm.calls).toBe(1) // no second extraction
})

test("idle window and thin transcripts are respected", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "text"))
  const early = await runPipeline(cfg, { llm: scriptedLlm([]), index }, { now: new Date("2026-07-10T02:00:00.000Z") })
  expect(early.eligible).toBe(0)

  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_thin.md"),
    transcript("ses_thin", "sha256:h2", "hi").replace(PAD, "")) // short body
  const s = await runPipeline(cfg, { llm: scriptedLlm([]), index }, { now: NOW })
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
  const s1 = await runPipeline(cfg, { llm, index }, { now: NOW })
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
  const s2 = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s2.ops.updated).toBe(1)
  expect(index.search("SPEF")[0]!.entry.evidence.length).toBe(2)
})

test("secret candidates land in quarantine, not the store", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "leaky"))
  const llm = scriptedLlm([candidateJson("Key setup", "Set AKIA0123456789ABCDEF first.")])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s.quarantined).toBe(1)
  expect(s.ops.added).toBe(0)
  expect(index.search("Key setup", { status: "quarantined" }).length).toBe(1)
  expect(existsSync(join(cfg.storeDir, "quarantine"))).toBe(true)
})

test("LLM failure counts an error, leaves session unprocessed for retry", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "text"))
  const llm: LlmClient = { describe: () => "f", complete: async () => { throw new Error("llm down") } }
  const s = await runPipeline(cfg, { llm, index }, { now: NOW })
  expect(s.errors).toBe(1)
  expect(index.ledger.isProcessed("ses_1", "sha256:h1")).toBe(false)
  const retry = await runPipeline(cfg, { llm: scriptedLlm([candidateJson("Fix X", "Do Y.")]), index }, { now: NOW })
  expect(retry.ops.added).toBe(1)
})

test("quarantined entries render in INDEX.md under ## Quarantine section", async () => {
  const { cfg, index } = setup()
  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "leaky"))
  const llm = scriptedLlm([candidateJson("Key setup", "Set AKIA0123456789ABCDEF first.")])
  const s = await runPipeline(cfg, { llm, index }, { now: NOW })
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
  const s1 = await runPipeline(cfg, { llm: scriptedLlm([candidateJson(title, "Do the thing.")]), index }, { now: NOW })
  expect(s1.ops.added).toBe(1)
  const activeId = index.search(title, { status: "active" })[0]!.entry.id

  writeFileSync(join(cfg.transcriptsDir, "proja", "ses_2.md"), transcript("ses_2", "sha256:h2", "leaky topic"))
  const s2 = await runPipeline(
    cfg,
    { llm: scriptedLlm([candidateJson(title, "Set AKIA0123456789ABCDEF first.")]), index },
    { now: NOW },
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
  const s = await runPipeline(cfg, { llm, index }, { now: NOW })
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
    domain: ["d"], volatile: false, confidence: 0.5, status: "quarantined", superseded_by: null, supersedes: null,
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
