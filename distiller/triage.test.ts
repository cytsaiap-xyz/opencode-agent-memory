import { expect, test } from "bun:test"
import { buildTriagePrompt, llmTriage, TRIAGE_SCHEMA } from "./triage"
import type { LlmClient, LlmRequest } from "./llm"
import type { TranscriptMeta } from "./transcripts"

const meta = (over: Partial<TranscriptMeta> = {}): TranscriptMeta => ({
  path: "/x/proja/ses_1.md",
  sessionId: "ses_1",
  project: "proja",
  contentHash: "sha256:h1",
  timeEnd: "2026-07-10T01:00:00.000Z",
  exportedAt: "2026-07-10T02:00:00.000Z",
  title: "t",
  body: "some transcript body with enough content to be plausible",
  ...over,
})

class FakeLlm implements LlmClient {
  callCount = 0
  responses: string[] = []
  idx = 0
  describe(): string {
    return "fake"
  }
  async complete(_req: LlmRequest): Promise<string> {
    this.callCount++
    if (this.idx < this.responses.length) return this.responses[this.idx++]!
    throw new Error("FakeLlm: no more responses configured")
  }
}

test("TRIAGE_SCHEMA describes worth_extracting boolean + why string", () => {
  expect(JSON.stringify(TRIAGE_SCHEMA)).toContain("worth_extracting")
  expect(JSON.stringify(TRIAGE_SCHEMA)).toContain("why")
})

test("buildTriagePrompt returns system + prompt, system covers the 6 types and JSON-only instruction", () => {
  const { system, prompt } = buildTriagePrompt(meta())
  const types = ["decision", "root_cause", "pitfall", "know_how", "convention", "workflow"]
  for (const t of types) expect(system).toContain(t)
  expect(system.toLowerCase()).toContain("json")
  expect(prompt).toContain(meta().body)
})

test("llmTriage: worth_extracting true is parsed straight through", async () => {
  const llm = new FakeLlm()
  llm.responses = [JSON.stringify({ worth_extracting: true, why: "contains a root cause" })]
  const result = await llmTriage(meta(), llm)
  expect(result.worth).toBe(true)
  expect(result.why).toBe("contains a root cause")
  expect(result.failedOpen).toBe(false)
  expect(llm.callCount).toBe(1)
})

test("llmTriage: worth_extracting false is parsed straight through (not failed-open)", async () => {
  const llm = new FakeLlm()
  llm.responses = [JSON.stringify({ worth_extracting: false, why: "just a greeting" })]
  const result = await llmTriage(meta(), llm)
  expect(result.worth).toBe(false)
  expect(result.why).toBe("just a greeting")
  expect(result.failedOpen).toBe(false)
})

test("llmTriage: markdown-fenced JSON is stripped before parsing", async () => {
  const llm = new FakeLlm()
  llm.responses = ['```json\n{"worth_extracting": true, "why": "ok"}\n```']
  const result = await llmTriage(meta(), llm)
  expect(result.worth).toBe(true)
  expect(result.failedOpen).toBe(false)
})

test("llmTriage: LLM throw fails open (worth: true, failedOpen: true)", async () => {
  const llm = new FakeLlm() // no responses configured -> throws
  const result = await llmTriage(meta(), llm)
  expect(result.worth).toBe(true)
  expect(result.failedOpen).toBe(true)
  expect(result.why).toContain("triage failed")
})

test("llmTriage: bad (non-JSON) output fails open", async () => {
  const llm = new FakeLlm()
  llm.responses = ["not json at all"]
  const result = await llmTriage(meta(), llm)
  expect(result.worth).toBe(true)
  expect(result.failedOpen).toBe(true)
})

test("llmTriage: valid JSON but wrong shape (missing worth_extracting) fails open", async () => {
  const llm = new FakeLlm()
  llm.responses = [JSON.stringify({ why: "no worth_extracting field" })]
  const result = await llmTriage(meta(), llm)
  expect(result.worth).toBe(true)
  expect(result.failedOpen).toBe(true)
})

test("llmTriage: worth_extracting as non-boolean fails open", async () => {
  const llm = new FakeLlm()
  llm.responses = [JSON.stringify({ worth_extracting: "yes", why: "typo'd type" })]
  const result = await llmTriage(meta(), llm)
  expect(result.worth).toBe(true)
  expect(result.failedOpen).toBe(true)
})

test("llmTriage: missing why field defaults to empty string, does not fail open", async () => {
  const llm = new FakeLlm()
  llm.responses = [JSON.stringify({ worth_extracting: true })]
  const result = await llmTriage(meta(), llm)
  expect(result.worth).toBe(true)
  expect(result.why).toBe("")
  expect(result.failedOpen).toBe(false)
})
