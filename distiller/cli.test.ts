import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "./cli"
import type { LlmClient } from "./llm"

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
