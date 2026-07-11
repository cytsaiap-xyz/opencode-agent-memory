import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { extractFromTranscript } from "../distiller/extract"
import type { LlmClient } from "../distiller/llm"
import { clientFromEnv } from "../distiller/llm"
import { openMemoryIndex } from "../distiller/indexes"
import { probeSqlite } from "../shared/sqliteProbe"
import { parseTranscript } from "../distiller/transcripts"
import { searchMemory } from "../mcp-server/query"
import { scoreCase, type ExtractionCase } from "./match"

export interface EvalOptions {
  evalDir: string
  mode?: "all" | "extraction" | "retrieval"
  llm?: LlmClient
  out?: (line: string) => void
  resultsPath?: string | null
  now?: Date
  env?: Record<string, string | undefined>
  runs?: number
  passRate?: number
}

export interface EvalRunSummary {
  pass: boolean
  extraction?: {
    fixturesPass: number
    fixturesTotal: number
    expectationsMet: number
    expectationsTotal: number
    forbiddenHits: number
    extras: number
    errors: number
    runs?: number
    fixturePassRates?: Record<string, number>
  }
  retrieval?: {
    pass: number
    total: number
  }
}

// A rule with an empty keywords array is vacuously "match everything" (expect) or
// "flag everything" (forbid) — see `Array.prototype.every` on `[]` — which silently
// defeats the point of the assertion. Fail fast at load instead of letting a typo'd
// case pass (or fail) for the wrong reason.
function validateCases(cases: ExtractionCase[]): void {
  for (const kase of cases) {
    kase.expect.forEach((rule, i) => {
      if (rule.keywords.length === 0)
        throw new Error(
          `eval/cases.json: fixture "${kase.fixture}" expect[${i}] has an empty keywords array — ` +
            `this matches every candidate (of the given type, or of any type), defeating the ` +
            `assertion. Add at least one real keyword.`,
        )
    })
    for (const [i, rule] of (kase.forbid ?? []).entries()) {
      if (rule.keywords.length === 0)
        throw new Error(
          `eval/cases.json: fixture "${kase.fixture}" forbid[${i}] has an empty keywords array — ` +
            `this flags every candidate as forbidden, defeating the assertion. Add at least one ` +
            `real keyword.`,
        )
    }
  }
}

async function runExtraction(
  evalDir: string,
  llm: LlmClient,
  out: (line: string) => void,
  salienceMin: number,
  runs: number = 1,
  passRate: number = 1.0,
): Promise<{
  fixturesPass: number
  fixturesTotal: number
  expectationsMet: number
  expectationsTotal: number
  forbiddenHits: number
  extras: number
  errors: number
  runs: number
  fixturePassRates: Record<string, number>
}> {
  const casesPath = join(evalDir, "cases.json")
  const cases: ExtractionCase[] = JSON.parse(readFileSync(casesPath, "utf8"))
  validateCases(cases)
  const fixturesDir = join(evalDir, "fixtures")

  let fixturesPass = 0
  let expectationsMet = 0
  let expectationsTotal = 0
  let forbiddenHits = 0
  let extras = 0
  let errors = 0
  const fixturePassRates: Record<string, number> = {}

  for (const kase of cases) {
    const fixturePath = join(fixturesDir, kase.fixture)

    let passes = 0
    let fixtureErrors = 0

    for (let runIdx = 0; runIdx < runs; runIdx++) {
      try {
        const content = readFileSync(fixturePath, "utf8")
        const meta = parseTranscript(fixturePath, content)

        const salMin = kase.salience_min ?? salienceMin
        const validated = await extractFromTranscript(meta, llm, salMin)
        const caseScore = scoreCase(kase, validated.valid)

        if (caseScore.status === "pass") passes++

        // Accumulate expectations/forbiddens across all runs
        expectationsMet += caseScore.expectationsMet
        expectationsTotal += caseScore.expectationsTotal
        forbiddenHits += caseScore.forbiddenHits.length
        extras += caseScore.extras
      } catch (e) {
        fixtureErrors++
        errors++
        // Print error for every run, prefixed with run number when runs > 1
        const msg = e instanceof Error ? e.message : String(e)
        const runPrefix = runs > 1 ? ` [run ${runIdx + 1}/${runs}]` : ""
        out(`! ${kase.fixture}${runPrefix} — error: ${msg}`)
      }
    }

    const rate = passes / runs
    fixturePassRates[kase.fixture] = rate
    const fixturePass = rate >= passRate

    if (fixturePass) fixturesPass++

    const symbol = fixturePass ? "✓" : "✗"
    const rateStr = `${passes}/${runs}`

    if (runs === 1) {
      out(
        `${symbol} ${kase.fixture} — expectations ${expectationsMet}/${expectationsTotal}, forbidden ${forbiddenHits}, extras ${extras}`,
      )
    } else {
      if (fixturePass) {
        out(`${symbol} ${kase.fixture} — pass-rate ${rateStr}`)
      } else {
        const requiredStr = `${Math.ceil(passRate * runs)}/${runs}`
        out(`${symbol} ${kase.fixture} — ${rateStr} (< required ${requiredStr})`)
      }
    }
  }

  return {
    fixturesPass,
    fixturesTotal: cases.length,
    expectationsMet,
    expectationsTotal,
    forbiddenHits,
    extras,
    errors,
    runs,
    fixturePassRates,
  }
}

interface RetrievalQuery {
  query: string
  expect_id: string
  within_top: number
}

async function runRetrieval(
  evalDir: string,
  out: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<{
  pass: number
  total: number
}> {
  const storeDir = join(evalDir, "retrieval", "store")
  // Probe against a scratch tmp dir (never the checked-in golden store) — in sqlite
  // mode the real index is also built at a tmp dbPath, exactly as before; in fallback
  // mode FileScanIndex reads storeDir live off disk, no tmp dir needed for the index
  // itself, but rm() below still cleans it up unconditionally for symmetry.
  const tmpDir = await mkdtemp(join(tmpdir(), "eval-retrieval-"))
  try {
    const probe = probeSqlite(tmpDir, env)
    const dbPath = join(tmpDir, "index.db")
    const index = openMemoryIndex(storeDir, probe, probe.ok ? { dbPath } : undefined)
    try {
      if (probe.ok) await index.rebuildFrom(storeDir)

      const queriesPath = join(evalDir, "retrieval", "queries.json")
      const queries: RetrievalQuery[] = JSON.parse(readFileSync(queriesPath, "utf8"))

      let pass = 0
      for (const q of queries) {
        const results = searchMemory(index, { query: q.query })
        const found = results.slice(0, q.within_top).some((r) => r.id === q.expect_id)
        if (found) pass++

        const symbol = found ? "✓" : "✗"
        out(`${symbol} query: "${q.query}" — expect_id: ${q.expect_id}`)
      }

      return { pass, total: queries.length }
    } finally {
      // Ensure index is always closed, even if rebuildFrom, JSON parsing, or queries throw
      index.close()
    }
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function runEval(opts: EvalOptions): Promise<EvalRunSummary> {
  const mode = opts.mode ?? "all"
  const llm = opts.llm ?? clientFromEnv()
  const out = opts.out ?? console.log
  const resultsPath = opts.resultsPath === undefined ? `${opts.evalDir}/results.jsonl` : opts.resultsPath
  const now = opts.now ?? new Date()
  const env = opts.env ?? process.env
  const salienceMin = 6
  const runs = opts.runs ?? 1
  const passRate = opts.passRate ?? 1.0

  // Validate runs parameter
  if (runs < 1 || runs > 10 || !Number.isInteger(runs)) {
    throw new Error(`--runs must be an integer between 1 and 10, got ${runs}`)
  }

  // Validate passRate parameter
  if (passRate <= 0 || passRate > 1) {
    throw new Error(`--pass-rate must be a number in (0, 1], got ${passRate}`)
  }

  let extraction: EvalRunSummary["extraction"]
  let retrieval: EvalRunSummary["retrieval"]
  let pass = true

  if (mode === "all" || mode === "extraction") {
    extraction = await runExtraction(opts.evalDir, llm, out, salienceMin, runs, passRate)
    if (extraction.fixturesPass < extraction.fixturesTotal) {
      pass = false
    }
  }

  if (mode === "all" || mode === "retrieval") {
    retrieval = await runRetrieval(opts.evalDir, out, env)
    if (retrieval.pass < retrieval.total) {
      pass = false
    }
  }

  // Print scorecard totals
  const lines: string[] = []
  if (extraction) {
    let totalsLine =
      `Extraction: ${extraction.fixturesPass}/${extraction.fixturesTotal} fixtures passed, ` +
      `${extraction.expectationsMet}/${extraction.expectationsTotal} expectations met, ` +
      `${extraction.forbiddenHits} forbidden hits, ${extraction.extras} extras, ${extraction.errors} errors`

    if (runs > 1) {
      totalsLine += `, runs: ${runs}`
    }

    lines.push(totalsLine)
  }
  if (retrieval) {
    lines.push(`Retrieval: ${retrieval.pass}/${retrieval.total} queries passed`)
  }
  lines.forEach((line) => out(line))

  // Write results.jsonl — a retrieval-only smoke run is not a model eval (no LLM
  // involved, nothing that tracks model/prompt/threshold drift), so it never appends
  // to the history file even when a resultsPath is supplied.
  if (resultsPath !== null && mode !== "retrieval") {
    const result = {
      ts: now.toISOString(),
      model: llm.describe(),
      extraction,
      retrieval,
      pass,
    }
    appendFileSync(resultsPath, JSON.stringify(result) + "\n")
  }

  return { pass, extraction, retrieval }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2)
  let mode: "all" | "extraction" | "retrieval" = "all"
  let runs = 1
  let passRate = 1.0

  if (args.includes("--extraction-only")) {
    mode = "extraction"
  } else if (args.includes("--retrieval-only")) {
    mode = "retrieval"
  }

  // Parse --runs N
  const runsIdx = args.indexOf("--runs")
  if (runsIdx >= 0 && runsIdx + 1 < args.length) {
    const runsStr = args[runsIdx + 1]!
    const parsed = parseInt(runsStr, 10)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      console.error(`Error: --runs must be an integer between 1 and 10, got ${runsStr}`)
      process.exit(1)
    }
    runs = parsed
    if (mode === "retrieval") {
      console.error("Error: --runs is only supported for extraction suite")
      process.exit(1)
    }
  }

  // Parse --pass-rate X
  const passRateIdx = args.indexOf("--pass-rate")
  if (passRateIdx >= 0 && passRateIdx + 1 < args.length) {
    const passRateStr = args[passRateIdx + 1]!
    const parsed = parseFloat(passRateStr)
    if (Number.isNaN(parsed) || parsed <= 0 || parsed > 1) {
      console.error(`Error: --pass-rate must be a number in (0, 1], got ${passRateStr}`)
      process.exit(1)
    }
    passRate = parsed
    if (mode === "retrieval") {
      console.error("Error: --pass-rate is only supported for extraction suite")
      process.exit(1)
    }
  }

  const evalDir = import.meta.dir
  const summary = await runEval({ evalDir, mode, runs, passRate })
  process.exit(summary.pass ? 0 : 1)
}
