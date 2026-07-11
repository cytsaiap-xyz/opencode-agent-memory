import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildExtractPrompt, EXTRACT_SCHEMA, validateCandidates } from "../distiller/extract"
import type { LlmClient } from "../distiller/llm"
import { clientFromEnv } from "../distiller/llm"
import { MemoryIndex } from "../distiller/ledger"
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
  }
  retrieval?: {
    pass: number
    total: number
  }
}

async function runExtraction(
  evalDir: string,
  llm: LlmClient,
  out: (line: string) => void,
  salienceMin: number,
): Promise<{
  fixturesPass: number
  fixturesTotal: number
  expectationsMet: number
  expectationsTotal: number
  forbiddenHits: number
  extras: number
  errors: number
}> {
  const casesPath = join(evalDir, "cases.json")
  const cases: ExtractionCase[] = JSON.parse(readFileSync(casesPath, "utf8"))
  const fixturesDir = join(evalDir, "fixtures")

  let fixturesPass = 0
  let expectationsMet = 0
  let expectationsTotal = 0
  let forbiddenHits = 0
  let extras = 0
  let errors = 0

  for (const kase of cases) {
    const fixturePath = join(fixturesDir, kase.fixture)
    try {
      const content = readFileSync(fixturePath, "utf8")
      const meta = parseTranscript(fixturePath, content)

      const { system, prompt } = buildExtractPrompt(meta)
      const salMin = kase.salience_min ?? salienceMin
      const raw = await llm.complete({
        system: `${system}\n\nSalience threshold: ${salMin}.`,
        prompt,
        schema: EXTRACT_SCHEMA,
      })
      const validated = validateCandidates(raw, meta, salMin)
      const caseScore = scoreCase(kase, validated.valid)

      if (caseScore.status === "pass") fixturesPass++
      expectationsMet += caseScore.expectationsMet
      expectationsTotal += caseScore.expectationsTotal
      forbiddenHits += caseScore.forbiddenHits.length
      extras += caseScore.extras

      const symbol = caseScore.status === "pass" ? "✓" : "✗"
      out(
        `${symbol} ${kase.fixture} — expectations ${caseScore.expectationsMet}/${caseScore.expectationsTotal}, forbidden ${caseScore.forbiddenHits.length}, extras ${caseScore.extras}`,
      )
    } catch (e) {
      errors++
      const msg = e instanceof Error ? e.message : String(e)
      out(`! ${kase.fixture} — error: ${msg}`)
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
): Promise<{
  pass: number
  total: number
}> {
  const tmpDir = await mkdtemp(join(tmpdir(), "eval-retrieval-"))
  try {
    const dbPath = join(tmpDir, "index.db")
    const index = new MemoryIndex(dbPath)
    try {
      const storeDir = join(evalDir, "retrieval", "store")
      await index.rebuildFrom(storeDir)

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
  const salienceMin = 6

  let extraction: EvalRunSummary["extraction"]
  let retrieval: EvalRunSummary["retrieval"]
  let pass = true

  if (mode === "all" || mode === "extraction") {
    extraction = await runExtraction(opts.evalDir, llm, out, salienceMin)
    if (extraction.errors > 0 || extraction.fixturesPass < extraction.fixturesTotal) {
      pass = false
    }
  }

  if (mode === "all" || mode === "retrieval") {
    retrieval = await runRetrieval(opts.evalDir, out)
    if (retrieval.pass < retrieval.total) {
      pass = false
    }
  }

  // Print scorecard totals
  const lines: string[] = []
  if (extraction) {
    lines.push(
      `Extraction: ${extraction.fixturesPass}/${extraction.fixturesTotal} fixtures passed, ` +
        `${extraction.expectationsMet}/${extraction.expectationsTotal} expectations met, ` +
        `${extraction.forbiddenHits} forbidden hits, ${extraction.extras} extras, ${extraction.errors} errors`,
    )
  }
  if (retrieval) {
    lines.push(`Retrieval: ${retrieval.pass}/${retrieval.total} queries passed`)
  }
  lines.forEach(out)

  // Write results.jsonl
  if (resultsPath !== null) {
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

  if (args.includes("--extraction-only")) {
    mode = "extraction"
  } else if (args.includes("--retrieval-only")) {
    mode = "retrieval"
  }

  const evalDir = import.meta.dir
  const summary = await runEval({ evalDir, mode })
  process.exit(summary.pass ? 0 : 1)
}
