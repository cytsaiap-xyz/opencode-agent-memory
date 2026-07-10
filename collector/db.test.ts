import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSessionBundle, listRootSessionIDs } from "./db"
import { makeFixtureDb } from "./fixtures"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-db-"))

test("loadSessionBundle returns typed session, ordered messages, parsed parts", () => {
  const db = makeFixtureDb(tmp(), [
    {
      id: "ses_a",
      directory: "/x/projA",
      title: "hello",
      messages: [
        { id: "msg_2", role: "assistant", time: 2000, parts: [{ type: "text", text: "hi back" }], modelID: "m1" },
        { id: "msg_1", role: "user", time: 1000, parts: [{ type: "text", text: "hi" }] },
      ],
    },
  ])
  const b = loadSessionBundle(db, "ses_a")
  expect(b).not.toBeNull()
  expect(b!.session.title).toBe("hello")
  expect(b!.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]) // time-ordered
  expect(b!.messages[0]!.data.role).toBe("user")
  expect(b!.parts.filter((p) => p.message_id === "msg_1")[0]!.data.text).toBe("hi")
})

test("loadSessionBundle returns null for unknown session", () => {
  const db = makeFixtureDb(tmp(), [])
  expect(loadSessionBundle(db, "ses_missing")).toBeNull()
})

test("loadSessionBundle tolerates corrupt part JSON (skips the part)", () => {
  const dir = tmp()
  const db = makeFixtureDb(dir, [
    { id: "ses_a", messages: [{ id: "msg_1", role: "user", time: 1, parts: [{ type: "text", text: "ok" }] }] },
  ])
  const { Database } = require("bun:sqlite")
  const raw = new Database(db)
  raw.run(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES ('prt_bad', 'msg_1', 'ses_a', 1, 1, '{not json')`)
  raw.close()
  const b = loadSessionBundle(db, "ses_a")
  expect(b!.parts.length).toBe(1) // corrupt part dropped, valid part kept
})

test("listRootSessionIDs excludes child sessions", () => {
  const db = makeFixtureDb(tmp(), [
    { id: "ses_root", messages: [{ id: "m1", role: "user", time: 1, parts: [] }] },
    { id: "ses_child", parentID: "ses_root", messages: [{ id: "m2", role: "user", time: 2, parts: [] }] },
  ])
  expect(listRootSessionIDs(db)).toEqual(["ses_root"])
})

test("opens the database read-only", () => {
  const db = makeFixtureDb(tmp(), [])
  // loadSessionBundle must not create tables/rows; verify by opening a fresh nonexistent path
  expect(() => loadSessionBundle(join(tmp(), "nope.db"), "x")).toThrow()
})
