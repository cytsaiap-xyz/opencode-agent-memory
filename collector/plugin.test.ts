import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as entry from "./plugin-entry"
import { createCollectorPlugin } from "./plugin"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-plg-"))

const pollFile = async (path: string, timeoutMs = 2000): Promise<string> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const f = Bun.file(path)
    if (await f.exists()) {
      const text = await f.text()
      if (text.length > 0) return text
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timeout waiting for ${path}`)
}

const ctx = { client: {}, directory: "/tmp", worktree: "/tmp" } as never

test("bundle entry exports only plugin functions (loader contract)", () => {
  const values = Object.values(entry)
  expect(values.length).toBeGreaterThan(0)
  for (const v of values) expect(typeof v).toBe("function")
})

test("session.idle triggers export and logs the outcome", async () => {
  const home = join(tmp(), "mem")
  const calls: string[] = []
  const plugin = createCollectorPlugin({
    env: { AGENT_MEMORY_HOME: home },
    exportSession: async (_cfg, _db, id) => {
      calls.push(id)
      return { status: "written", path: "/x" }
    },
  })
  const hooks = await plugin(ctx)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_x" } } as never })
  expect(calls).toEqual(["ses_x"])
  const log = await pollFile(join(home, "collector.log"))
  expect(log).toContain("ses_x: written")
})

test("non-idle events are ignored", async () => {
  const calls: string[] = []
  const plugin = createCollectorPlugin({
    env: { AGENT_MEMORY_HOME: join(tmp(), "mem") },
    exportSession: async () => {
      calls.push("no")
      return { status: "written" }
    },
  })
  const hooks = await plugin(ctx)
  await hooks.event!({ event: { type: "session.updated", properties: {} } as never })
  expect(calls).toEqual([])
})

test("exporter failure is swallowed and logged, never thrown", async () => {
  const home = join(tmp(), "mem")
  const plugin = createCollectorPlugin({
    env: { AGENT_MEMORY_HOME: home },
    exportSession: async () => {
      throw new Error("db exploded")
    },
  })
  const hooks = await plugin(ctx)
  await expect(
    hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_x" } } as never }),
  ).resolves.toBeUndefined()
  const log = await pollFile(join(home, "collector.log"))
  expect(log).toContain("ERROR")
  expect(log).toContain("db exploded")
})
