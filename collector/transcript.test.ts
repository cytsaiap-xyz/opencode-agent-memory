import { describe, expect, test } from "bun:test"
import { renderTranscript } from "./transcript"
import type { SessionBundle } from "./db"

const bundle = (overrides?: Partial<SessionBundle>): SessionBundle => ({
  session: {
    id: "ses_a", parent_id: null, directory: "/x/projA", title: "T \"quoted\"",
    time_created: 1000, time_updated: 5000, tokens_input: 10, tokens_output: 5,
    model: JSON.stringify({ id: "big-pickle", providerID: "opencode" }),
  },
  messages: [
    { id: "msg_u1", time_created: 1000, data: { role: "user" } },
    { id: "msg_a1", time_created: 2000, data: { role: "assistant", modelID: "m2" } },
    { id: "msg_empty", time_created: 3000, data: { role: "assistant" } },
  ],
  parts: [
    { message_id: "msg_u1", data: { type: "text", text: "  hello  " } },
    { message_id: "msg_a1", data: { type: "reasoning", text: "secret thoughts" } },
    { message_id: "msg_a1", data: { type: "step-start" } },
    { message_id: "msg_a1", data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "x".repeat(300) } } } },
    { message_id: "msg_a1", data: { type: "text", text: "done" } },
  ],
  ...overrides,
})

test("renders frontmatter, turns, anchors; drops noise part types and empty messages", () => {
  const r = renderTranscript(bundle(), new Date("2026-07-10T03:00:00Z"))
  expect(r.turns).toBe(2)
  expect(r.userTurns).toBe(1)
  expect(r.markdown).toContain("session_id: ses_a")
  expect(r.markdown).toContain('title: "T \\"quoted\\""')
  expect(r.markdown).toContain("model: opencode/big-pickle")
  expect(r.markdown).toContain("## T1 [00:00] User {#msg_u1}")
  expect(r.markdown).toContain("hello") // trimmed
  expect(r.markdown).toContain("## T2 [00:00] Assistant {#msg_a1}")
  expect(r.markdown).not.toContain("secret thoughts") // reasoning dropped
  expect(r.markdown).not.toContain("msg_empty") // empty message skipped
  expect(r.markdown).toContain("> 🔧 bash")
  expect(r.markdown).toContain("→ completed")
})

test("tool input is truncated to 160 chars with ellipsis", () => {
  const r = renderTranscript(bundle(), new Date())
  const line = r.markdown.split("\n").find((l) => l.startsWith("> 🔧 bash"))!
  expect(line).toContain("…")
  expect(line.length).toBeLessThan(200)
})

test("contentHash is stable across exportedAt and present in frontmatter", () => {
  const a = renderTranscript(bundle(), new Date("2026-01-01T00:00:00Z"))
  const b = renderTranscript(bundle(), new Date("2026-06-30T12:34:56Z"))
  expect(a.contentHash).toBe(b.contentHash)
  expect(a.contentHash).toMatch(/^sha256:[0-9a-f]{16}$/)
  expect(a.markdown).toContain(`content_hash: ${a.contentHash}`)
  expect(a.markdown).toContain("exported_at: 2026-01-01T00:00:00.000Z")
})

test("contentHash changes when body changes", () => {
  const a = renderTranscript(bundle(), new Date())
  const changed = bundle()
  changed.parts[0]!.data.text = "different"
  const b = renderTranscript(changed, new Date())
  expect(a.contentHash).not.toBe(b.contentHash)
})

test("model falls back to last message modelID when session.model is absent", () => {
  const noModel = bundle()
  noModel.session.model = null
  const r = renderTranscript(noModel, new Date())
  expect(r.markdown).toContain("model: m2")
})
