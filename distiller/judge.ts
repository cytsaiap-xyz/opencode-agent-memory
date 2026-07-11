import type { Candidate } from "./extract"
import { stripFences } from "./extract"
import type { LlmClient } from "./llm"

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    salience: { type: "number" },
    reason: { type: "string" },
  },
  required: ["salience", "reason"],
}

const SYSTEM = `You are a judge evaluating the salience of engineering knowledge extracted from a coding session. A memory is salient if it contains durable engineering knowledge a colleague would want to reference six months from now.

The memory will be one of these types:
- decision: a technical choice plus the rationale (especially user overrides of the agent)
- root_cause: error/symptom -> underlying cause -> verified fix
- pitfall: something that looks right but fails, and why
- know_how: domain/tool knowledge (EDA flows, frameworks, scripts, flags)
- convention: a team/project preference the user enforced or repeated
- workflow: a multi-step procedure that was executed successfully and is reusable

Assess whether this memory contains durable engineering knowledge a colleague would want six months from now. Score it 0-10 where:
- 0-3: not valuable (trivia, task-specific, or inaccurate)
- 4-6: somewhat useful (minor pitfall or convention)
- 7-8: valuable (decision rationale, important know-how)
- 9-10: essential (critical workflow, root cause, or repeated pattern)

Reply with ONLY valid JSON in this exact format:
{"salience": <number>, "reason": "<one sentence>"}

Do not include any other text, markdown fences, or explanation.`

export function buildJudgePrompt(c: Candidate): { system: string; prompt: string } {
  const prompt = `Memory type: ${c.type}
Title: ${c.title}
Trigger: ${c.trigger}
Lesson: ${c.lesson}`

  return { system: SYSTEM, prompt }
}

/**
 * Calculate the median of an array of numbers.
 * For odd-length arrays: returns the middle value.
 * For even-length arrays: returns the lower-middle value (more conservative).
 */
export function medianConsensus(scores: number[]): number {
  if (scores.length === 0) {
    throw new Error("medianConsensus: empty array")
  }

  // Sort in ascending order
  const sorted = [...scores].sort((a, b) => a - b)

  if (sorted.length % 2 === 1) {
    // Odd length: return middle
    return sorted[Math.floor(sorted.length / 2)]!
  } else {
    // Even length: return lower-middle (index length/2 - 1)
    return sorted[sorted.length / 2 - 1]!
  }
}

export interface JudgeVerdict {
  salience: number
  panel: number
  voted: number
  selfScore: number
  usedFallback: boolean
}

/**
 * Judge a candidate using N independent LLM calls for consensus voting.
 * Returns a verdict with median consensus score.
 */
export async function judgeCandidate(
  c: Candidate,
  llm: LlmClient,
  judges: number,
): Promise<JudgeVerdict> {
  // Short-circuit for judges=0 or negative
  if (judges <= 0) {
    return {
      salience: c.salience,
      panel: 0,
      voted: 0,
      selfScore: c.salience,
      usedFallback: true,
    }
  }

  const { system, prompt } = buildJudgePrompt(c)
  const votes: number[] = []

  // Collect N votes via sequential LLM calls
  for (let i = 0; i < judges; i++) {
    try {
      const response = await llm.complete({ system, prompt, schema: JUDGE_SCHEMA })
      const cleanedResponse = stripFences(response)

      let parsed: unknown
      try {
        parsed = JSON.parse(cleanedResponse)
      } catch {
        // JSON parse failed: abstain
        continue
      }

      // Extract salience from parsed response
      const parsed_obj = parsed as Record<string, unknown>
      const salience = parsed_obj.salience
      if (typeof salience !== "number" || isNaN(salience) || salience < 0 || salience > 10) {
        // Invalid salience: abstain
        continue
      }

      votes.push(salience)
    } catch {
      // LLM call failed: abstain
      continue
    }
  }

  // Handle verdict based on collected votes
  if (votes.length === 0) {
    // All judges abstained: fallback to self-score
    return {
      salience: c.salience,
      panel: judges,
      voted: 0,
      selfScore: c.salience,
      usedFallback: true,
    }
  }

  // Calculate median consensus
  const median = medianConsensus(votes)

  return {
    salience: median,
    panel: judges,
    voted: votes.length,
    selfScore: c.salience,
    usedFallback: false,
  }
}
