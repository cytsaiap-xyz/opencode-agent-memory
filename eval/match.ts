import type { Candidate } from "../distiller/extract"

export interface ExpectRule { type?: string | string[]; keywords: string[]; min?: number }
export interface ForbidRule { type?: string | string[]; keywords: string[] }
export interface ExtractionCase {
  fixture: string; salience_min?: number
  expect: ExpectRule[]; forbid?: ForbidRule[]
  max_extra?: number; max_total?: number
}
export interface CaseScore {
  fixture: string
  status: "pass" | "fail"
  expectationsMet: number; expectationsTotal: number
  forbiddenHits: string[]        // "matched forbid {keywords} : <candidate title>"
  extras: number                 // valid candidates matched by NO expect rule
  failures: string[]             // human-readable reasons
}

export function candidateMatches(c: Candidate, rule: { type?: string | string[]; keywords: string[] }): boolean {
  if (rule.type) {
    const typeMatches = Array.isArray(rule.type) ? rule.type.includes(c.type) : c.type === rule.type
    if (!typeMatches) return false
  }

  const text = `${c.title} ${c.trigger} ${c.lesson}`.toLowerCase()
  return rule.keywords.every(keyword => text.includes(keyword.toLowerCase()))
}

export function scoreCase(kase: ExtractionCase, candidates: Candidate[]): CaseScore {
  const failures: string[] = []
  const forbiddenHits: string[] = []

  // Check each expect rule
  let expectationsMet = 0
  for (let i = 0; i < kase.expect.length; i++) {
    const rule = kase.expect[i]!
    const matchCount = candidates.filter(c => candidateMatches(c, rule)).length
    const minRequired = rule.min ?? 1

    if (matchCount >= minRequired) {
      expectationsMet++
    } else {
      const typeStr = rule.type ? `type: ${Array.isArray(rule.type) ? JSON.stringify(rule.type) : rule.type}, ` : ""
      failures.push(`expect[${i}] {${typeStr}keywords: ${JSON.stringify(rule.keywords)}} matched ${matchCount} < ${minRequired}`)
    }
  }

  // Check forbid rules and collect forbidden hits
  const forbidRules = kase.forbid ?? []
  for (const forbidRule of forbidRules) {
    for (const candidate of candidates) {
      if (candidateMatches(candidate, forbidRule)) {
        const hit = `matched forbid ${JSON.stringify(forbidRule.keywords)} : ${candidate.title}`
        forbiddenHits.push(hit)
        failures.push(hit)
      }
    }
  }

  // Count extras (candidates matching NO expect rule)
  const extras = candidates.filter(c =>
    !kase.expect.some(rule => rule && candidateMatches(c, rule))
  ).length

  const maxExtra = kase.max_extra ?? Infinity
  if (extras > maxExtra) {
    failures.push(`extras ${extras} > max_extra ${maxExtra}`)
  }

  // Check max_total
  const maxTotal = kase.max_total ?? Infinity
  if (candidates.length > maxTotal) {
    failures.push(`total ${candidates.length} > max_total ${maxTotal}`)
  }

  return {
    fixture: kase.fixture,
    status: failures.length === 0 ? "pass" : "fail",
    expectationsMet,
    expectationsTotal: kase.expect.length,
    forbiddenHits,
    extras,
    failures,
  }
}
