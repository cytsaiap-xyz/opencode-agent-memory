import { Database } from "bun:sqlite"

export interface SessionRow {
  id: string
  parent_id: string | null
  directory: string
  title: string
  time_created: number
  time_updated: number
  tokens_input: number
  tokens_output: number
  model: string | null
}

export interface MessageBundle {
  id: string
  time_created: number
  data: { role?: string; modelID?: string; providerID?: string } & Record<string, unknown>
}

export interface PartBundle {
  message_id: string
  data: { type?: string; text?: string; tool?: string; state?: Record<string, unknown> } & Record<string, unknown>
}

export interface SessionBundle {
  session: SessionRow
  messages: MessageBundle[]
  parts: PartBundle[]
}

const parseJson = (raw: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(raw)
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function loadSessionBundle(dbPath: string, sessionID: string): SessionBundle | null {
  const db = new Database(dbPath, { readonly: true })
  try {
    const session = db
      .query(
        `SELECT id, parent_id, directory, title, time_created, time_updated,
                tokens_input, tokens_output, model
         FROM session WHERE id = ?`,
      )
      .get(sessionID) as SessionRow | null
    if (!session) return null

    const messages: MessageBundle[] = []
    for (const row of db
      .query(`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id`)
      .all(sessionID) as Array<{ id: string; time_created: number; data: string }>) {
      const data = parseJson(row.data)
      if (data) messages.push({ id: row.id, time_created: row.time_created, data })
    }

    const parts: PartBundle[] = []
    for (const row of db
      .query(`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id`)
      .all(sessionID) as Array<{ message_id: string; data: string }>) {
      const data = parseJson(row.data)
      if (data) parts.push({ message_id: row.message_id, data })
    }

    return { session, messages, parts }
  } finally {
    db.close()
  }
}

export function listRootSessionIDs(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.query(`SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated`).all() as Array<{ id: string }>)
      .map((r) => r.id)
  } finally {
    db.close()
  }
}
