import { expect, test } from "bun:test"
import { buildJudgePrompt, medianConsensus, judgeCandidate, JUDGE_SCHEMA } from "./judge"
import type { Candidate } from "./extract"
import type { LlmClient, LlmRequest } from "./llm"

const cand = (over: Record<string, unknown> = {}): Candidate => ({
  type: "know_how",
  title: "Fix X with Y",
  trigger: "when X fails",
  lesson: "Use Y because Z.",
  domain: ["tooling"],
  evidence: [{ message_id: "msg_1" }],
  salience: 7,
  volatile: false,
  ...over,
})

// ============ JUDGE_SCHEMA tests ============

test("JUDGE_SCHEMA validates {salience: number, reason: string}", () => {
  const schema = JUDGE_SCHEMA
  expect(schema).toBeDefined()
  expect(typeof schema).toBe("object")
  // Schema should be a JSON schema object that describes the expected structure
  // Verify it can be stringified (it's meant for JSON schema validation)
  expect(JSON.stringify(schema)).toContain("salience")
  expect(JSON.stringify(schema)).toContain("reason")
})

// ============ buildJudgePrompt tests ============

test("buildJudgePrompt returns system and prompt fields", () => {
  const candidate = cand({
    type: "decision",
    title: "Use TypeScript for safety",
    trigger: "type safety concerns",
    lesson: "TypeScript catches errors at compile time.",
  })

  const result = buildJudgePrompt(candidate)
  expect(result).toHaveProperty("system")
  expect(result).toHaveProperty("prompt")
  expect(typeof result.system).toBe("string")
  expect(typeof result.prompt).toBe("string")
})

test("buildJudgePrompt includes 6-type criteria in system", () => {
  const candidate = cand()
  const result = buildJudgePrompt(candidate)

  const types = ["decision", "root_cause", "pitfall", "know_how", "convention", "workflow"]
  for (const type of types) {
    expect(result.system).toContain(type)
  }
})

test("buildJudgePrompt includes six-months bar in system", () => {
  const candidate = cand()
  const result = buildJudgePrompt(candidate)

  expect(result.system.toLowerCase()).toContain("six months")
})

test("buildJudgePrompt includes 0-10 score instruction in system", () => {
  const candidate = cand()
  const result = buildJudgePrompt(candidate)

  const has0to10 = result.system.includes("0-10") || result.system.includes("0 to 10")
  expect(has0to10).toBe(true)
})

test("buildJudgePrompt includes JSON-only instruction in system", () => {
  const candidate = cand()
  const result = buildJudgePrompt(candidate)

  expect(result.system.toLowerCase()).toContain("json")
})

test("buildJudgePrompt includes candidate details in prompt", () => {
  const candidate = cand({
    type: "pitfall",
    title: "Null pointer bugs",
    trigger: "unsafe dereferencing",
    lesson: "Always check before access.",
  })

  const result = buildJudgePrompt(candidate)
  expect(result.prompt).toContain("pitfall")
  expect(result.prompt).toContain("Null pointer bugs")
  expect(result.prompt).toContain("unsafe dereferencing")
  expect(result.prompt).toContain("Always check before access.")
})

// ============ medianConsensus tests ============

test("medianConsensus: odd number of scores returns middle value", () => {
  expect(medianConsensus([3, 7, 9])).toBe(7)
  expect(medianConsensus([1, 2, 3, 4, 5])).toBe(3)
  expect(medianConsensus([5])).toBe(5)
})

test("medianConsensus: even number of scores returns lower-middle value", () => {
  expect(medianConsensus([4, 8])).toBe(4)
  expect(medianConsensus([1, 2, 3, 4])).toBe(2)
  expect(medianConsensus([5, 10])).toBe(5)
})

test("medianConsensus: unsorted input is sorted first", () => {
  expect(medianConsensus([9, 3, 7])).toBe(7)
  expect(medianConsensus([8, 4])).toBe(4)
})

test("medianConsensus: handles duplicate values", () => {
  expect(medianConsensus([5, 5, 5])).toBe(5)
  expect(medianConsensus([3, 3, 7, 7])).toBe(3) // lower-middle of [3, 3, 7, 7]
})

// ============ judgeCandidate tests ============

// FakeLlm for testing
class FakeLlm implements LlmClient {
  callCount = 0
  responses: string[] = []
  currentResponseIndex = 0

  describe(): string {
    return "fake"
  }

  async complete(req: LlmRequest): Promise<string> {
    this.callCount++
    if (this.currentResponseIndex < this.responses.length) {
      const response = this.responses[this.currentResponseIndex]!
      this.currentResponseIndex++
      return response
    }
    throw new Error("FakeLlm: no more responses configured")
  }
}

test("judgeCandidate: judges=0 returns immediate fallback with zero LLM calls", async () => {
  const llm = new FakeLlm()
  const candidate = cand({ salience: 7 })

  const verdict = await judgeCandidate(candidate, llm, 0)

  expect(verdict.salience).toBe(7)
  expect(verdict.panel).toBe(0)
  expect(verdict.voted).toBe(0)
  expect(verdict.selfScore).toBe(7)
  expect(verdict.usedFallback).toBe(true)
  expect(llm.callCount).toBe(0)
})

test("judgeCandidate: judges < 0 returns immediate fallback with zero LLM calls", async () => {
  const llm = new FakeLlm()
  const candidate = cand({ salience: 5 })

  const verdict = await judgeCandidate(candidate, llm, -1)

  expect(verdict.salience).toBe(5)
  expect(verdict.panel).toBe(0)
  expect(verdict.voted).toBe(0)
  expect(verdict.selfScore).toBe(5)
  expect(verdict.usedFallback).toBe(true)
  expect(llm.callCount).toBe(0)
})

test("judgeCandidate: odd number of valid judges returns median", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ salience: 3, reason: "low relevance" }),
    JSON.stringify({ salience: 7, reason: "good content" }),
    JSON.stringify({ salience: 9, reason: "essential" }),
  ]

  const candidate = cand({ salience: 6 })
  const verdict = await judgeCandidate(candidate, llm, 3)

  expect(verdict.panel).toBe(3)
  expect(verdict.voted).toBe(3)
  expect(verdict.salience).toBe(7) // median of [3, 7, 9]
  expect(verdict.selfScore).toBe(6)
  expect(verdict.usedFallback).toBe(false)
  expect(llm.callCount).toBe(3)
})

test("judgeCandidate: even number of valid judges returns lower-middle", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ salience: 4, reason: "moderate" }),
    JSON.stringify({ salience: 8, reason: "strong" }),
  ]

  const candidate = cand({ salience: 5 })
  const verdict = await judgeCandidate(candidate, llm, 2)

  expect(verdict.panel).toBe(2)
  expect(verdict.voted).toBe(2)
  expect(verdict.salience).toBe(4) // lower-middle of [4, 8]
  expect(verdict.selfScore).toBe(5)
  expect(verdict.usedFallback).toBe(false)
  expect(llm.callCount).toBe(2)
})

test("judgeCandidate: bad JSON response causes judge to abstain, shrinking panel", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ salience: 5, reason: "ok" }),
    "{ bad json", // Will fail to parse
    JSON.stringify({ salience: 9, reason: "good" }),
  ]

  const candidate = cand({ salience: 7 })
  const verdict = await judgeCandidate(candidate, llm, 3)

  // One abstention means voted count = 2
  expect(verdict.panel).toBe(3)
  expect(verdict.voted).toBe(2)
  // Median of [5, 9]
  expect(verdict.salience).toBe(5) // lower-middle of 2 scores
  expect(verdict.usedFallback).toBe(false)
  expect(llm.callCount).toBe(3)
})

test("judgeCandidate: out-of-range salience causes abstention", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ salience: 5, reason: "ok" }),
    JSON.stringify({ salience: 11, reason: "invalid" }), // > 10, should abstain
    JSON.stringify({ salience: 9, reason: "good" }),
  ]

  const candidate = cand({ salience: 7 })
  const verdict = await judgeCandidate(candidate, llm, 3)

  expect(verdict.panel).toBe(3)
  expect(verdict.voted).toBe(2) // one abstained due to out-of-range
  expect(verdict.salience).toBe(5) // lower-middle of [5, 9]
  expect(verdict.usedFallback).toBe(false)
})

test("judgeCandidate: negative salience causes abstention", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ salience: 5, reason: "ok" }),
    JSON.stringify({ salience: -1, reason: "invalid" }), // < 0, should abstain
    JSON.stringify({ salience: 8, reason: "good" }),
  ]

  const candidate = cand({ salience: 6 })
  const verdict = await judgeCandidate(candidate, llm, 3)

  expect(verdict.panel).toBe(3)
  expect(verdict.voted).toBe(2)
  expect(verdict.salience).toBe(5) // lower-middle of [5, 8]
})

test("judgeCandidate: NaN salience causes abstention", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ salience: 5, reason: "ok" }),
    JSON.stringify({ salience: NaN, reason: "invalid" }),
    JSON.stringify({ salience: 9, reason: "good" }),
  ]

  const candidate = cand({ salience: 7 })
  const verdict = await judgeCandidate(candidate, llm, 3)

  expect(verdict.panel).toBe(3)
  expect(verdict.voted).toBe(2)
  expect(verdict.salience).toBe(5) // lower-middle of [5, 9]
})

test("judgeCandidate: non-number salience causes abstention", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ salience: 5, reason: "ok" }),
    JSON.stringify({ salience: "not a number", reason: "invalid" }),
    JSON.stringify({ salience: 9, reason: "good" }),
  ]

  const candidate = cand({ salience: 7 })
  const verdict = await judgeCandidate(candidate, llm, 3)

  expect(verdict.panel).toBe(3)
  expect(verdict.voted).toBe(2)
  expect(verdict.salience).toBe(5) // lower-middle of [5, 9]
})

test("judgeCandidate: all judges abstain uses fallback with selfScore", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    "{ bad json",
    "not json at all",
    JSON.stringify({ salience: NaN, reason: "bad" }),
  ]

  const candidate = cand({ salience: 8 })
  const verdict = await judgeCandidate(candidate, llm, 3)

  expect(verdict.panel).toBe(3)
  expect(verdict.voted).toBe(0)
  expect(verdict.salience).toBe(8) // falls back to self-score
  expect(verdict.selfScore).toBe(8)
  expect(verdict.usedFallback).toBe(true)
  expect(llm.callCount).toBe(3)
})

test("judgeCandidate: LLM throw causes abstention", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ salience: 5, reason: "ok" }),
  ]

  // Simulate throw on 2nd call by not providing enough responses
  const candidate = cand({ salience: 7 })
  const verdict = await judgeCandidate(candidate, llm, 2)

  // First call succeeds (vote = 5), second throws (abstain)
  expect(verdict.panel).toBe(2)
  expect(verdict.voted).toBe(1)
  expect(verdict.salience).toBe(5)
  expect(verdict.usedFallback).toBe(false)
})

test("judgeCandidate: stripFences removes markdown fences from response", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    '```json\n{"salience": 7, "reason": "good"}\n```',
    JSON.stringify({ salience: 5, reason: "ok" }),
  ]

  const candidate = cand({ salience: 6 })
  const verdict = await judgeCandidate(candidate, llm, 2)

  expect(verdict.panel).toBe(2)
  expect(verdict.voted).toBe(2)
  expect(verdict.salience).toBe(5) // lower-middle of [7, 5]
})

test("judgeCandidate: missing salience field causes abstention", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ reason: "no salience field" }), // missing salience
    JSON.stringify({ salience: 8, reason: "ok" }),
    JSON.stringify({ salience: 6, reason: "ok" }),
  ]

  const candidate = cand({ salience: 7 })
  const verdict = await judgeCandidate(candidate, llm, 3)

  expect(verdict.panel).toBe(3)
  expect(verdict.voted).toBe(2) // one abstained (missing field treated as abstention)
  expect(verdict.salience).toBe(6) // lower-middle of [8, 6]
})

test("judgeCandidate: boundary values 0 and 10 are valid", async () => {
  const llm = new FakeLlm()
  llm.responses = [
    JSON.stringify({ salience: 0, reason: "not valuable" }),
    JSON.stringify({ salience: 10, reason: "essential" }),
  ]

  const candidate = cand({ salience: 5 })
  const verdict = await judgeCandidate(candidate, llm, 2)

  expect(verdict.panel).toBe(2)
  expect(verdict.voted).toBe(2)
  expect(verdict.salience).toBe(0) // lower-middle of [0, 10]
})
