import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "./cli"
import type { LlmClient } from "./llm"
import { writeEntry } from "./store"
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

const fakeLlmReply = (reply: string): LlmClient => ({ describe: () => "fake", complete: async () => reply })

test("run distills and prints summary; stats and review reflect state", async () => {
  const { dir, env, out, deps } = setup()
  mkdirSync(join(dir, "transcripts", "proja"), { recursive: true })
  writeFileSync(join(dir, "transcripts", "proja", "ses_1.md"), transcript)
  expect(await runCli(["run"], env, { ...deps, llm })).toBe(0)
  expect(out.join("\n")).toContain("1 added")
  // FIX 5: summary line additionally surfaces pool raw->deduped and the triage split.
  // Defaults (triage llm, extractRuns 2, judges 3): the fixed `llm` always returns the
  // same candidate array — the triage call parses it as an invalid triage shape and fails
  // open (not counted in either triage bucket), the 2 extract runs both find the same
  // candidate (poolRaw 2 -> deduped to 1), and all 3 judges abstain (same array isn't a
  // valid judge JSON shape either) so the candidate's self-score stands.
  expect(out.join("\n")).toContain("pool 2->1")
  expect(out.join("\n")).toContain("triaged llm:0/heur:0")

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

test("bad AGENT_MEMORY_TRIAGE / AGENT_MEMORY_EXTRACT_RUNS / AGENT_MEMORY_JUDGES are friendly errors", async () => {
  const { env, err, deps } = setup()
  err.length = 0
  expect(await runCli(["run"], { ...env, AGENT_MEMORY_TRIAGE: "vibes" }, deps)).toBe(1)
  expect(err.join("\n")).toContain("AGENT_MEMORY_TRIAGE")

  err.length = 0
  expect(await runCli(["run"], { ...env, AGENT_MEMORY_EXTRACT_RUNS: "0" }, deps)).toBe(1)
  expect(err.join("\n")).toContain("AGENT_MEMORY_EXTRACT_RUNS")

  err.length = 0
  expect(await runCli(["run"], { ...env, AGENT_MEMORY_EXTRACT_RUNS: "6" }, deps)).toBe(1)
  expect(err.join("\n")).toContain("AGENT_MEMORY_EXTRACT_RUNS")

  err.length = 0
  expect(await runCli(["run"], { ...env, AGENT_MEMORY_EXTRACT_RUNS: "1.5" }, deps)).toBe(1)
  expect(err.join("\n")).toContain("AGENT_MEMORY_EXTRACT_RUNS")

  err.length = 0
  expect(await runCli(["run"], { ...env, AGENT_MEMORY_JUDGES: "-1" }, deps)).toBe(1)
  expect(err.join("\n")).toContain("AGENT_MEMORY_JUDGES")

  err.length = 0
  expect(await runCli(["run"], { ...env, AGENT_MEMORY_JUDGES: "6" }, deps)).toBe(1)
  expect(err.join("\n")).toContain("AGENT_MEMORY_JUDGES")
})

test("AGENT_MEMORY_TRIAGE=heuristic + AGENT_MEMORY_EXTRACT_RUNS=1 + AGENT_MEMORY_JUDGES=0 pin legacy single-pass behavior end to end via the CLI", async () => {
  const { dir, env, out, deps } = setup()
  mkdirSync(join(dir, "transcripts", "proja"), { recursive: true })
  writeFileSync(join(dir, "transcripts", "proja", "ses_1.md"), transcript)
  let calls = 0
  const singlePassLlm: LlmClient = {
    describe: () => "fake",
    complete: async () => {
      calls++
      return JSON.stringify([{ type: "know_how", title: "Tip", trigger: "when", lesson: "Do it.", domain: ["d"], evidence: [{ message_id: "msg_u1" }], salience: 8, volatile: false }])
    },
  }
  const legacyEnv = { ...env, AGENT_MEMORY_TRIAGE: "heuristic", AGENT_MEMORY_EXTRACT_RUNS: "1", AGENT_MEMORY_JUDGES: "0" }
  expect(await runCli(["run"], legacyEnv, { ...deps, llm: singlePassLlm })).toBe(0)
  expect(out.join("\n")).toContain("1 added")
  expect(calls).toBe(1) // heuristic triage + single extract run + no judges -> exactly one LLM call
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
    promoted_from: null,
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
    promoted_from: null,
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

// ---------------------------------------------------------------------------
// reflect
// ---------------------------------------------------------------------------

const reflectEntry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
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

const seedClusterableEntries = async (dir: string) => {
  const a = reflectEntry("mem_20260710_aaaaaa", {
    title: "hold violations after ECO route", trigger: "post route ECO", domain: ["sta"],
    evidence: [{ session: "ses_x1", anchors: ["m1"], observed_at: "2026-07-10T00:00:00.000Z" }],
  })
  const b = reflectEntry("mem_20260710_bbbbbb", {
    title: "hold slack negative after ECO route", trigger: "post route ECO", domain: ["sta"],
    evidence: [{ session: "ses_x2", anchors: ["m2"], observed_at: "2026-07-10T00:00:00.000Z" }],
  })
  await writeEntry(join(dir, "store"), a)
  await writeEntry(join(dir, "store"), b)
  return { a, b }
}

const insightReply = JSON.stringify({
  op: "insight", type: "know_how", title: "ECO route hold pattern",
  trigger: "after ECO route change", lesson: "Recheck hold slack after every ECO route.",
  domain: ["sta"], cites: ["mem_20260710_aaaaaa", "mem_20260710_bbbbbb"],
})

const fileSweep = (dir: string): Array<{ path: string; mtime: number }> => {
  const out: Array<{ path: string; mtime: number }> = []
  const walk = (d: string) => {
    let names: string[]
    try {
      names = readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    } catch {
      return
    }
    for (const n of names) {
      const p = join(d, n.endsWith("/") ? n.slice(0, -1) : n)
      if (n.endsWith("/")) walk(p)
      else out.push({ path: p, mtime: statSync(p).mtimeMs })
    }
  }
  walk(dir)
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

test("reflect: happy path prints insight/merge/promotion counters and exits 0", async () => {
  const { dir, env, out, deps } = setup()
  await seedClusterableEntries(dir)

  const reflectEnv = { ...env, AGENT_MEMORY_JUDGES: "0" }
  const rc = await runCli(["reflect"], reflectEnv, { ...deps, llm: fakeLlmReply(insightReply) })
  expect(rc).toBe(0)
  const line = out.join("\n")
  expect(line).toContain("reflect done: 1 insights, 0 merges (0 pending review), 0 promotions queued, 1 clusters examined, 0 skipped, 0 errors")
})

test("reflect --dry-run makes zero writes to the store", async () => {
  const { dir, env, out, deps } = setup()
  await seedClusterableEntries(dir)

  // Filescan mode (AGENT_MEMORY_NO_SQLITE=1) avoids an incidental index.db file being
  // created by simply OPENING the index, so the before/after sweep is a clean signal on
  // the memories/quarantine markdown tree only.
  const reflectEnv = { ...env, AGENT_MEMORY_JUDGES: "0", AGENT_MEMORY_NO_SQLITE: "1" }
  const before = fileSweep(join(dir, "store"))
  const rc = await runCli(["reflect", "--dry-run"], reflectEnv, { ...deps, llm: fakeLlmReply(insightReply) })
  expect(rc).toBe(0)
  const after = fileSweep(join(dir, "store"))
  expect(after).toEqual(before)
  // Sanity: the dry-run really did see and plan the cluster op (not just skip everything).
  expect(out.join("\n")).toContain("reflect done: 1 insights, 0 merges (0 pending review), 0 promotions queued, 1 clusters examined, 0 skipped, 0 errors")
})

test("reflect --project filters clustering to the given project", async () => {
  const { dir, env, out, deps } = setup()
  await seedClusterableEntries(dir)

  const reflectEnv = { ...env, AGENT_MEMORY_JUDGES: "0" }
  const rc = await runCli(["reflect", "--project", "other-project"], reflectEnv, { ...deps, llm: fakeLlmReply(insightReply) })
  expect(rc).toBe(0)
  expect(out.join("\n")).toContain("reflect done: 0 insights, 0 merges (0 pending review), 0 promotions queued, 0 clusters examined, 0 skipped, 0 errors")
})

test("reflect exits 2 when a cluster op errors (bad LLM JSON)", async () => {
  const { dir, env, out, deps } = setup()
  await seedClusterableEntries(dir)

  const reflectEnv = { ...env, AGENT_MEMORY_JUDGES: "0" }
  const rc = await runCli(["reflect"], reflectEnv, { ...deps, llm: fakeLlmReply("not json") })
  expect(rc).toBe(2)
  expect(out.join("\n")).toContain("1 errors")
})

test("reflect: unknown flag is a friendly error", async () => {
  const { env, err, deps } = setup()
  expect(await runCli(["reflect", "--bogus"], env, deps)).toBe(1)
  expect(err.join("\n")).toContain('unknown flag "--bogus"')
})

test("reflect: --project without a value is a friendly error", async () => {
  const { env, err, deps } = setup()
  expect(await runCli(["reflect", "--project"], env, deps)).toBe(1)
  expect(err.join("\n")).toContain("--project needs a value")
})

test("review -> approve -> review empty -> re-approve fails; reject unknown id is a friendly error", async () => {
  const { dir, env, out, err, deps } = setup()

  // Seed a quarantined pending entry directly (no LLM run needed).
  mkdirSync(join(dir, "store", "quarantine"), { recursive: true })
  const { serializeEntry } = await import("./store")
  const { openMemoryIndex } = await import("./indexes")
  const pending: MemoryEntry = {
    id: "mem_20260710_pend01",
    memory_class: "semantic",
    type: "know_how",
    title: "Pending Review Entry",
    trigger: "when reviewing cli",
    project: "proja",
    scope: "project",
    domain: ["testing"],
    volatile: false,
    confidence: 0.5,
    status: "quarantined",
    superseded_by: null,
    supersedes: null,
    promoted_from: null,
    review: "human_pending",
    evidence: [{ session: "ses_1", anchors: ["msg_u1"], observed_at: "2026-07-10T00:00:00.000Z" }],
    provenance: { extractor: "test", prompt_hash: "h1" },
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    lesson: "This entry is pending human review.",
    notes: ["pending"],
  }
  const qPath = join(dir, "store", "quarantine", `${pending.id}.md`)
  writeFileSync(qPath, serializeEntry(pending))
  const seedIndex = openMemoryIndex(join(dir, "store"), { ok: true })
  seedIndex.upsertEntry(pending, qPath)
  seedIndex.close()

  out.length = 0
  expect(await runCli(["review"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain(pending.id)

  out.length = 0
  expect(await runCli(["approve", pending.id], env, deps)).toBe(0)
  expect(out.join("\n")).toContain("approved")

  out.length = 0
  expect(await runCli(["review"], env, deps)).toBe(0)
  expect(out.join("\n")).toContain("quarantine empty")

  err.length = 0
  expect(await runCli(["approve", pending.id], env, deps)).toBe(1)
  expect(err.join("\n")).toContain("not pending")

  err.length = 0
  expect(await runCli(["reject", "mem_nope"], env, deps)).toBe(1)
  expect(err.join("\n")).toContain("not found")
})
