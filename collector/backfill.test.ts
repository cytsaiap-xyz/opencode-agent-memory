import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../shared/config"
import { runBackfill } from "./backfill"
import { makeFixtureDb, type FixtureSession } from "./fixtures"

const rich = (id: string): FixtureSession => ({
  id,
  directory: "/x/projA",
  messages: [
    { id: `${id}_u1`, role: "user", time: 1000, parts: [{ type: "text", text: "q" }] },
    { id: `${id}_a1`, role: "assistant", time: 2000, parts: [{ type: "text", text: "a" }] },
    { id: `${id}_u2`, role: "user", time: 3000, parts: [{ type: "text", text: "q2" }] },
  ],
})

test("backfills all root sessions, skipping thin/child ones; rerun is all-unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-bf-"))
  const thin: FixtureSession = {
    id: "ses_thin", directory: "/x/projA",
    messages: [{ id: "th_u1", role: "user", time: 1, parts: [{ type: "text", text: "hi" }] }],
  }
  const child: FixtureSession = { ...rich("ses_child"), parentID: "ses_a" }
  const dbPath = makeFixtureDb(dir, [rich("ses_a"), rich("ses_b"), thin, child])
  const cfg = loadConfig({ AGENT_MEMORY_HOME: join(dir, "mem") })

  const r1 = await runBackfill(cfg, dbPath)
  expect(r1).toEqual({ written: 2, unchanged: 0, skipped: 1, errors: 0 })
  expect(readdirSync(join(cfg.transcriptsDir, "proja")).sort()).toEqual(["ses_a.md", "ses_b.md"])

  const r2 = await runBackfill(cfg, dbPath)
  expect(r2).toEqual({ written: 0, unchanged: 2, skipped: 1, errors: 0 })
})

test("limit caps processed sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-bf-"))
  const dbPath = makeFixtureDb(dir, [rich("ses_a"), rich("ses_b"), rich("ses_c")])
  const cfg = loadConfig({ AGENT_MEMORY_HOME: join(dir, "mem") })
  const r = await runBackfill(cfg, dbPath, { limit: 1 })
  expect(r.written).toBe(1)
})
