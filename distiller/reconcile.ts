import type { Candidate } from "./extract"
import { stripFences } from "./extract"
import type { LlmClient } from "./llm"
import type { MemoryIndex } from "./ledger"
import { computeConfidence, entryId, writeEntry } from "./store"
import type { TranscriptMeta } from "./transcripts"
import type { MemoryEntry } from "./types"

export type ReconcileOp =
  | { op: "ADD" }
  | { op: "NOOP"; target_id: string; reason: string }
  | { op: "UPDATE"; target_id: string; note: string }
  | { op: "SUPERSEDE"; target_id: string; reason: string }

export const RECONCILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["ADD", "NOOP", "UPDATE", "SUPERSEDE"] },
    target_id: { type: "string" },
    note: { type: "string" },
    reason: { type: "string" },
  },
  required: ["op"],
}

const RECONCILE_SYSTEM = `You reconcile a candidate memory against existing memories in an engineering knowledge store. Choose exactly one operation:
- ADD: the candidate is genuinely new knowledge not covered by any existing memory.
- NOOP: an existing memory already states this; nothing new. Set target_id and reason.
- UPDATE: an existing memory covers the same lesson and the candidate adds evidence or nuance. Set target_id and a one-sentence note describing what the new session adds.
- SUPERSEDE: the candidate CONTRADICTS an existing memory because reality changed (new fix replaces old workaround, flow migrated). Set target_id and reason. Do not use SUPERSEDE for mere additions.
Reply with ONLY JSON: {"op": "...", "target_id": "...", "note": "...", "reason": "..."} (target_id/note/reason only where the op requires them).`

export function buildReconcilePrompt(
  c: Candidate,
  neighbors: Array<{ id: string; title: string; trigger: string; lesson: string }>,
): { system: string; prompt: string } {
  const lines = neighbors.map((n) => `- id: ${n.id}\n  title: ${n.title}\n  trigger: ${n.trigger}\n  lesson: ${n.lesson}`)
  return {
    system: RECONCILE_SYSTEM,
    prompt: `Candidate:\n  type: ${c.type}\n  title: ${c.title}\n  trigger: ${c.trigger}\n  lesson: ${c.lesson}\n\nExisting memories:\n${lines.join("\n")}`,
  }
}

export function parseReconcileOp(raw: string, neighborIds: string[]): ReconcileOp {
  const o = JSON.parse(stripFences(raw)) as Record<string, unknown>
  const op = o.op
  if (op === "ADD") return { op: "ADD" }
  if (op !== "NOOP" && op !== "UPDATE" && op !== "SUPERSEDE") throw new Error(`reconcile: invalid op "${String(op)}"`)
  const target = o.target_id
  if (typeof target !== "string" || !neighborIds.includes(target))
    throw new Error(`reconcile: target_id "${String(target)}" is not one of the presented neighbors`)
  if (op === "UPDATE") return { op, target_id: target, note: typeof o.note === "string" ? o.note : "additional evidence" }
  return { op, target_id: target, reason: typeof o.reason === "string" ? o.reason : "unspecified" }
}

export interface ReconcileDeps {
  llm: LlmClient; index: MemoryIndex; storeDir: string; now: Date
  extractorLabel: string; promptHash: string
}

function entryFromCandidate(c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps): MemoryEntry {
  const nowIso = deps.now.toISOString()
  return {
    id: entryId(meta.project, c.title, deps.now),
    memory_class: c.type === "workflow" ? "procedural" : "semantic",
    type: c.type,
    title: c.title,
    trigger: c.trigger,
    project: meta.project,
    scope: "project",
    domain: c.domain,
    volatile: c.volatile,
    confidence: computeConfidence({ sessions: 1, humanApproved: false, contradicted: false }),
    status: "active",
    superseded_by: null,
    review: "auto",
    evidence: [{ session: meta.sessionId, anchors: c.evidence.map((e) => e.message_id), observed_at: meta.timeEnd }],
    provenance: { extractor: deps.extractorLabel, prompt_hash: deps.promptHash },
    created_at: nowIso,
    updated_at: nowIso,
    lesson: c.lesson,
    notes: [],
  }
}

async function applyUpdate(
  targetId: string, note: string, c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps,
): Promise<MemoryEntry> {
  const hit = deps.index.getById(targetId)
  if (!hit) throw new Error(`reconcile: target ${targetId} not found in index`)
  const target = hit.entry
  const day = deps.now.toISOString().slice(0, 10)
  if (!target.evidence.some((ev) => ev.session === meta.sessionId))
    target.evidence.push({ session: meta.sessionId, anchors: c.evidence.map((e) => e.message_id), observed_at: meta.timeEnd })
  target.notes.push(`${day}: ${note} (${meta.sessionId})`)
  if (target.project !== meta.project && target.scope === "project")
    target.notes.push(`${day}: promotion candidate: seen in ${meta.project}`)
  const sessions = new Set(target.evidence.map((ev) => ev.session)).size
  target.confidence = computeConfidence({
    sessions, humanApproved: target.review === "human_approved", contradicted: false,
  })
  target.updated_at = deps.now.toISOString()
  const newPath = await writeEntry(deps.storeDir, target)
  deps.index.upsertEntry(target, newPath)
  return target
}

export async function reconcileCandidate(
  c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps,
): Promise<{ op: ReconcileOp["op"]; entry?: MemoryEntry }> {
  const neighbors = deps.index.search(`${c.title} ${c.lesson}`, { status: "active", limit: 5 })
  let decision: ReconcileOp
  if (neighbors.length === 0) {
    decision = { op: "ADD" }
  } else {
    const { system, prompt } = buildReconcilePrompt(c, neighbors.map((h) => ({
      id: h.entry.id, title: h.entry.title, trigger: h.entry.trigger, lesson: h.entry.lesson,
    })))
    const raw = await deps.llm.complete({ system, prompt, schema: RECONCILE_SCHEMA })
    decision = parseReconcileOp(raw, neighbors.map((h) => h.entry.id))
  }

  switch (decision.op) {
    case "ADD": {
      const entry = entryFromCandidate(c, meta, deps)
      const collision = neighbors.find((h) => h.entry.id === entry.id)
      if (collision) return { op: "UPDATE", entry: await applyUpdate(entry.id, "re-extracted", c, meta, deps) }
      const path = await writeEntry(deps.storeDir, entry)
      deps.index.upsertEntry(entry, path)
      return { op: "ADD", entry }
    }
    case "UPDATE":
      return { op: "UPDATE", entry: await applyUpdate(decision.target_id, decision.note, c, meta, deps) }
    case "SUPERSEDE": {
      const target = neighbors.find((h) => h.entry.id === decision.target_id)!
      const entry = entryFromCandidate(c, meta, deps)
      if (entry.id === target.entry.id)
        return { op: "UPDATE", entry: await applyUpdate(entry.id, "re-extracted", c, meta, deps) }
      const path = await writeEntry(deps.storeDir, entry)
      deps.index.upsertEntry(entry, path)
      const old = target.entry
      old.status = "superseded"
      old.superseded_by = entry.id
      old.notes.push(`${deps.now.toISOString().slice(0, 10)}: superseded by ${entry.id} — ${decision.reason}`)
      old.updated_at = deps.now.toISOString()
      const oldPath = await writeEntry(deps.storeDir, old)
      deps.index.upsertEntry(old, oldPath)
      return { op: "SUPERSEDE", entry }
    }
    case "NOOP":
      return { op: "NOOP" }
  }
}
