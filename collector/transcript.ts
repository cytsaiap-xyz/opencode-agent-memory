import { createHash } from "node:crypto"
import type { PartBundle, SessionBundle } from "./db"

export interface TranscriptResult {
  markdown: string
  turns: number
  userTurns: number
  contentHash: string
}

const DROPPED_TYPES = new Set(["reasoning", "step-start", "step-finish", "snapshot", "patch"])

const iso = (ms: number) => new Date(ms).toISOString()
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

function toolSummary(part: PartBundle["data"]): string {
  const tool = String(part.tool ?? "unknown")
  const state = (part.state ?? {}) as Record<string, unknown>
  const status = String(state.status ?? "?")
  let input = ""
  if (state.input !== undefined) {
    try {
      input = JSON.stringify(state.input)
    } catch {
      input = "[unserializable]"
    }
  }
  if (input.length > 160) input = input.slice(0, 160) + "…"
  return `> 🔧 ${tool} ${input} → ${status}`
}

function sessionModel(bundle: SessionBundle): string {
  if (bundle.session.model) {
    try {
      const m = JSON.parse(bundle.session.model) as { id?: string; providerID?: string }
      if (m.id) return m.providerID ? `${m.providerID}/${m.id}` : m.id
    } catch {
      // fall through to message scan
    }
  }
  for (let i = bundle.messages.length - 1; i >= 0; i--) {
    const id = bundle.messages[i]?.data.modelID
    if (typeof id === "string" && id) return id
  }
  return "unknown"
}

export function renderTranscript(bundle: SessionBundle, exportedAt: Date): TranscriptResult {
  const partsByMessage = new Map<string, PartBundle[]>()
  for (const p of bundle.parts) {
    const list = partsByMessage.get(p.message_id) ?? []
    list.push(p)
    partsByMessage.set(p.message_id, list)
  }

  const lines: string[] = []
  let turns = 0
  let userTurns = 0
  for (const m of bundle.messages) {
    const role = String(m.data.role ?? "")
    const body: string[] = []
    for (const p of partsByMessage.get(m.id) ?? []) {
      const type = String(p.data.type ?? "")
      if (DROPPED_TYPES.has(type)) continue
      if (type === "text" && typeof p.data.text === "string" && p.data.text.trim()) {
        body.push(p.data.text.trim())
      } else if (type === "tool") {
        body.push(toolSummary(p.data))
      }
    }
    if (body.length === 0) continue
    turns++
    if (role === "user") userTurns++
    const who = role === "user" ? "User" : "Assistant"
    lines.push(`## T${turns} [${hhmm(m.time_created)}] ${who} {#${m.id}}`, "", body.join("\n\n"), "")
  }

  const bodyText = lines.join("\n")
  const contentHash = "sha256:" + createHash("sha256").update(bodyText).digest("hex").slice(0, 16)

  const header = [
    "---",
    `session_id: ${bundle.session.id}`,
    `project_dir: ${JSON.stringify(bundle.session.directory)}`,
    `title: ${JSON.stringify(bundle.session.title)}`,
    `model: ${JSON.stringify(sessionModel(bundle))}`,
    `time_start: ${iso(bundle.session.time_created)}`,
    `time_end: ${iso(bundle.session.time_updated)}`,
    `turns: ${turns}`,
    `tokens: { input: ${bundle.session.tokens_input}, output: ${bundle.session.tokens_output} }`,
    `content_hash: ${contentHash}`,
    `exported_at: ${exportedAt.toISOString()}`,
    "---",
    "",
  ].join("\n")

  return { markdown: header + bodyText, turns, userTurns, contentHash }
}
