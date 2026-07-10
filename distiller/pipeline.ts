import { mkdir } from "node:fs/promises"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { MemoryConfig } from "../shared/config"
import { buildExtractPrompt, EXTRACT_SCHEMA, validateCandidates, type Candidate } from "./extract"
import type { LlmClient } from "./llm"
import type { MemoryIndex } from "./ledger"
import { writeQuarantineEntry } from "./quarantine"
import { reconcileCandidate } from "./reconcile"
import { computeConfidence, entryId, listEntryPaths, readEntry } from "./store"
import { isEligible, scanSpool, type TranscriptMeta } from "./transcripts"
import type { MemoryEntry } from "./types"

export interface RunSummary {
  scanned: number; eligible: number; skippedProcessed: number; triagedOut: number
  candidates: number; rejected: number; quarantined: number
  ops: { added: number; updated: number; superseded: number; nooped: number }
  errors: number
}

export interface PipelineOptions { project?: string; now?: Date; idleHours?: number; salienceMin?: number }

const TRIAGE_MIN_BODY = 400

function quarantineEntry(c: Candidate, meta: TranscriptMeta, now: Date, extractor: string, promptHash: string): MemoryEntry {
  const nowIso = now.toISOString()
  return {
    id: entryId(meta.project, c.title, now),
    memory_class: c.type === "workflow" ? "procedural" : "semantic",
    type: c.type, title: c.title, trigger: c.trigger,
    project: meta.project, scope: "project", domain: c.domain, volatile: c.volatile,
    confidence: computeConfidence({ sessions: 1, humanApproved: false, contradicted: false }),
    status: "quarantined", superseded_by: null, supersedes: null, review: "human_pending",
    evidence: [{ session: meta.sessionId, anchors: c.evidence.map((e) => e.message_id), observed_at: meta.timeEnd }],
    provenance: { extractor, prompt_hash: promptHash },
    created_at: nowIso, updated_at: nowIso, lesson: c.lesson, notes: [],
  }
}

export async function runPipeline(
  cfg: MemoryConfig,
  deps: { llm: LlmClient; index: MemoryIndex },
  opts: PipelineOptions = {},
): Promise<RunSummary> {
  const now = opts.now ?? new Date()
  const idleHours = opts.idleHours ?? 6
  const salienceMin = opts.salienceMin ?? 6
  const extractor = `distiller v0.1 / ${deps.llm.describe()}`
  const summary: RunSummary = {
    scanned: 0, eligible: 0, skippedProcessed: 0, triagedOut: 0,
    candidates: 0, rejected: 0, quarantined: 0,
    ops: { added: 0, updated: 0, superseded: 0, nooped: 0 }, errors: 0,
  }

  let metas = scanSpool(cfg.transcriptsDir)
  if (opts.project) metas = metas.filter((m) => m.project === opts.project)
  summary.scanned = metas.length

  for (const meta of metas) {
    try {
      if (!isEligible(meta, now, idleHours)) continue
      summary.eligible++
      if (deps.index.isProcessed(meta.sessionId, meta.contentHash)) {
        summary.skippedProcessed++
        continue
      }
      if (meta.body.length < TRIAGE_MIN_BODY) {
        summary.triagedOut++
        deps.index.recordProcessed({
          session_id: meta.sessionId, content_hash: meta.contentHash,
          extractor_model: extractor, n_candidates: 0, n_committed: 0,
        })
        continue
      }

      const { system, prompt, promptHash } = buildExtractPrompt(meta)
      const raw = await deps.llm.complete({ system: `${system}\n\nSalience threshold: ${salienceMin}.`, prompt, schema: EXTRACT_SCHEMA })
      const validated = validateCandidates(raw, meta, salienceMin)
      summary.candidates += validated.valid.length + validated.secrets.length
      summary.rejected += validated.rejected.length
      for (const rej of validated.rejected)
        console.error(`distiller: ${meta.sessionId}: rejected candidate: ${rej.reasons.join("; ")}`)

      for (const sec of validated.secrets) {
        const qe = quarantineEntry(sec.item, meta, now, extractor, promptHash)
        qe.notes.push(`${now.toISOString().slice(0, 10)}: quarantined — secret scan: ${sec.matches.join(", ")}`)
        await writeQuarantineEntry(cfg.storeDir, deps.index, qe)
        summary.quarantined++
      }

      let committed = 0
      for (const c of validated.valid) {
        const r = await reconcileCandidate(c, meta, {
          llm: deps.llm, index: deps.index, storeDir: cfg.storeDir, now, extractorLabel: extractor, promptHash,
        })
        if (r.op === "ADD") { summary.ops.added++; committed++ }
        else if (r.op === "UPDATE") { summary.ops.updated++; committed++ }
        else if (r.op === "SUPERSEDE") { summary.ops.superseded++; committed++ }
        else if (r.op === "SUPERSEDE_PENDING") { summary.quarantined++ }
        else summary.ops.nooped++
      }

      deps.index.recordProcessed({
        session_id: meta.sessionId, content_hash: meta.contentHash,
        extractor_model: extractor, n_candidates: validated.valid.length + validated.secrets.length, n_committed: committed,
      })
    } catch (e) {
      summary.errors++
      console.error(`distiller: ${meta.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  await renderIndexMd(cfg.storeDir)
  return summary
}

export async function renderIndexMd(storeDir: string): Promise<void> {
  const byProject = new Map<string, MemoryEntry[]>()
  // Keyed by id so an entry that (through some past bug or transitional state) shows up
  // both under memories/ and quarantine/ is only listed once.
  const quarantined = new Map<string, MemoryEntry>()
  for (const path of listEntryPaths(storeDir)) {
    try {
      const e = await readEntry(path)
      if (e.status === "quarantined") quarantined.set(e.id, e)
      else if (e.status === "active" || e.status === "candidate") {
        const list = byProject.get(e.project) ?? []
        list.push(e)
        byProject.set(e.project, list)
      }
    } catch {
      // unparseable entry: skip in index rendering
    }
  }
  // Also enumerate quarantine directory
  const quarantineDir = join(storeDir, "quarantine")
  let qFiles: string[] = []
  try {
    qFiles = readdirSync(quarantineDir).filter((f) => f.endsWith(".md")).map((f) => join(quarantineDir, f))
  } catch {
    // quarantine dir doesn't exist yet
  }
  for (const path of qFiles) {
    try {
      const e = await readEntry(path)
      quarantined.set(e.id, e)
    } catch {
      // unparseable entry: skip in index rendering
    }
  }
  const lines: string[] = ["# Memory Index", ""]
  for (const [project, entries] of [...byProject.entries()].sort()) {
    lines.push(`## ${project}`, "")
    for (const e of entries.sort((a, b) => a.type.localeCompare(b.type) || b.confidence - a.confidence))
      lines.push(`- [${e.title}](memories/${e.project}/${e.id}.md) — ${e.type}, confidence ${e.confidence}, ${e.status}`)
    lines.push("")
  }
  if (quarantined.size > 0) {
    lines.push("## Quarantine", "")
    for (const e of quarantined.values()) lines.push(`- ${e.id}: ${e.title}`)
    lines.push("")
  }
  await mkdir(storeDir, { recursive: true })
  await Bun.write(join(storeDir, "INDEX.md"), lines.join("\n"))
}
