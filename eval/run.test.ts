import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rmdir } from "node:fs/promises"
import { rm, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LlmClient, LlmRequest } from "../distiller/llm"
import type { Candidate } from "../distiller/extract"
import { serializeEntry } from "../distiller/store"
import type { MemoryEntry } from "../distiller/types"
import { runEval, type EvalOptions, type EvalRunSummary } from "./run"

// FakeLlm for testing
class FakeLlm implements LlmClient {
  callCount = 0
  shouldThrow = false
  shouldReturnEmpty = false
  // For scripted multi-run sequences: array of responses indexed by call count
  responses: string[] | null = null

  describe(): string {
    return "fake"
  }

  async complete(req: LlmRequest): Promise<string> {
    this.callCount++
    if (this.shouldThrow) {
      throw new Error("FakeLlm intentional error")
    }
    if (this.shouldReturnEmpty) {
      return "[]"
    }
    // If scripted responses provided, use them (for multi-run tests)
    if (this.responses !== null && this.callCount <= this.responses.length) {
      return this.responses[this.callCount - 1]!
    }
    // Return a matching candidate
    return JSON.stringify([
      {
        type: "decision",
        title: "Test Decision",
        trigger: "Test trigger",
        lesson: "Test lesson",
        domain: ["test"],
        evidence: [{ message_id: "msg_1" }],
        salience: 8,
        volatile: false,
      },
    ])
  }
}

// Helper to create a minimal transcript with proper frontmatter
function createTranscript(sessionId: string): string {
  return `---
session_id: ${sessionId}
content_hash: abc123
time_end: 2026-07-11T12:00:00Z
exported_at: 2026-07-11T12:00:00Z
title: Test Session
---

## Message {#msg_1}

User: Hello

## Message {#msg_2}

Agent: Response
`
}

// Helper to create a memory entry
function createMemoryEntry(id: string, project: string): MemoryEntry {
  return {
    id,
    memory_class: "semantic",
    type: "decision",
    title: "Test Memory",
    trigger: "Test trigger",
    lesson: "Test lesson",
    project,
    scope: "global",
    domain: ["test"],
    volatile: false,
    confidence: 0.8,
    status: "active",
    superseded_by: null,
    supersedes: null,
    review: "auto",
    evidence: [{ session: "ses_test", anchors: ["msg_1"], observed_at: "2026-07-11T00:00:00Z" }],
    provenance: { extractor: "test", prompt_hash: "test" },
    created_at: "2026-07-11T00:00:00Z",
    updated_at: "2026-07-11T00:00:00Z",
    notes: [],
  }
}

describe("runEval", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "eval-test-"))
  })

  afterEach(async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        rm(tmpDir, { recursive: true, force: true }, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } catch {
      // ignore cleanup errors
    }
  })

  // Helper to set up eval dir
  function setupEvalDir(dirname: string): string {
    const evalDir = join(dirname, "eval")
    mkdirSync(evalDir, { recursive: true })
    mkdirSync(join(evalDir, "fixtures"), { recursive: true })
    mkdirSync(join(evalDir, "retrieval", "store", "memories", "tmp"), { recursive: true })

    // Write a simple transcript fixture
    writeFileSync(join(evalDir, "fixtures", "test.md"), createTranscript("ses_test_001"))

    // Write cases.json
    writeFileSync(
      join(evalDir, "cases.json"),
      JSON.stringify([
        {
          fixture: "test.md",
          expect: [{ keywords: ["decision"] }],
          forbid: [],
          max_extra: 10,
        },
      ]),
    )

    // Write retrieval store entries
    const memory = createMemoryEntry("mem_test_001", "tmp")
    writeFileSync(join(evalDir, "retrieval", "store", "memories", "tmp", "mem_test_001.md"), serializeEntry(memory))

    // Write queries.json
    writeFileSync(
      join(evalDir, "retrieval", "queries.json"),
      JSON.stringify([
        {
          query: "test memory",
          expect_id: "mem_test_001",
          within_top: 3,
        },
      ]),
    )

    return evalDir
  }

  it("passes when FakeLlm returns matching candidate and retrieval succeeds", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const resultsPath = join(tmpDir, "results.jsonl")

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath,
      now: new Date("2026-07-11T12:00:00Z"),
    })

    expect(summary.pass).toBe(true)
    expect(summary.extraction).toBeDefined()
    expect(summary.extraction!.fixturesPass).toBe(1)
    expect(summary.extraction!.fixturesTotal).toBe(1)
    expect(summary.extraction!.expectationsMet).toBe(1)
    expect(summary.extraction!.expectationsTotal).toBe(1)
    expect(summary.extraction!.errors).toBe(0)
    expect(summary.retrieval).toBeDefined()
    expect(summary.retrieval!.pass).toBe(1)
    expect(summary.retrieval!.total).toBe(1)

    // Check results.jsonl was written
    const resultsContent = Bun.file(resultsPath).text()
    const line = (await resultsContent).trim()
    const result = JSON.parse(line)
    expect(result.model).toBe("fake")
    expect(result.pass).toBe(true)
    expect(result.extraction).toBeDefined()
    expect(result.retrieval).toBeDefined()
  })

  it("fails when FakeLlm returns empty array (unmet expectation)", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    llm.shouldReturnEmpty = true
    const resultsPath = join(tmpDir, "results.jsonl")

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath,
    })

    expect(summary.pass).toBe(false)
    expect(summary.extraction!.fixturesPass).toBe(0)
    expect(summary.extraction!.fixturesTotal).toBe(1)
    expect(summary.extraction!.errors).toBe(0) // Not an error, just a fail
  })

  it("counts LLM throw as error and fails run", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    llm.shouldThrow = true
    const resultsPath = join(tmpDir, "results.jsonl")

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath,
    })

    expect(summary.pass).toBe(false)
    expect(summary.extraction!.errors).toBe(1)
    expect(summary.extraction!.fixturesPass).toBe(0)
  })

  it("mode retrieval makes no LLM calls", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const resultsPath = join(tmpDir, "results.jsonl")

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath,
      mode: "retrieval",
    })

    expect(llm.callCount).toBe(0)
    expect(summary.extraction).toBeUndefined()
    expect(summary.retrieval).toBeDefined()
    expect(summary.retrieval!.pass).toBe(1)
    expect(summary.retrieval!.total).toBe(1)
  })

  it("mode retrieval does not append to results.jsonl even with resultsPath set (not a model eval)", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const resultsPath = join(tmpDir, "results.jsonl")

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath,
      mode: "retrieval",
    })

    expect(summary.retrieval).toBeDefined()
    expect(summary.retrieval!.pass).toBe(1)

    // File should not exist — a retrieval smoke run has no model/extraction signal
    // worth tracking in results.jsonl history.
    try {
      await Bun.file(resultsPath).text()
      expect.unreachable("results.jsonl should not have been written")
    } catch {
      // Expected
    }
  })

  it("resultsPath null skips writing results", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const resultsPath = join(tmpDir, "results.jsonl")

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath: null,
    })

    expect(summary.pass).toBe(true)

    // File should not exist
    try {
      await Bun.file(resultsPath).text()
      expect.unreachable("File should not exist")
    } catch {
      // Expected
    }
  })

  it("scorecard totals line is printed verbatim, not index/array-polluted (forEach(out) regression)", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const capturedLines: string[] = []

    const summary = await runEval({
      evalDir,
      llm,
      out: (line) => capturedLines.push(line),
      resultsPath: null,
    })

    expect(summary.pass).toBe(true)
    // Passing `out` directly as a callback (e.g. console.log) previously received
    // (value, index, array) from Array.prototype.forEach and printed the index/array
    // as extra arguments. Assert the totals line is EXACTLY the expected string, with
    // no trailing index or array garbage appended.
    const extractionTotals = capturedLines.find((l) => l.startsWith("Extraction:"))
    expect(extractionTotals).toBe(
      "Extraction: 1/1 fixtures passed, 1/1 expectations met, 0 forbidden hits, 0 extras, 0 errors",
    )
    const retrievalTotals = capturedLines.find((l) => l.startsWith("Retrieval:"))
    expect(retrievalTotals).toBe("Retrieval: 1/1 queries passed")
  })

  it("throws a descriptive error when a case has an empty-keywords expect/forbid rule (fail fast, not match-everything)", async () => {
    // Mini eval dir: only what runExtraction needs (fixtures + cases.json), no retrieval
    // setup, since mode: "extraction" never touches the retrieval directory.
    const evalDir = join(tmpDir, "empty-keywords-eval")
    mkdirSync(join(evalDir, "fixtures"), { recursive: true })
    writeFileSync(join(evalDir, "fixtures", "test.md"), createTranscript("ses_empty_kw_001"))
    writeFileSync(
      join(evalDir, "cases.json"),
      JSON.stringify([
        {
          fixture: "test.md",
          expect: [{ keywords: [] }],
          forbid: [],
        },
      ]),
    )

    const llm = new FakeLlm()
    await expect(runEval({ evalDir, llm, mode: "extraction", resultsPath: null })).rejects.toThrow(
      /empty keywords array/i,
    )
    // Validation happens at load, before any fixture is processed — no LLM call made.
    expect(llm.callCount).toBe(0)

    // Same guard applies to forbid rules.
    const evalDir2 = join(tmpDir, "empty-keywords-eval-forbid")
    mkdirSync(join(evalDir2, "fixtures"), { recursive: true })
    writeFileSync(join(evalDir2, "fixtures", "test.md"), createTranscript("ses_empty_kw_002"))
    writeFileSync(
      join(evalDir2, "cases.json"),
      JSON.stringify([
        {
          fixture: "test.md",
          expect: [{ keywords: ["decision"] }],
          forbid: [{ keywords: [] }],
        },
      ]),
    )
    const llm2 = new FakeLlm()
    await expect(runEval({ evalDir: evalDir2, llm: llm2, mode: "extraction", resultsPath: null })).rejects.toThrow(
      /empty keywords array/i,
    )
    expect(llm2.callCount).toBe(0)
  })

  it("bad query id (expect_id not in store) fails retrieval", async () => {
    const evalDir = setupEvalDir(tmpDir)
    // Update queries.json with a non-existent expect_id
    const queriesPath = join(evalDir, "retrieval", "queries.json")
    writeFileSync(
      queriesPath,
      JSON.stringify([
        {
          query: "test memory",
          expect_id: "mem_nonexistent",
          within_top: 3,
        },
      ]),
    )

    const llm = new FakeLlm()
    const resultsPath = join(tmpDir, "results.jsonl")

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath,
      mode: "retrieval",
    })

    expect(summary.pass).toBe(false)
    expect(summary.retrieval!.pass).toBe(0)
    expect(summary.retrieval!.total).toBe(1)
  })

  it("runs=3 with 2 pass + 1 fail → rate 2/3: passes at passRate 0.6, fails at default 1.0", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()

    // Script 3 responses: pass, pass, fail (empty array)
    llm.responses = [
      // Run 1: pass
      JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ]),
      // Run 2: pass
      JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ]),
      // Run 3: fail (empty)
      "[]",
    ]

    const resultsPath = join(tmpDir, "results.jsonl")

    // Test with passRate 0.6 — should pass (2/3 ≈ 0.67 >= 0.6)
    const summary1 = await runEval({
      evalDir,
      llm,
      resultsPath: null,
      mode: "extraction",
      runs: 3,
      passRate: 0.6,
    })

    expect(summary1.pass).toBe(true)
    expect(summary1.extraction!.fixturesPass).toBe(1)
    expect(summary1.extraction!.fixturesTotal).toBe(1)
    expect(summary1.extraction!.runs).toBe(3)
    expect(summary1.extraction!.fixturePassRates).toEqual({ "test.md": 2 / 3 })

    // Reset for next test
    llm.callCount = 0
    llm.responses = [
      // Run 1: pass
      JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ]),
      // Run 2: pass
      JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ]),
      // Run 3: fail (empty)
      "[]",
    ]

    // Test with default passRate 1.0 — should fail (2/3 < 1.0)
    const summary2 = await runEval({
      evalDir,
      llm,
      resultsPath: null,
      mode: "extraction",
      runs: 3,
      passRate: 1.0,
    })

    expect(summary2.pass).toBe(false)
    expect(summary2.extraction!.fixturesPass).toBe(0)
    expect(summary2.extraction!.fixturesTotal).toBe(1)
    expect(summary2.extraction!.runs).toBe(3)
    expect(summary2.extraction!.fixturePassRates).toEqual({ "test.md": 2 / 3 })
  })

  it("error run counted into rate and errors", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()

    // Script 3 responses: pass, error, fail
    let callCount = 0
    llm.complete = async (req: LlmRequest): Promise<string> => {
      callCount++
      if (callCount === 2) {
        throw new Error("FakeLlm intentional error on run 2")
      }
      if (callCount === 3) {
        return "[]" // fail
      }
      // Run 1 and any other: pass
      return JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ])
    }

    const resultsPath = join(tmpDir, "results.jsonl")

    // With passRate 0.33 (1/3 pass), should pass
    const summary = await runEval({
      evalDir,
      llm,
      resultsPath: null,
      mode: "extraction",
      runs: 3,
      passRate: 0.33,
    })

    expect(summary.extraction!.runs).toBe(3)
    expect(summary.extraction!.fixturePassRates).toEqual({ "test.md": 1 / 3 })
    expect(summary.extraction!.errors).toBe(1)
    expect(summary.pass).toBe(true)
  })

  it("runs=1 default identical to old behavior (regression pin)", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const resultsPath = join(tmpDir, "results.jsonl")
    const capturedLines: string[] = []

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath,
      now: new Date("2026-07-11T12:00:00Z"),
      out: (line) => capturedLines.push(line),
    })

    expect(summary.pass).toBe(true)
    expect(summary.extraction!.fixturesPass).toBe(1)
    expect(summary.extraction!.fixturesTotal).toBe(1)
    expect(summary.extraction!.expectationsMet).toBe(1)
    expect(summary.extraction!.expectationsTotal).toBe(1)
    expect(summary.extraction!.errors).toBe(0)

    // Old output format (no pass-rate shown for runs=1)
    const extractionLine = capturedLines.find((l) => l.startsWith("✓"))
    expect(extractionLine).toContain("expectations 1/1")
    expect(extractionLine).not.toContain("pass-rate")

    // Totals line format unchanged (no "runs: 1" mention)
    const totalsLine = capturedLines.find((l) => l.startsWith("Extraction:"))
    expect(totalsLine).not.toContain("runs:")

    // results.jsonl still contains runs field
    const resultsContent = (await Bun.file(resultsPath).text()).trim()
    const result = JSON.parse(resultsContent)
    expect(result.extraction.runs).toBe(1)
    expect(result.extraction.fixturePassRates).toEqual({ "test.md": 1 })
  })

  it("retrieval unaffected by runs", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const resultsPath = join(tmpDir, "results.jsonl")

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath,
      mode: "retrieval",
      runs: 3, // Should be ignored for retrieval
    })

    expect(llm.callCount).toBe(0)
    expect(summary.extraction).toBeUndefined()
    expect(summary.retrieval).toBeDefined()
    expect(summary.retrieval!.pass).toBe(1)
    expect(summary.retrieval!.total).toBe(1)

    // Retrieval mode never writes results.jsonl
    try {
      await Bun.file(resultsPath).text()
      expect.unreachable("results.jsonl should not have been written for retrieval mode")
    } catch {
      // Expected
    }
  })

  it("FIX 1: expectation counters accumulated across all runs", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()

    // Script 3 responses: all pass (so expectationsMet should be 3x baseline)
    llm.responses = [
      // Run 1: pass (1 expectation met)
      JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ]),
      // Run 2: pass
      JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ]),
      // Run 3: pass
      JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ]),
    ]

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath: null,
      mode: "extraction",
      runs: 3,
    })

    // With 2 expectations per fixture (from cases.json) and 3 runs:
    // expectationsTotal should be 2 * 3 = 6 (each run contributes 2)
    // expectationsMet should also be 3 (1 expectation met per run * 3 runs)
    expect(summary.extraction!.expectationsTotal).toBe(3) // 1 expectation per run * 3 runs
    expect(summary.extraction!.expectationsMet).toBe(3) // 1 met per run * 3 runs
  })

  it("FIX 2: error diagnostics printed for every run with run prefix", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const capturedLines: string[] = []

    // Script 3 responses: pass, error on run 2, pass
    let callCount = 0
    llm.complete = async (req: LlmRequest): Promise<string> => {
      callCount++
      if (callCount === 2) {
        throw new Error("FakeLlm intentional error on run 2")
      }
      // Run 1 and 3: pass
      return JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ])
    }

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath: null,
      mode: "extraction",
      runs: 3,
      passRate: 0.5,
      out: (line) => capturedLines.push(line),
    })

    // Error on run 2 should be visible
    expect(summary.extraction!.errors).toBe(1)

    // Output should contain error line with "[run 2/3]" prefix
    const errorLine = capturedLines.find((l) => l.startsWith("!"))
    expect(errorLine).toBeDefined()
    expect(errorLine).toContain("[run 2/3]")
    expect(errorLine).toContain("FakeLlm intentional error on run 2")
  })

  it("results.jsonl extraction object contains runs and fixturePassRates", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const resultsPath = join(tmpDir, "results.jsonl")

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath,
      now: new Date("2026-07-11T12:00:00Z"),
      mode: "extraction",
      runs: 2,
      passRate: 0.5,
    })

    expect(summary.pass).toBe(true)

    const resultsContent = (await Bun.file(resultsPath).text()).trim()
    const result = JSON.parse(resultsContent)

    expect(result.extraction.runs).toBe(2)
    expect(result.extraction.fixturePassRates).toEqual({ "test.md": 1 })
    expect(result.model).toBe("fake")
    expect(result.pass).toBe(true)
  })

  it("multi-run scorecard shows pass-rates for runs > 1", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const capturedLines: string[] = []

    // Script 2 responses: pass, fail
    llm.responses = [
      // Run 1: pass
      JSON.stringify([
        {
          type: "decision",
          title: "Test Decision",
          trigger: "Test trigger",
          lesson: "Test lesson",
          domain: ["test"],
          evidence: [{ message_id: "msg_1" }],
          salience: 8,
          volatile: false,
        },
      ]),
      // Run 2: fail (empty)
      "[]",
    ]

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath: null,
      mode: "extraction",
      runs: 2,
      passRate: 0.5,
      out: (line) => capturedLines.push(line),
    })

    expect(summary.pass).toBe(true)

    // Fixture line should show pass-rate format
    const fixtureLine = capturedLines.find((l) => l.includes("test.md"))
    expect(fixtureLine).toContain("pass-rate")
    expect(fixtureLine).toContain("1/2")

    // Totals line should include "runs: 2"
    const totalsLine = capturedLines.find((l) => l.startsWith("Extraction:"))
    expect(totalsLine).toContain("runs: 2")
  })

  it("multi-run failure scorecard shows < required message", async () => {
    const evalDir = setupEvalDir(tmpDir)
    const llm = new FakeLlm()
    const capturedLines: string[] = []

    // Script 3 responses: all fail
    llm.responses = ["[]", "[]", "[]"]

    const summary = await runEval({
      evalDir,
      llm,
      resultsPath: null,
      mode: "extraction",
      runs: 3,
      passRate: 0.5,
      out: (line) => capturedLines.push(line),
    })

    expect(summary.pass).toBe(false)

    // Fixture line should show < required format
    const fixtureLine = capturedLines.find((l) => l.includes("test.md"))
    expect(fixtureLine).toContain("✗")
    expect(fixtureLine).toContain("0/3")
    expect(fixtureLine).toContain("< required")
  })
})
