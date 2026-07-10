import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "./cli"
import type { LlmClient } from "./llm"
import type { MemoryEntry } from "./types"

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-cli-"))
  const env = { AGENT_MEMORY_HOME: dir, AGENT_MEMORY_IDLE_HOURS: "0" }
  const out: string[] = []
  const err: string[] = []
  const deps = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }
  return { dir, env, out, err, deps }
}

const PAD = "\n\npadding ".repeat(60)
const transcript = `---
session_id: ses_1
project_dir: "/x/proja"
title: "t"
model: m
time_start: 2026-07-10T00:00:00.000Z
time_end: 2026-07-10T01:00:00.000Z
turns: 2
tokens: { input: 1, output: 1 }
content_hash: sha256:h1
exported_at: 2026-07-10T02:00:00.000Z
---
## T1 [00:00] User {#msg_u1}

question${PAD}

## T2 [00:01] Assistant {#msg_a1}

answer
`

const llm: LlmClient = {
  describe: () => "fake",
  complete: async () =>
    JSON.stringify([{ type: "know_how", title: "Tip", trigger: "when", lesson: "Do it.", domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: 8, volatile: false }]),
}

test("run distills and prints summary; stats and review reflect state", async () => {
  const { dir, env, out, deps } = setup()
  mkdirSync(join(dir, "transcripts", "proja"), { recursive: true })
  writeFileSync(join(dir, "transcripts", "proja", "ses_1.md"), transcript)
  expect(await runCli(["run"], env, { ...deps, llm })).toBe(0)
  expect(out.join("\n")).toContain("1 added")

  out.length = 0
  expect(await runCli(["stats"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain('"active":1')

  out.length = 0
  expect(await runCli(["review"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain("quarantine empty")
})

test("reindex rebuilds from markdown after index.db deletion", async () => {
  const { dir, env, out, deps } = setup()
  mkdirSync(join(dir, "transcripts", "proja"), { recursive: true })
  writeFileSync(join(dir, "transcripts", "proja", "ses_1.md"), transcript)
  await runCli(["run"], env, { ...deps, llm })
  const { rmSync } = await import("node:fs")
  rmSync(join(dir, "store", "index.db"))
  out.length = 0
  expect(await runCli(["reindex"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain("reindexed 1")
})

test("unknown command and bad env are friendly errors", async () => {
  const { env, err, deps } = setup()
  expect(await runCli(["yolo"], env, deps)).toBe(1)
  expect(err.join("\n")).toContain("usage")
  expect(await runCli(["run"], { ...env, AGENT_MEMORY_IDLE_HOURS: "banana" }, deps)).toBe(1)
  expect(err.join("\n")).toContain("AGENT_MEMORY_IDLE_HOURS")
})

test("review skips corrupt entry files instead of hiding or failing", async () => {
  const { dir, env, out, err, deps } = setup()
  mkdirSync(join(dir, "transcripts", "proja"), { recursive: true })
  writeFileSync(join(dir, "transcripts", "proja", "ses_1.md"), transcript)
  expect(await runCli(["run"], env, { ...deps, llm })).toBe(0)

  // Create a valid quarantined entry
  mkdirSync(join(dir, "store", "quarantine"), { recursive: true })
  const { serializeEntry } = await import("./store")
  const validQuarantined: MemoryEntry = {
    id: "mem_q1",
    memory_class: "semantic",
    type: "know_how",
    title: "Valid Quarantine",
    trigger: "when reviewing",
    project: "proja",
    scope: "project",
    domain: ["testing"],
    volatile: false,
    confidence: 0.8,
    status: "quarantined",
    superseded_by: null,
    supersedes: null,
    review: "human_pending",
    evidence: [{ session: "ses_1", anchors: ["msg_u1"], observed_at: "2026-07-10T00:00:00.000Z" }],
    provenance: { extractor: "test", prompt_hash: "h1" },
    created_at: "2026-07-10T02:00:00.000Z",
    updated_at: "2026-07-10T02:00:00.000Z",
    lesson: "This is a valid quarantined entry.",
    notes: ["Review pending"],
  }
  writeFileSync(join(dir, "store", "quarantine", "zzz_valid.md"), serializeEntry(validQuarantined))

  // Add corrupt file in quarantine
  writeFileSync(join(dir, "store", "quarantine", "aaa_bad.md"), "not a valid entry")

  // Add corrupt file in memories
  mkdirSync(join(dir, "store", "memories", "proja"), { recursive: true })
  writeFileSync(join(dir, "store", "memories", "proja", "bad.md"), "corrupt memory")

  out.length = 0
  err.length = 0
  expect(await runCli(["review"], env, deps)).toBe(0)
  const outText = out.join("\n")
  const errText = err.join("\n")

  // Should list valid entry
  expect(outText).toContain("mem_q1")
  expect(outText).toContain("Valid Quarantine")
  // Should NOT say quarantine is empty
  expect(outText).not.toContain("quarantine empty")
  // Should emit warnings for corrupt files
  expect(errText).toContain("quarantine/aaa_bad.md")
  expect(errText).toContain("memories/proja/bad.md")
})

test("v1-schema index is auto-rebuilt on first access with rebuild notice on stderr", async () => {
  const { dir, env, out, err, deps } = setup()

  // Create v1-schema database manually
  mkdirSync(join(dir, "store", "memories", "proja"), { recursive: true })
  const dbPath = join(dir, "store", "index.db")
  const oldDb = new (await import("bun:sqlite")).Database(dbPath, { create: true })
  const oldDDL = `
    CREATE TABLE IF NOT EXISTS processed_sessions (
      session_id TEXT NOT NULL, content_hash TEXT NOT NULL, pipeline_version TEXT NOT NULL,
      extractor_model TEXT NOT NULL, processed_at TEXT NOT NULL,
      n_candidates INTEGER NOT NULL, n_committed INTEGER NOT NULL,
      PRIMARY KEY (session_id, content_hash, pipeline_version)
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
      confidence REAL NOT NULL, volatile INTEGER NOT NULL, path TEXT NOT NULL,
      updated_at TEXT NOT NULL, access_count INTEGER NOT NULL DEFAULT 0, last_accessed TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, trigger, lesson, domain);
  `
  oldDb.run(oldDDL)
  // Insert a dummy entry
  oldDb.run(`INSERT INTO memories (id, project, type, status, confidence, volatile, path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["mem_1", "proja", "pitfall", "active", 0.5, 0, join(dir, "store", "memories", "proja", "mem_1.md"), "2026-07-10T00:00:00.000Z"])
  // Don't set user_version (v0/v1 database)
  oldDb.close()

  // Write a valid entry to the store so rebuild can index it
  const { serializeEntry } = await import("./store")
  const entry1: MemoryEntry = {
    id: "mem_1",
    memory_class: "semantic",
    type: "pitfall",
    title: "Rebuild Test",
    trigger: "when testing",
    project: "proja",
    scope: "project",
    domain: ["testing"],
    volatile: false,
    confidence: 0.5,
    status: "active",
    superseded_by: null,
    supersedes: null,
    review: "auto",
    evidence: [{ session: "ses_1", anchors: ["msg_u1"], observed_at: "2026-07-10T00:00:00.000Z" }],
    provenance: { extractor: "test", prompt_hash: "h1" },
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    lesson: "Test entry for rebuild.",
    notes: [],
  }
  writeFileSync(join(dir, "store", "memories", "proja", "mem_1.md"), serializeEntry(entry1))

  // Run stats — should trigger rebuild
  expect(await runCli(["stats"], env, deps)).toBe(0)

  // Check output
  const outText = out.join("\n")
  const errText = err.join("\n")

  // Stats should show the entry
  expect(outText).toContain('"active":1')
  // stderr should contain the rebuild notice
  expect(errText).toContain("rebuilding index")
})
