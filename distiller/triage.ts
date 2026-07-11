import { stripFences } from "./extract"
import type { LlmClient } from "./llm"
import type { TranscriptMeta } from "./transcripts"

export const TRIAGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    worth_extracting: { type: "boolean" },
    why: { type: "string" },
  },
  required: ["worth_extracting", "why"],
}

const SYSTEM = `You triage an AI-coding-agent session transcript for an engineering knowledge distiller. Decide whether this transcript plausibly contains ANY durable engineering knowledge worth a full extraction pass — one of:
- decision: a technical choice plus the rationale (especially user overrides of the agent)
- root_cause: error/symptom -> underlying cause -> verified fix
- pitfall: something that looks right but fails, and why
- know_how: domain/tool knowledge (EDA flows, frameworks, scripts, flags)
- convention: a team/project preference the user enforced or repeated
- workflow: a multi-step procedure that was executed successfully and is reusable

This is a cheap pre-filter, not the real extraction — be permissive. Only answer false for transcripts that are clearly empty of durable knowledge (greetings, pure boilerplate, one-off task chatter with nothing a colleague could reuse six months from now). When in doubt, answer true.

Reply with ONLY valid JSON in this exact format:
{"worth_extracting": <boolean>, "why": "<one line>"}

Do not include any other text, markdown fences, or explanation.`

export function buildTriagePrompt(meta: TranscriptMeta): { system: string; prompt: string } {
  return { system: SYSTEM, prompt: `Transcript:\n\n${meta.body}` }
}

export interface TriageResult {
  worth: boolean
  why: string
  failedOpen: boolean
}

/**
 * Cheap LLM gate above the hard 80-char floor: asks whether the transcript plausibly
 * contains any durable engineering knowledge. Fails OPEN (worth: true, failedOpen: true)
 * on any error — LLM failure, non-JSON output, or a JSON shape missing the boolean field —
 * so a gatekeeping hiccup never silently drops knowledge (quality-first per spec).
 */
export async function llmTriage(meta: TranscriptMeta, llm: LlmClient): Promise<TriageResult> {
  const { system, prompt } = buildTriagePrompt(meta)
  try {
    const raw = await llm.complete({ system, prompt, schema: TRIAGE_SCHEMA })
    const parsed = JSON.parse(stripFences(raw)) as Record<string, unknown>
    if (typeof parsed.worth_extracting !== "boolean")
      return { worth: true, why: "triage returned invalid shape — failing open", failedOpen: true }
    const why = typeof parsed.why === "string" ? parsed.why : ""
    return { worth: parsed.worth_extracting, why, failedOpen: false }
  } catch (e) {
    return {
      worth: true,
      why: `triage failed: ${e instanceof Error ? e.message : String(e)} — failing open`,
      failedOpen: true,
    }
  }
}
