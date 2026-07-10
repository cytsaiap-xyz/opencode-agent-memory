import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../shared/config"
import { exportSession } from "./export"
import { makeFixtureDb, type FixtureSession } from "./fixtures"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-exp-"))

const richSession = (id: string, dir = "/x/projA"): FixtureSession => ({
  id,
  directory: dir,
  messages: [
    { id: `${id}_u1`, role: "user", time: 1000, parts: [{ type: "text", text: "q1" }] },
    { id: `${id}_a1`, role: "assistant", time: 2000, parts: [{ type: "text", text: "a1" }] },
    { id: `${id}_u2`, role: "user", time: 3000, parts: [{ type: "text", text: "q2" }] },
  ],
})

const setup = (sessions: FixtureSession[]) => {
  const dir = tmp()
  const dbPath = makeFixtureDb(dir, sessions)
  const cfg = loadConfig({ AGENT_MEMORY_HOME: join(dir, "mem") })
  return { dbPath, cfg }
}

test("writes transcript to <transcripts>/<slug>/<id>.md", async () => {
  const { dbPath, cfg } = setup([richSession("ses_a")])
  const r = await exportSession(cfg, dbPath, "ses_a", new Date(0))
  expect(r.status).toBe("written")
  expect(r.path).toBe(join(cfg.transcriptsDir, "proja", "ses_a.md"))
  expect(readFileSync(r.path!, "utf8")).toContain("## T1")
})

test("second export of unchanged session is 'unchanged' and does not rewrite", async () => {
  const { dbPath, cfg } = setup([richSession("ses_a")])
  const first = await exportSession(cfg, dbPath, "ses_a", new Date(0))
  const mtime1 = statSync(first.path!).mtimeMs
  const second = await exportSession(cfg, dbPath, "ses_a", new Date(999999))
  expect(second.status).toBe("unchanged")
  expect(statSync(first.path!).mtimeMs).toBe(mtime1)
})

test("skips: unknown id, child session, ignored project, too few user turns", async () => {
  const child: FixtureSession = { ...richSession("ses_c"), parentID: "ses_a" }
  const thin: FixtureSession = {
    id: "ses_t", directory: "/x/projA",
    messages: [{ id: "t_u1", role: "user", time: 1, parts: [{ type: "text", text: "hi" }] }],
  }
  const ignored = richSession("ses_i", "/x/secret-proj")
  const { dbPath, cfg } = setup([richSession("ses_a"), child, thin, ignored])
  const cfgIgnore = { ...cfg, ignoredProjects: ["secret-proj"] }

  expect((await exportSession(cfg, dbPath, "ses_missing")).reason).toBe("not found")
  expect((await exportSession(cfg, dbPath, "ses_c")).reason).toBe("child session")
  expect((await exportSession(cfg, dbPath, "ses_t")).reason).toBe("too few user turns")
  expect((await exportSession(cfgIgnore, dbPath, "ses_i")).reason).toBe("ignored project")
})

test("re-export after session grows overwrites with new hash", async () => {
  const dir = tmp()
  const grown = richSession("ses_g")
  const dbPath = makeFixtureDb(dir, [grown])
  const cfg = loadConfig({ AGENT_MEMORY_HOME: join(dir, "mem") })
  const first = await exportSession(cfg, dbPath, "ses_g", new Date(0))
  const { Database } = require("bun:sqlite")
  const raw = new Database(dbPath)
  raw.run(`INSERT INTO message (id, session_id, time_created, time_updated, data)
           VALUES ('ses_g_a2', 'ses_g', 4000, 4000, '{"role":"assistant"}')`)
  raw.run(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES ('prt_new', 'ses_g_a2', 'ses_g', 4000, 4000, '{"type":"text","text":"more"}')`)
  raw.close()
  const second = await exportSession(cfg, dbPath, "ses_g", new Date(0))
  expect(second.status).toBe("written")
  expect(readFileSync(first.path!, "utf8")).toContain("more")
})

test("unchanged detection works with long session title (700+ chars)", async () => {
  const longTitle = "t".repeat(700)
  const longTitleSession: FixtureSession = {
    ...richSession("ses_long"),
    title: longTitle,
  }
  const { dbPath, cfg } = setup([longTitleSession])
  const first = await exportSession(cfg, dbPath, "ses_long", new Date(0))
  expect(first.status).toBe("written")
  const mtime1 = statSync(first.path!).mtimeMs
  const second = await exportSession(cfg, dbPath, "ses_long", new Date(999999))
  expect(second.status).toBe("unchanged")
  expect(statSync(first.path!).mtimeMs).toBe(mtime1)
})
