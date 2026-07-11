// End-to-end coverage for AGENT_MEMORY_NO_SQLITE=1 (filescan/fallback mode) driven
// through the REAL entry points (runCli, buildServer, runEval) rather than the
// MemoryQuery abstraction directly — Task 5's job is wiring, so these tests exercise
// the wiring, not indexes.ts internals (already covered by filescan.contract.test.ts).
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { runEval } from "../eval/run"
import { buildServer } from "../mcp-server/server"
import { runCli } from "./cli"
import { openMemoryIndex } from "./indexes"
import type { LlmClient } from "./llm"
import { quarantinePath, serializeEntry, writeEntry } from "./store"
import type { MemoryEntry } from "./types"

const NO_SQLITE_ENV = { AGENT_MEMORY_NO_SQLITE: "1" }

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

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, memory_class: "semantic", type: "pitfall",
  title: `SPEF pitfall ${id}`, trigger: "after ECO", project: "proja", scope: "project",
  domain: ["sta"], volatile: false, confidence: 0.65, status: "quarantined", superseded_by: null, supersedes: null,
  review: "human_pending",
  evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-01T00:00:00.000Z" }],
  provenance: { extractor: "t", prompt_hash: "sha256:aa" },
  created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
  lesson: "Re-extract SPEF parasitics before STA.", notes: [],
  ...over,
})

const WARN_PREFIX = "agent-memory: sqlite unavailable"

test("(a) fallback pipeline run: FakeLlm run in a scratch HOME writes memories, ledger.jsonl, is idempotent, renders INDEX.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-fb-pipe-"))
  // Legacy pinning: scriptedLlm below returns exactly one reply then falls back to "[]" —
  // pin the pre-quality-pack triage/extractRuns/judges semantics so it isn't desynced by
  // the new defaults (llm triage, extractRuns=2, judges=3), which issue more LLM calls.
  const env = {
    AGENT_MEMORY_HOME: dir, AGENT_MEMORY_IDLE_HOURS: "0",
    AGENT_MEMORY_TRIAGE: "heuristic", AGENT_MEMORY_EXTRACT_RUNS: "1", AGENT_MEMORY_JUDGES: "0",
    ...NO_SQLITE_ENV,
  }
  mkdirSync(join(dir, "transcripts", "proja"), { recursive: true })
  writeFileSync(join(dir, "transcripts", "proja", "ses_1.md"), transcript("ses_1", "sha256:h1", "how to fix X"))
  const llm = scriptedLlm([candidateJson("Fix X", "Do Y because Z.")])
  const out: string[] = []
  const err: string[] = []
  const deps = { llm, out: (l: string) => out.push(l), err: (l: string) => err.push(l) }

  const code1 = await runCli(["run"], env, deps)
  expect(code1).toBe(0)
  expect(out.join("\n")).toContain("1 added")

  // Memories were written to markdown and the ledger.jsonl fallback ledger exists.
  expect(existsSync(join(dir, "store", "memories", "proja"))).toBe(true)
  expect(existsSync(join(dir, "store", "ledger.jsonl"))).toBe(true)
  const indexMd = readFileSync(join(dir, "store", "INDEX.md"), "utf8")
  expect(indexMd).toContain("Fix X")

  // Exactly one fallback warning for this entry-point invocation (part d).
  expect(err.filter((l) => l.startsWith(WARN_PREFIX)).length).toBe(1)

  // Rerun is idempotent: the session is already-done, no second extraction call.
  out.length = 0
  err.length = 0
  const code2 = await runCli(["run"], env, deps)
  expect(code2).toBe(0)
  expect(out.join("\n")).toContain("already-done 1")
  expect(out.join("\n")).toContain("0 added")
  expect(llm.calls).toBe(1) // no second extraction
  expect(err.filter((l) => l.startsWith(WARN_PREFIX)).length).toBe(1)
})

test("(b) cli review -> approve -> reject flow works in filescan mode; approve moves the file and the next lookup finds it with zero upserts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-fb-cli-"))
  const env = { AGENT_MEMORY_HOME: dir, ...NO_SQLITE_ENV }
  const out: string[] = []
  const err: string[] = []
  const deps = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }

  const storeDir = join(dir, "store")
  mkdirSync(join(storeDir, "quarantine"), { recursive: true })
  const toApprove = entry("mem_fb_approve1")
  const toReject = entry("mem_fb_reject1", { title: "SPEF pitfall reject candidate" })
  writeFileSync(quarantinePath(storeDir, toApprove.id), serializeEntry(toApprove))
  writeFileSync(quarantinePath(storeDir, toReject.id), serializeEntry(toReject))

  expect(await runCli(["review"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain(toApprove.id)
  expect(out.join("\n")).toContain(toReject.id)

  out.length = 0
  err.length = 0
  expect(await runCli(["approve", toApprove.id], env, deps)).toBe(0)
  expect(out.join("\n")).toContain("approved")
  // approveEntry's final path comes from index.getById() re-scanning the filesystem
  // AFTER the move — filescan mode never calls upsertEntry, so this only works if
  // getById() picks up the moved file live.
  expect(out.join("\n")).not.toContain("(unknown path)")
  expect(err.filter((l) => l.startsWith(WARN_PREFIX)).length).toBe(1)

  expect(existsSync(quarantinePath(storeDir, toApprove.id))).toBe(false)
  const movedPath = join(storeDir, "memories", toApprove.project, `${toApprove.id}.md`)
  expect(existsSync(movedPath)).toBe(true)

  out.length = 0
  err.length = 0
  expect(await runCli(["reject", toReject.id, "--reason", "not useful"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain("rejected")
  expect(err.filter((l) => l.startsWith(WARN_PREFIX)).length).toBe(1)

  out.length = 0
  expect(await runCli(["stats"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain('"active":1')
  expect(out.join("\n")).toContain('"archived":1')
})

test("(c) buildServer + InMemoryTransport in filescan mode: search/get work; memory_stats reports mode filescan, accessAvailable false; exactly one warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-fb-srv-"))
  const storeDir = join(dir, "store")
  mkdirSync(storeDir, { recursive: true })
  const e = entry("mem_fb_srv1", { status: "active", review: "auto" })
  await writeEntry(storeDir, e) // no upsertEntry call — the filesystem alone is the index

  const warnings: string[] = []
  const index = openMemoryIndex(storeDir, { ok: false, reason: "test" }, { warn: (l) => warnings.push(l) })
  expect(index.mode).toBe("filescan")

  const server = buildServer({ index, storeDir })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(ct)

  const textOf = (res: unknown): string =>
    ((res as { content: Array<{ type: string; text: string }> }).content[0] ?? { text: "" }).text

  const searchRes = await client.callTool({ name: "search_memory", arguments: { query: "SPEF" } })
  const hits = JSON.parse(textOf(searchRes)) as Array<{ id: string }>
  expect(hits.map((h) => h.id)).toEqual(["mem_fb_srv1"])

  const getRes = await client.callTool({ name: "get_memory", arguments: { id: "mem_fb_srv1" } })
  const full = JSON.parse(textOf(getRes)) as { id: string }
  expect(full.id).toBe("mem_fb_srv1")

  const statsRes = await client.callTool({ name: "memory_stats", arguments: {} })
  const stats = JSON.parse(textOf(statsRes)) as { mode: string; accessAvailable: boolean }
  expect(stats.mode).toBe("filescan")
  expect(stats.accessAvailable).toBe(false)

  expect(warnings.length).toBe(1) // (d) exactly one warning for this entry-point invocation
  index.close()
})

test("cli reindex in filescan mode reports 'nothing to rebuild' and exits 0 without creating index.db", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-fb-reindex-"))
  const env = { AGENT_MEMORY_HOME: dir, ...NO_SQLITE_ENV }
  const out: string[] = []
  const err: string[] = []
  const deps = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }

  const storeDir = join(dir, "store")
  mkdirSync(join(storeDir, "memories", "proja"), { recursive: true })
  writeFileSync(join(storeDir, "memories", "proja", `${"mem_fb_ri1"}.md`), serializeEntry(entry("mem_fb_ri1", { status: "active", review: "auto" })))

  expect(await runCli(["reindex"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain("markdown is the store — nothing to rebuild (filescan mode)")
  expect(existsSync(join(storeDir, "index.db"))).toBe(false)
  expect(err.filter((l) => l.startsWith(WARN_PREFIX)).length).toBe(1)
})

test("(e) eval retrieval passes in fallback mode via env override, resultsPath null", async () => {
  const evalDir = join(import.meta.dir, "..", "eval")
  const lines: string[] = []
  const summary = await runEval({
    evalDir,
    mode: "retrieval",
    resultsPath: null,
    env: { ...process.env, ...NO_SQLITE_ENV },
    out: (l) => lines.push(l),
  })
  expect(summary.pass).toBe(true)
  expect(summary.retrieval?.pass).toBe(4)
  expect(summary.retrieval?.total).toBe(4)
  expect(lines.some((l) => l.startsWith("✗"))).toBe(false)
})
