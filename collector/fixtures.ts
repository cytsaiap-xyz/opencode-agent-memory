import { Database } from "bun:sqlite"
import { join } from "node:path"

export interface FixtureMessage {
  id: string
  role: "user" | "assistant"
  time: number
  parts: Array<Record<string, unknown>>
  modelID?: string
}

export interface FixtureSession {
  id: string
  directory?: string
  title?: string
  parentID?: string | null
  model?: string | null
  messages: FixtureMessage[]
}

/** Creates a minimal opencode.db matching the real production DDL (columns used by the collector). */
export function makeFixtureDb(dir: string, sessions: FixtureSession[]): string {
  const path = join(dir, "opencode.db")
  const db = new Database(path, { create: true })
  db.run(`CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
    directory text NOT NULL, title text NOT NULL, version text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL,
    model text, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL)`)
  db.run(`CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, data text NOT NULL)`)
  db.run(`CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`)

  let partSeq = 0
  for (const s of sessions) {
    const times = s.messages.map((m) => m.time)
    const t0 = Math.min(...(times.length ? times : [1000]))
    const t1 = Math.max(...(times.length ? times : [1000]))
    db.run(
      `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, model)
       VALUES (?, 'prj', ?, 'slug', ?, ?, '1.0.0', ?, ?, ?)`,
      [s.id, s.parentID ?? null, s.directory ?? "/tmp/proj", s.title ?? "fixture", t0, t1, s.model ?? null],
    )
    for (const m of s.messages) {
      const data: Record<string, unknown> = { role: m.role, time: { created: m.time } }
      if (m.modelID) data.modelID = m.modelID
      db.run(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`, [
        m.id, s.id, m.time, m.time, JSON.stringify(data),
      ])
      for (const p of m.parts) {
        partSeq++
        db.run(
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
          [`prt_${String(partSeq).padStart(6, "0")}`, m.id, s.id, m.time, m.time, JSON.stringify(p)],
        )
      }
    }
  }
  db.close()
  return path
}
