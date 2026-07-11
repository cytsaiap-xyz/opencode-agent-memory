import type { Candidate } from "./extract"

/**
 * Tokenize a string using the same unicode-aware split as ledger/indexes.
 * Splits on anything that isn't a letter (\p{L}), number (\p{N}), or underscore.
 */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
}

/**
 * Calculate Jaccard similarity (overlap / union) of two token sets.
 * Returns a number in [0, 1].
 */
export function titleJaccard(a: string, b: string): number {
  const tokensA = new Set(tokenize(a))
  const tokensB = new Set(tokenize(b))

  if (tokensA.size === 0 && tokensB.size === 0) {
    // both empty: return 1 only if raw strings are identical (e.g., "!!!" === "!!!")
    return a.trim() === b.trim() ? 1 : 0
  }
  if (tokensA.size === 0 || tokensB.size === 0) return 0 // one empty, one not

  let intersection = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++
  }

  const union = tokensA.size + tokensB.size - intersection
  return intersection / union
}

/**
 * Check if two candidates are duplicates.
 * Spec rule: same type AND (titleJaccard >= 0.6 OR identical trigger)
 */
export function isDuplicate(a: Candidate, b: Candidate): boolean {
  if (a.type !== b.type) return false

  // identical trigger shortcut
  if (a.trigger === b.trigger) return true

  // title similarity threshold
  return titleJaccard(a.title, b.title) >= 0.6
}

/**
 * Merge two candidates into one.
 * Rules:
 * - Keep the candidate with the longer lesson (more specific)
 * - Evidence: union, deduped by message_id, preserving first-occurrence order across both
 * - Salience: max of the two
 * - Volatile: OR (true if either is true)
 * - Domain: union, deduped, order-preserving
 */
export function mergeCandidates(a: Candidate, b: Candidate): Candidate {
  // Determine which has the longer lesson
  const keeper = a.lesson.length >= b.lesson.length ? a : b

  // Union evidence by message_id, preserving first-occurrence order (a's order first, then b's new ones)
  const seenIds = new Set<string>()
  const merged_evidence: Array<{ message_id: string }> = []
  for (const ev of a.evidence) {
    if (!seenIds.has(ev.message_id)) {
      seenIds.add(ev.message_id)
      merged_evidence.push(ev)
    }
  }
  for (const ev of b.evidence) {
    if (!seenIds.has(ev.message_id)) {
      seenIds.add(ev.message_id)
      merged_evidence.push(ev)
    }
  }

  // Domain: union, deduped, order-preserving (a's order first, then b's new ones)
  const seenDomains = new Set<string>()
  const merged_domain: string[] = []
  for (const d of a.domain) {
    if (!seenDomains.has(d)) {
      seenDomains.add(d)
      merged_domain.push(d)
    }
  }
  for (const d of b.domain) {
    if (!seenDomains.has(d)) {
      seenDomains.add(d)
      merged_domain.push(d)
    }
  }

  return {
    type: keeper.type,
    title: keeper.title,
    trigger: keeper.trigger,
    lesson: keeper.lesson,
    domain: merged_domain,
    evidence: merged_evidence,
    salience: Math.max(a.salience, b.salience),
    volatile: a.volatile || b.volatile,
  }
}

/**
 * Deduplicate a pool of candidates using greedy left-to-right approach.
 * Each candidate either merges into the first existing pool member it
 * duplicates (in-place), or appends to the pool if no duplicate found.
 */
export function dedupPool(pool: Candidate[]): { candidates: Candidate[]; merged: number } {
  const result: Candidate[] = []
  let mergedCount = 0

  for (const candidate of pool) {
    let merged = false
    for (let i = 0; i < result.length; i++) {
      if (isDuplicate(candidate, result[i]!)) {
        // Merge into the first duplicate found
        result[i] = mergeCandidates(result[i]!, candidate)
        mergedCount++
        merged = true
        break
      }
    }

    if (!merged) {
      result.push(candidate)
    }
  }

  return { candidates: result, merged: mergedCount }
}
