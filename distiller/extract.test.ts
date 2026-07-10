import { expect, test } from "bun:test"
import { buildExtractPrompt, scanSecrets, stripFences, validateCandidates } from "./extract"
import type { TranscriptMeta } from "./transcripts"

const meta: TranscriptMeta = {
  path: "/s/proja/ses_1.md", sessionId: "ses_1", project: "proja",
  contentHash: "sha256:aa", timeEnd: "2026-07-10T00:00:00.000Z", exportedAt: "2026-07-10T01:00:00.000Z",
  title: "t",
  body: "## T1 [00:00] User {#msg_u1}\n\nhow to fix X\n\n## T2 [00:01] Assistant {#msg_a1}\n\nuse Y\n",
}

const cand = (over: Record<string, unknown> = {}) => ({
  type: "know_how", title: "Fix X with Y", trigger: "when X fails",
  lesson: "Use Y because Z.", domain: ["tooling"],
  evidence: [{ message_id: "msg_a1" }], salience: 7, volatile: false,
  ...over,
})

test("buildExtractPrompt embeds taxonomy, rules, and transcript; stable promptHash", () => {
  const a = buildExtractPrompt(meta)
  const b = buildExtractPrompt({ ...meta, body: "## T1 [00:00] User {#msg_z}\n\ndifferent\n" })
  expect(a.system).toContain("root_cause")
  expect(a.system).toContain("salience")
  expect(a.prompt).toContain("how to fix X")
  expect(a.promptHash).toBe(b.promptHash) // hash covers the template, not the transcript
  expect(a.promptHash).toMatch(/^sha256:[0-9a-f]{16}$/)
})

test("stripFences removes markdown code fences", () => {
  expect(stripFences('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]')
  expect(stripFences('[1]')).toBe("[1]")
})

test("valid candidate passes; hallucinated anchor rejected with reason", () => {
  const r = validateCandidates(JSON.stringify([cand(), cand({ evidence: [{ message_id: "msg_FAKE" }] })]), meta, 6)
  expect(r.valid.length).toBe(1)
  expect(r.rejected.length).toBe(1)
  expect(r.rejected[0]!.reasons.join()).toContain("hallucinated evidence anchor: msg_FAKE")
})

test("field violations collect ALL reasons; below-salience silently dropped", () => {
  const bad = cand({ type: "vibes", lesson: Array(100).fill("word").join(" "), domain: [] })
  const low = cand({ salience: 3 })
  const r = validateCandidates(JSON.stringify([bad, low]), meta, 6)
  expect(r.valid.length).toBe(0)
  expect(r.rejected.length).toBe(1)
  const reasons = r.rejected[0]!.reasons.join("; ")
  expect(reasons).toContain("type")
  expect(reasons).toContain("lesson")
  expect(reasons).toContain("domain")
})

test("unparseable output throws; non-array throws", () => {
  expect(() => validateCandidates("not json at all {", meta, 6)).toThrow()
  expect(() => validateCandidates('{"a":1}', meta, 6)).toThrow(/array/)
})

test("secret-bearing candidates are diverted to the secrets bucket", () => {
  const leaky = cand({ lesson: "Set key AKIA0123456789ABCDEF before running." })
  const r = validateCandidates(JSON.stringify([leaky]), meta, 6)
  expect(r.valid.length).toBe(0)
  expect(r.secrets.length).toBe(1)
  expect(r.secrets[0]!.matches.length).toBeGreaterThan(0)
})

test("scanSecrets catches PEM, AWS keys, token prefixes, high-entropy blobs; clean text passes", () => {
  expect(scanSecrets("-----BEGIN RSA PRIVATE KEY-----")).not.toEqual([])
  expect(scanSecrets("ghp_abcdEFGH0123456789ijkl")).not.toEqual([])
  expect(scanSecrets("aB3$" + "xY9#".repeat(10))).not.toEqual([])
  expect(scanSecrets("re-extract parasitics before running STA")).toEqual([])
})
