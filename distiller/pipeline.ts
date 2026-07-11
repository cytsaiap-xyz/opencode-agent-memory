import { mkdir } from "node:fs/promises"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { MemoryConfig } from "../shared/config"
import { buildExtractPrompt, extractFromTranscript, type Candidate } from "./extract"
import { judgeCandidate } from "./judge"
import type { LlmClient } from "./llm"
import type { MemoryQuery } from "./indexes"
import { dedupPool, isDuplicate, mergeCandidates } from "./pool"
import { writeQuarantineEntry } from "./quarantine"
import { reconcileCandidate } from "./reconcile"
import { computeConfidence, entryId, listEntryPaths, readEntry } from "./store"
import { llmTriage } from "./triage"
import { isEligible, scanSpool, type TranscriptMeta } from "./transcripts"
import type { MemoryEntry } from "./types"

export interface RunSummary {
  scanned: number; eligible: number; skippedProcessed: number; triagedOut: number
  triagedLlm: number; triagedHeuristic: number; poolRaw: number
  candidates: number; rejected: number; quarantined: number
  ops: { added: number; updated: number; superseded: number; nooped: number }
  errors: number
}

export interface PipelineOptions {
  project?: string; now?: Date; idleHours?: number; salienceMin?: number
  triage?: "llm" | "heuristic"; extractRuns?: number; judges?: number
}

// Degenerate transcripts (a greeting cannot hold durable knowledge) never reach triage,
// LLM or heuristic — this floor is unconditional.
const HARD_FLOOR_BODY = 80
// Heuristic-mode-only gate (AGENT_MEMORY_TRIAGE=heuristic): the pre-quality-pack behavior.
const TRIAGE_MIN_BODY = 400

function quarantineEntry(c: Candidate, meta: TranscriptMeta, now: Date, extractor: string, promptHash: string): MemoryEntry {
  const nowIso = now.toISOString()
  return {
    id: entryId(meta.project, c.title, now),
    memory_class: c.type === "workflow" ? "procedural" : "semantic",
    type: c.type, title: c.title, trigger: c.trigger,
    project: meta.project, scope: "project", domain: c.domain, volatile: c.volatile,
    confidence: computeConfidence({ sessions: 1, humanApproved: false, contradicted: false }),
    status: "quarantined", superseded_by: null, supersedes: null, promoted_from: null, absorbs: null, review: "human_pending",
    evidence: [{ session: meta.sessionId, anchors: c.evidence.map((e) => e.message_id), observed_at: meta.timeEnd }],
    provenance: { extractor, prompt_hash: promptHash },
    created_at: nowIso, updated_at: nowIso, lesson: c.lesson, notes: [],
  }
}

// Union secrets across extraction runs, deduped by the same type+title/trigger rule as the
// main pool, merging matches too — a secret candidate is still a Candidate, so it can
// duplicate across runs exactly like a regular one.
function dedupSecrets(
  items: Array<{ item: Candidate; matches: string[] }>,
): Array<{ item: Candidate; matches: string[] }> {
  const result: Array<{ item: Candidate; matches: string[] }> = []
  for (const sec of items) {
    const idx = result.findIndex((r) => isDuplicate(sec.item, r.item))
    if (idx === -1) {
      result.push({ item: sec.item, matches: [...sec.matches] })
    } else {
      result[idx] = {
        item: mergeCandidates(result[idx]!.item, sec.item),
        matches: [...new Set([...result[idx]!.matches, ...sec.matches])],
      }
    }
  }
  return result
}

export async function runPipeline(
  cfg: MemoryConfig,
  deps: { llm: LlmClient; index: MemoryQuery },
  opts: PipelineOptions = {},
): Promise<RunSummary> {
  const now = opts.now ?? new Date()
  const idleHours = opts.idleHours ?? 6
  const salienceMin = opts.salienceMin ?? 6
  const triageMode = opts.triage ?? "llm"
  const extractRuns = opts.extractRuns ?? 2
  const judges = opts.judges ?? 3
  // No " judges:N" suffix here — the run-level judge count is documented as env
  // configuration (README/LLM_WIKI); per-candidate judge provenance (whether THIS
  // candidate was actually judged, its median, and voting turnout) is recorded on the
  // entry itself via Candidate.judgeNote below, since a run-level label can't distinguish
  // a judged candidate from a secret quarantined without ever reaching JUDGE.
  const extractor = `distiller v0.1 / ${deps.llm.describe()}`
  const summary: RunSummary = {
    scanned: 0, eligible: 0, skippedProcessed: 0, triagedOut: 0,
    triagedLlm: 0, triagedHeuristic: 0, poolRaw: 0,
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
      if (deps.index.ledger.isProcessed(meta.sessionId, meta.contentHash)) {
        summary.skippedProcessed++
        continue
      }

      // promptHash is a pure hash of the fixed SYSTEM template (not the transcript), so
      // this cheap call is independent of extractFromTranscript's actual LLM request.
      const { promptHash } = buildExtractPrompt(meta)

      if (meta.body.length < HARD_FLOOR_BODY) {
        summary.triagedOut++
        summary.triagedHeuristic++
        deps.index.ledger.recordProcessed({
          session_id: meta.sessionId, content_hash: meta.contentHash,
          extractor_model: extractor, n_candidates: 0, n_committed: 0,
        })
        continue
      }

      if (triageMode === "heuristic") {
        if (meta.body.length < TRIAGE_MIN_BODY) {
          summary.triagedOut++
          summary.triagedHeuristic++
          deps.index.ledger.recordProcessed({
            session_id: meta.sessionId, content_hash: meta.contentHash,
            extractor_model: extractor, n_candidates: 0, n_committed: 0,
          })
          continue
        }
      } else {
        const verdict = await llmTriage(meta, deps.llm)
        if (verdict.failedOpen) {
          console.error(`distiller: ${meta.sessionId}: triage failed open: ${verdict.why}`)
        } else if (!verdict.worth) {
          summary.triagedOut++
          summary.triagedLlm++
          console.error(`distiller: ${meta.sessionId}: triaged out: ${verdict.why}`)
          deps.index.ledger.recordProcessed({
            session_id: meta.sessionId, content_hash: meta.contentHash,
            extractor_model: extractor, n_candidates: 0, n_committed: 0,
          })
          continue
        }
      }

      // EXTRACT x N: independent sequential runs. Each run is validated on its own so a
      // single bad run's schema garbage can't poison the pool. A run that errors is logged
      // and tolerated; the batch only fails (errors++, not ledgered — retried next run) if
      // ALL runs error. Concatenated in run-index order — dedupPool is a greedy,
      // order-dependent left-to-right merge, so the union must stay deterministic.
      let allValid: Candidate[] = []
      let allSecrets: Array<{ item: Candidate; matches: string[] }> = []
      let allRejected: Array<{ item: unknown; reasons: string[] }> = []
      let runErrors = 0
      for (let i = 0; i < extractRuns; i++) {
        try {
          const validated = await extractFromTranscript(meta, deps.llm, salienceMin)
          allValid = allValid.concat(validated.valid)
          allSecrets = allSecrets.concat(validated.secrets)
          allRejected = allRejected.concat(validated.rejected)
        } catch (e) {
          runErrors++
          console.error(
            `distiller: ${meta.sessionId}: extract run ${i + 1}/${extractRuns} failed: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      if (runErrors === extractRuns) {
        throw new Error(`all ${extractRuns} extraction runs failed`)
      }

      summary.rejected += allRejected.length
      for (const rej of allRejected)
        console.error(`distiller: ${meta.sessionId}: rejected candidate: ${rej.reasons.join("; ")}`)

      summary.poolRaw += allValid.length + allSecrets.length

      const pooled = dedupPool(allValid)
      const secretPool = dedupSecrets(allSecrets)
      summary.candidates += pooled.candidates.length + secretPool.length

      for (const sec of secretPool) {
        const qe = quarantineEntry(sec.item, meta, now, extractor, promptHash)
        qe.notes.push(`${now.toISOString().slice(0, 10)}: quarantined — secret scan: ${sec.matches.join(", ")}`)
        await writeQuarantineEntry(cfg.storeDir, deps.index, qe)
        summary.quarantined++
      }

      // JUDGE: after validation and pool dedup only (never spend judges on schema-invalid
      // or duplicate candidates). Drop candidates whose consensus median falls below the
      // salience floor — the same silent-drop semantics as the extractor's own self-score
      // threshold in validateCandidates (below-threshold candidates are simply never
      // counted, not rejected-with-reason).
      let toReconcile = pooled.candidates
      // judges <= 1 disables judging entirely (judgeCandidate itself short-circuits with
      // panel: 0 — see judge.ts); gating the loop the same way here just skips the
      // pointless per-candidate call, it isn't required for correctness.
      if (judges > 1) {
        const kept: Candidate[] = []
        for (const c of pooled.candidates) {
          const verdict = await judgeCandidate(c, deps.llm, judges)
          console.error(
            `distiller: ${meta.sessionId}: judge: ${c.title} self:${verdict.selfScore} median:${verdict.salience} panel:${verdict.voted}/${verdict.panel}`,
          )
          if (verdict.salience < salienceMin) continue
          // Per-candidate judge provenance recorded on the entry itself (see
          // reconcile.ts's entryFromCandidate/applyUpdate), not a run-level label — a
          // fallback (all judges abstained) gets its own wording since voted is always 0
          // there and "median" would be misleading (there was no consensus to take).
          const judgeNote = verdict.usedFallback
            ? `judged: fallback self-score ${verdict.selfScore} (0/${verdict.panel})`
            : `judged: median ${verdict.salience} (${verdict.voted}/${verdict.panel})`
          kept.push({ ...c, salience: verdict.salience, judgeNote })
        }
        toReconcile = kept
      }

      let committed = 0
      for (const c of toReconcile) {
        const r = await reconcileCandidate(c, meta, {
          llm: deps.llm, index: deps.index, storeDir: cfg.storeDir, now, extractorLabel: extractor, promptHash,
        })
        if (r.op === "ADD") { summary.ops.added++; committed++ }
        else if (r.op === "UPDATE") { summary.ops.updated++; committed++ }
        else if (r.op === "SUPERSEDE") { summary.ops.superseded++; committed++ }
        else if (r.op === "SUPERSEDE_PENDING") { summary.quarantined++ }
        else summary.ops.nooped++
      }

      deps.index.ledger.recordProcessed({
        session_id: meta.sessionId, content_hash: meta.contentHash,
        extractor_model: extractor, n_candidates: pooled.candidates.length + secretPool.length, n_committed: committed,
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
