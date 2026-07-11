import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Candidate } from "./extract"
import { stripFences } from "./extract"
import type { LlmClient } from "./llm"
import type { MemoryQuery } from "./indexes"
import { writeQuarantineEntry } from "./quarantine"
import { computeConfidence, entryId, parseEntry, writeEntry } from "./store"
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
  llm: LlmClient; index: MemoryQuery; storeDir: string; now: Date
  extractorLabel: string; promptHash: string
}

function entryFromCandidate(c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps): MemoryEntry {
  const nowIso = deps.now.toISOString()
  // Per-entry judge provenance (spec: judges: k/N median m), dated like every other note
  // on this entry — only present when the candidate actually went through JUDGE.
  const notes: string[] = []
  if (c.judgeNote) notes.push(`${nowIso.slice(0, 10)}: ${c.judgeNote}`)
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
    supersedes: null,
    promoted_from: null,
    review: "auto",
    evidence: [{ session: meta.sessionId, anchors: c.evidence.map((e) => e.message_id), observed_at: meta.timeEnd }],
    provenance: { extractor: deps.extractorLabel, prompt_hash: deps.promptHash },
    created_at: nowIso,
    updated_at: nowIso,
    lesson: c.lesson,
    notes,
  }
}

// Returns null (no mutation) when the target has drifted out of the index (row/file
// mismatch) or is no longer "active" (e.g. superseded mid-flight) — callers must degrade
// to an ADD instead of throwing or polluting a frozen tombstone with fresh evidence/notes.
async function applyUpdate(
  targetId: string, note: string, c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps,
): Promise<MemoryEntry | null> {
  const hit = deps.index.getById(targetId)
  if (!hit || hit.entry.status !== "active") return null
  const target = hit.entry
  const day = deps.now.toISOString().slice(0, 10)
  // Evidence for this session already exists — this is a same-session re-extraction
  // (e.g. a rerun that reconciles to UPDATE again), not new evidence. Only append the
  // evidence + reconcile note the first time a given session is seen, or reruns duplicate
  // notes on every pass.
  if (!target.evidence.some((ev) => ev.session === meta.sessionId)) {
    target.evidence.push({ session: meta.sessionId, anchors: c.evidence.map((e) => e.message_id), observed_at: meta.timeEnd })
    target.notes.push(`${day}: ${note} (${meta.sessionId})`)
    if (c.judgeNote) target.notes.push(`${day}: ${c.judgeNote}`)
  }
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

// Shared by the ADD path and the SUPERSEDE new-entry path. Checks the FULL store by id
// (not just the active FTS neighbors passed in from the caller), so an existing entry that
// isn't surfaced as a neighbor — quarantined, archived, or simply outside the FTS top-N —
// can never be silently overwritten by writeEntry:
//   - no existing entry with this id -> plain ADD.
//   - existing entry is "active"     -> degrade to an UPDATE (re-extraction of the same
//                                       project+title+day knowledge); applyUpdate is
//                                       guaranteed to succeed since we just confirmed active.
//   - existing entry is any other status -> the collision is with a frozen/dead entry, not
//                                       live knowledge; uniquify the id and ADD a fresh
//                                       entry, leaving the existing one completely untouched.
async function addEntry(
  c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps,
): Promise<{ op: "ADD" | "UPDATE"; entry: MemoryEntry }> {
  const entry = entryFromCandidate(c, meta, deps)
  const collision = deps.index.getById(entry.id)
  if (!collision) {
    const path = await writeEntry(deps.storeDir, entry)
    deps.index.upsertEntry(entry, path)
    return { op: "ADD", entry }
  }
  if (collision.entry.status === "active") {
    const updated = await applyUpdate(entry.id, "re-extracted", c, meta, deps)
    return { op: "UPDATE", entry: updated! }
  }
  let suffix = 2
  let id = `${entry.id}-${suffix}`
  while (deps.index.getById(id)) {
    suffix++
    id = `${entry.id}-${suffix}`
  }
  const uniquified: MemoryEntry = { ...entry, id }
  const path = await writeEntry(deps.storeDir, uniquified)
  deps.index.upsertEntry(uniquified, path)
  return { op: "ADD", entry: uniquified }
}

// Scans quarantine/*.md for an already-pending proposal against the same target so two
// candidates (from the same or different sessions/batches) contradicting the same policy
// memory don't each spawn their own quarantine file — the human reviews one proposal, not
// a pile of duplicates. Tolerant of unreadable/unparseable files (best-effort dedupe, never
// fatal) and of a missing quarantine/ directory (nothing pending yet).
export function findExistingPending(storeDir: string, targetId: string): MemoryEntry | null {
  const quarantineDir = join(storeDir, "quarantine")
  let files: string[] = []
  try {
    files = readdirSync(quarantineDir).filter((f) => f.endsWith(".md"))
  } catch {
    return null
  }
  for (const f of files) {
    try {
      const entry = parseEntry(readFileSync(join(quarantineDir, f), "utf8"))
      if (entry.supersedes === targetId && entry.status === "quarantined" && entry.review === "human_pending")
        return entry
    } catch {
      // tolerate a corrupt/unparseable quarantine file — skip it, keep scanning
    }
  }
  return null
}

// Shared by the UPDATE and SUPERSEDE branches: decision/convention memories represent
// deliberate human calls (banned patterns, team conventions) — an automatic mutation could
// silently flip a rule the LLM misjudged (or, worse, merge a CONTRADICTING session in as
// corroborating evidence, observed live). Route these into the quarantine review queue
// instead of auto-applying; the target is left completely untouched pending human approval.
async function interceptPending(
  c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps, targetId: string, verb: "update" | "supersede", detail: string,
): Promise<{ op: "SUPERSEDE_PENDING"; entry: MemoryEntry }> {
  const existing = findExistingPending(deps.storeDir, targetId)
  if (existing) return { op: "SUPERSEDE_PENDING", entry: existing }

  const pending: MemoryEntry = {
    ...entryFromCandidate(c, meta, deps),
    status: "quarantined",
    review: "human_pending",
    supersedes: targetId,
  }
  pending.notes.push(
    `${deps.now.toISOString().slice(0, 10)}: pending review — proposes to ${verb} ${targetId}: ${detail}`,
  )
  const entry = await writeQuarantineEntry(deps.storeDir, deps.index, pending)
  return { op: "SUPERSEDE_PENDING", entry }
}

// Shared "supersede target -> byId" mechanics, factored out so distiller/reflect.ts's MERGE
// op (absorb -> keep, where keep already exists) can ride the exact same policy governance
// as reconcile's SUPERSEDE (candidate -> new entry). Given only a target entry and the *id*
// of whatever now supersedes it, applies the same two-way split the inline SUPERSEDE code
// below used to do: decision/convention targets are deliberate human calls, so instead of
// auto-mutating them, the entry that supersedes them (byId, looked up fresh via the index) is
// cloned as a quarantined proposal — supersedes: target.id, routed through the existing
// review queue via writeQuarantineEntry (which uniquifies the id, since byId's own row is
// still occupying that id) — exactly like reconcile's interceptPending does for its candidate
// case, and dedupes against an already-pending proposal via findExistingPending. Anything
// else is tombstoned in place, pointing at byId — reconcile's non-policy SUPERSEDE branch
// only ever reaches this half (the policy branch is intercepted upstream, before a byId even
// exists), so its output stays byte-identical to before this extraction.
export async function applySupersession(
  target: MemoryEntry,
  byId: string,
  reason: string,
  deps: { storeDir: string; index: MemoryQuery; now: Date },
): Promise<{ op: "SUPERSEDE" | "SUPERSEDE_PENDING"; entry: MemoryEntry }> {
  const dateStr = deps.now.toISOString().slice(0, 10)
  if (target.type === "decision" || target.type === "convention") {
    const existing = findExistingPending(deps.storeDir, target.id)
    if (existing) return { op: "SUPERSEDE_PENDING", entry: existing }
    const byHit = deps.index.getById(byId)
    const base = byHit ? byHit.entry : target
    const pending: MemoryEntry = {
      ...base,
      status: "quarantined",
      review: "human_pending",
      supersedes: target.id,
      updated_at: deps.now.toISOString(),
      notes: [...base.notes, `${dateStr}: pending review — proposes to merge ${target.id} into ${byId}: ${reason}`],
    }
    const entry = await writeQuarantineEntry(deps.storeDir, deps.index, pending)
    return { op: "SUPERSEDE_PENDING", entry }
  }
  const updated: MemoryEntry = {
    ...target,
    status: "superseded",
    superseded_by: byId,
    updated_at: deps.now.toISOString(),
    notes: [...target.notes, `${dateStr}: superseded by ${byId} — ${reason}`],
  }
  const path = await writeEntry(deps.storeDir, updated)
  deps.index.upsertEntry(updated, path)
  return { op: "SUPERSEDE", entry: updated }
}

export async function reconcileCandidate(
  c: Candidate, meta: TranscriptMeta, deps: ReconcileDeps,
): Promise<{ op: ReconcileOp["op"] | "SUPERSEDE_PENDING"; entry?: MemoryEntry }> {
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
    case "ADD":
      return await addEntry(c, meta, deps)
    case "UPDATE": {
      const target = neighbors.find((h) => h.entry.id === decision.target_id)!
      // Same governance gate as SUPERSEDE below: the LLM cannot be trusted to distinguish
      // agreement from contradiction, so ANY mutation of a decision/convention memory —
      // not just an explicit SUPERSEDE — goes through human review instead of auto-applying.
      if (target.entry.type === "decision" || target.entry.type === "convention")
        return await interceptPending(c, meta, deps, decision.target_id, "update", decision.note)
      const updated = await applyUpdate(decision.target_id, decision.note, c, meta, deps)
      // Drifted out of the index or no longer active (superseded mid-flight): the
      // knowledge must not be silently dropped, so fall back to adding it fresh.
      if (updated) return { op: "UPDATE", entry: updated }
      return await addEntry(c, meta, deps)
    }
    case "SUPERSEDE": {
      const target = neighbors.find((h) => h.entry.id === decision.target_id)!
      if (target.entry.type === "decision" || target.entry.type === "convention")
        return await interceptPending(c, meta, deps, decision.target_id, "supersede", decision.reason)
      const added = await addEntry(c, meta, deps)
      // addEntry degraded to UPDATE (the candidate's computed id collided with an active
      // entry — normally the target itself, since it came from these same active
      // neighbors): nothing new was created, so there is nothing to tombstone.
      if (added.op === "UPDATE") return added
      const entry = added.entry
      // target.entry.type is guaranteed non-policy here (the decision/convention branch
      // above already returned via interceptPending), so applySupersession always takes
      // its direct-tombstone path — byte-identical to the inline code this replaced.
      await applySupersession(target.entry, entry.id, decision.reason, { storeDir: deps.storeDir, index: deps.index, now: deps.now })
      return { op: "SUPERSEDE", entry }
    }
    case "NOOP":
      return { op: "NOOP" }
  }
}
