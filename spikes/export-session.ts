// SPIKE: export one opencode session from opencode.db as a human-readable
// markdown transcript (prototype of the collector's intermediate format).
// Usage: bun spikes/export-session.ts <session_id> [out_dir]
import { Database } from "bun:sqlite"

const sessionID = process.argv[2]
if (!sessionID) {
  console.error("usage: bun export-session.ts <session_id> [out_dir]")
  process.exit(1)
}
const outDir = process.argv[3] ?? `${import.meta.dir}/out`

const dbPath = `${process.env.HOME}/.local/share/opencode/opencode.db`
const db = new Database(dbPath, { readonly: true })

type Row = Record<string, unknown>
const session = db.query("SELECT * FROM session WHERE id = ?").get(sessionID) as Row | null
if (!session) {
  console.error(`session ${sessionID} not found`)
  process.exit(1)
}

const messages = db
  .query("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id")
  .all(sessionID) as Array<{ id: string; data: string; time_created: number }>

const partsByMessage = new Map<string, Array<Row>>()
for (const p of db
  .query("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id")
  .all(sessionID) as Array<{ message_id: string; data: string }>) {
  const list = partsByMessage.get(p.message_id) ?? []
  list.push(JSON.parse(p.data))
  partsByMessage.set(p.message_id, list)
}

const ts = (ms: number) => new Date(ms).toISOString()
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

function toolSummary(part: Row): string {
  const tool = String(part.tool ?? "unknown")
  const state = (part.state ?? {}) as Row
  const status = String(state.status ?? "?")
  const input = state.input ? JSON.stringify(state.input) : ""
  const brief = input.length > 160 ? input.slice(0, 160) + "…" : input
  return `> 🔧 ${tool} ${brief} → ${status}`
}

const lines: string[] = []
let turn = 0
for (const m of messages) {
  const data = JSON.parse(m.data) as Row
  const role = String(data.role ?? "?")
  const parts = partsByMessage.get(m.id) ?? []
  const body: string[] = []
  for (const p of parts) {
    const type = String(p.type ?? "")
    if (type === "text" && typeof p.text === "string" && p.text.trim()) body.push(p.text.trim())
    else if (type === "tool") body.push(toolSummary(p))
    // reasoning / step-start / step-finish / snapshot: dropped by design
  }
  if (body.length === 0) continue
  turn++
  const who = role === "user" ? "User" : "Assistant"
  lines.push(`## T${turn} [${hhmm(m.time_created)}] ${who} {#${m.id}}`, "", body.join("\n\n"), "")
}

const model = (JSON.parse(messages.at(-1)?.data ?? "{}") as Row).modelID ?? session.model ?? "unknown"
const header = [
  "---",
  `session_id: ${session.id}`,
  `project_dir: ${session.directory}`,
  `title: ${JSON.stringify(session.title)}`,
  `model: ${model}`,
  `time_start: ${ts(Number(session.time_created))}`,
  `time_end: ${ts(Number(session.time_updated))}`,
  `turns: ${turn}`,
  `tokens: { input: ${session.tokens_input}, output: ${session.tokens_output} }`,
  `exported_at: ${new Date().toISOString()}`,
  "---",
  "",
].join("\n")

const md = header + lines.join("\n")
const hash = new Bun.CryptoHasher("sha256").update(md).digest("hex").slice(0, 16)
const out = `${outDir}/${sessionID}.md`
await Bun.write(out, md.replace("exported_at:", `content_hash: sha256:${hash}\nexported_at:`))
console.log(`wrote ${out} (${turn} turns, ${md.length} chars)`)
