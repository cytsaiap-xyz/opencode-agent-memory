import { createHash } from "node:crypto"
import { anchorsIn, type TranscriptMeta } from "./transcripts"
import type { MemoryType } from "./types"

export interface Candidate {
  type: MemoryType; title: string; trigger: string; lesson: string
  domain: string[]; evidence: Array<{ message_id: string }>
  salience: number; volatile: boolean
}

const TYPES: readonly string[] = ["decision", "root_cause", "pitfall", "know_how", "convention", "workflow"]

export const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: [...TYPES] },
      title: { type: "string" },
      trigger: { type: "string" },
      lesson: { type: "string" },
      domain: { type: "array", items: { type: "string" }, minItems: 1 },
      evidence: { type: "array", items: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] }, minItems: 1 },
      salience: { type: "number" },
      volatile: { type: "boolean" },
    },
    required: ["type", "title", "trigger", "lesson", "domain", "evidence", "salience", "volatile"],
  },
}

const SYSTEM = `You are a knowledge distiller for an engineering team. Read the AI-coding-agent session transcript and extract ONLY durable engineering knowledge a colleague would want six months from now.

Extract items of these types:
- decision: a technical choice plus the rationale (especially user overrides of the agent)
- root_cause: error/symptom -> underlying cause -> verified fix
- pitfall: something that looks right but fails, and why
- know_how: domain/tool knowledge (EDA flows, frameworks, scripts, flags)
- convention: a team/project preference the user enforced or repeated
- workflow: a multi-step procedure that was executed successfully and is reusable

Do NOT extract: file contents, boilerplate, transient task details, anything true only for this one task, secrets/credentials, or knowledge obvious from public documentation.

Rules:
- Each item must be atomic (one lesson) and self-contained (understandable without the transcript).
- evidence must cite the {#msg_id} anchors from the transcript headings.
- Write "lesson" as an imperative or conditional ("When X, do Y because Z"), at most 80 words.
- Score salience 0-10; emit only items scoring at or above the threshold given below.
- If the session contains a failed attempt later corrected, extract the CONTRAST (what was wrong, what fixed it), not the failure alone.
- Mark volatile=true if the fact can go stale (tool versions, current bugs, WIP state).

Output STRICT JSON only — an array of items, no prose, no markdown fences. If nothing qualifies, output [].`

export function buildExtractPrompt(meta: TranscriptMeta): { system: string; prompt: string; promptHash: string } {
  const promptHash = "sha256:" + createHash("sha256").update(SYSTEM).digest("hex").slice(0, 16)
  return { system: SYSTEM, prompt: `Transcript:\n\n${meta.body}`, promptHash }
}

export function stripFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim()
}

const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { label: "token-prefix", re: /\b(?:sk|ghp|gho|xox[bpas])[-_][A-Za-z0-9]{16,}\b/ },
]

export function scanSecrets(text: string): string[] {
  const matches: string[] = []
  for (const { label, re } of SECRET_PATTERNS) if (re.test(text)) matches.push(label)
  for (const token of text.split(/\s+/)) {
    if (token.length < 32) continue
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(token)).length
    if (classes >= 3) {
      matches.push("high-entropy-token")
      break
    }
  }
  return matches
}

export interface ValidationResult {
  valid: Candidate[]
  rejected: Array<{ item: unknown; reasons: string[] }>
  secrets: Array<{ item: Candidate; matches: string[] }>
}

export function validateCandidates(raw: string, meta: TranscriptMeta, salienceMin: number): ValidationResult {
  const parsed: unknown = JSON.parse(stripFences(raw))
  if (!Array.isArray(parsed)) throw new Error("extraction output is not a JSON array")
  const anchors = anchorsIn(meta.body)
  const result: ValidationResult = { valid: [], rejected: [], secrets: [] }

  for (const item of parsed) {
    const reasons: string[] = []
    const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>
    if (typeof o.salience === "number" && o.salience < salienceMin) continue // below threshold: drop silently

    if (typeof o.type !== "string" || !TYPES.includes(o.type)) reasons.push(`invalid type "${String(o.type)}"`)
    for (const key of ["title", "trigger", "lesson"] as const)
      if (typeof o[key] !== "string" || (o[key] as string).trim() === "") reasons.push(`${key} must be a non-empty string`)
    if (typeof o.lesson === "string" && o.lesson.split(/\s+/).length > 80) reasons.push("lesson exceeds 80 words")
    if (!Array.isArray(o.domain) || o.domain.length === 0 || !o.domain.every((d) => typeof d === "string" && d))
      reasons.push("domain must be a non-empty string array")
    if (!Array.isArray(o.evidence) || o.evidence.length === 0) reasons.push("evidence must be a non-empty array")
    else
      for (const ev of o.evidence) {
        const id = (ev as { message_id?: unknown }).message_id
        if (typeof id !== "string") reasons.push("evidence item missing message_id")
        else if (!anchors.has(id)) reasons.push(`hallucinated evidence anchor: ${id}`)
      }
    if (typeof o.salience !== "number") reasons.push("salience must be a number")
    if (typeof o.volatile !== "boolean") reasons.push("volatile must be a boolean")

    if (reasons.length > 0) {
      result.rejected.push({ item, reasons })
      continue
    }
    const candidate = o as unknown as Candidate
    const secretMatches = scanSecrets(`${candidate.title} ${candidate.trigger} ${candidate.lesson}`)
    if (secretMatches.length > 0) result.secrets.push({ item: candidate, matches: secretMatches })
    else result.valid.push(candidate)
  }
  return result
}
