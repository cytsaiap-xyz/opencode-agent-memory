import { mkdir } from "node:fs/promises"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { MemoryConfig } from "../shared/config"
import { buildExtractPrompt, extractFromTranscript, type Candidate } from "./extract"
import { judgeCandidate } from "./judge"
import { Semaphore } from "./limiter"
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
  // Bounds how many transcripts' Phase A (triage/extract/judge) tasks run concurrently
  // (fan-out hygiene for the transcript-level Promise.all below) — the per-call LLM
  // concurrency cap (spec §1.1's withConcurrencyLimit decorator) is a separate, tighter
  // governor applied to deps.llm itself by the CLI layer; this option just stops one
  // pipeline run from firing off hundreds of transcript tasks at once regardless of that.
  concurrency?: number
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

// Phase A's output for one transcript: everything decided by triage/extract/validate/pool/
// judge (all reads — no store/index/ledger writes happen anywhere in producing this), handed
// to the strictly-sequential Phase B for the writes. Exactly one variant is populated:
//   - "error": the transcript failed Phase A (all extract runs errored, or another exception
//     escaped triage/extract/judge) — Phase B skips it entirely (errors++, not ledgered).
//   - "ledgerOnly": triaged out (hard floor or heuristic/llm triage) before ever reaching
//     extraction — Phase B only needs to recordProcessed (n_candidates/n_committed both 0).
//   - "ready": extraction succeeded — Phase B writes secrets, reconciles toReconcile, and
//     records processed with the real counts.
type PreparedTranscript =
  | { meta: TranscriptMeta; kind: "error" }
  | { meta: TranscriptMeta; kind: "ledgerOnly"; triagedHeuristic: boolean; triagedLlm: boolean }
  | {
      meta: TranscriptMeta
      kind: "ready"
      promptHash: string
      poolRaw: number
      candidates: number
      rejected: number
      toReconcile: Candidate[]
      secretPool: Array<{ item: Candidate; matches: string[] }>
    }

interface PrepareOpts { salienceMin: number; triageMode: "llm" | "heuristic"; extractRuns: number; judges: number }

// Phase A body for a single transcript — triage, extraction (xN), validation, pool dedup,
// and judging. ZERO store/index/ledger writes happen anywhere below: everything here is
// either a pure computation or a read-only LLM call, so N of these can run concurrently
// (bounded by the Semaphore in runPipeline) without any of the single-writer hazards
// (duplicate ADDs, TOCTOU id collisions) that RECONCILE/COMMIT still require serialization
// for — those stay in Phase B.
async function prepareTranscript(meta: TranscriptMeta, llm: LlmClient, opts: PrepareOpts): Promise<PreparedTranscript> {
  try {
    // promptHash is a pure hash of the fixed SYSTEM template (not the transcript), so
    // this cheap call is independent of extractFromTranscript's actual LLM request.
    const { promptHash } = buildExtractPrompt(meta)

    if (meta.body.length < HARD_FLOOR_BODY) {
      return { meta, kind: "ledgerOnly", triagedHeuristic: true, triagedLlm: false }
    }

    if (opts.triageMode === "heuristic") {
      if (meta.body.length < TRIAGE_MIN_BODY) {
        return { meta, kind: "ledgerOnly", triagedHeuristic: true, triagedLlm: false }
      }
    } else {
      const verdict = await llmTriage(meta, llm)
      if (verdict.failedOpen) {
        console.error(`distiller: ${meta.sessionId}: triage failed open: ${verdict.why}`)
      } else if (!verdict.worth) {
        console.error(`distiller: ${meta.sessionId}: triaged out: ${verdict.why}`)
        return { meta, kind: "ledgerOnly", triagedHeuristic: false, triagedLlm: true }
      }
    }

    // EXTRACT x N: independent CONCURRENT runs (Promise.all). Each of the N closures below
    // is a single leaf-level `extractFromTranscript` invocation (itself one leaf-level
    // `llm.complete()` call) — Promise.all fans out N INDEPENDENT calls side by side, never
    // one acquisition nested inside another, so a concurrency decorator around
    // `llm.complete` sees exactly N flat acquire/release pairs here (same invariant as
    // judge.ts's panel loop). Each run is validated on its own so a single bad run's schema
    // garbage can't poison the pool. A run that errors is logged and tolerated; the batch
    // only fails (errors++, not ledgered — retried next run) if ALL runs error.
    // `runResults` is indexed by run i regardless of which call settles first (Promise.all
    // preserves input order), so the concatenation below stays in run-index order —
    // dedupPool is a greedy, order-dependent left-to-right merge, and the union must stay
    // deterministic.
    const runResults = await Promise.all(
      Array.from({ length: opts.extractRuns }, (_, i) =>
        (async () => {
          try {
            return await extractFromTranscript(meta, llm, opts.salienceMin)
          } catch (e) {
            console.error(
              `distiller: ${meta.sessionId}: extract run ${i + 1}/${opts.extractRuns} failed: ${e instanceof Error ? e.message : String(e)}`,
            )
            return null
          }
        })(),
      ),
    )

    let allValid: Candidate[] = []
    let allSecrets: Array<{ item: Candidate; matches: string[] }> = []
    let allRejected: Array<{ item: unknown; reasons: string[] }> = []
    let runErrors = 0
    for (const validated of runResults) {
      if (validated === null) {
        runErrors++
        continue
      }
      allValid = allValid.concat(validated.valid)
      allSecrets = allSecrets.concat(validated.secrets)
      allRejected = allRejected.concat(validated.rejected)
    }
    if (runErrors === opts.extractRuns) {
      throw new Error(`all ${opts.extractRuns} extraction runs failed`)
    }

    for (const rej of allRejected)
      console.error(`distiller: ${meta.sessionId}: rejected candidate: ${rej.reasons.join("; ")}`)

    const poolRaw = allValid.length + allSecrets.length

    const pooled = dedupPool(allValid)
    const secretPool = dedupSecrets(allSecrets)
    const candidatesCount = pooled.candidates.length + secretPool.length

    // JUDGE: after validation and pool dedup only (never spend judges on schema-invalid
    // or duplicate candidates). Drop candidates whose consensus median falls below the
    // salience floor — the same silent-drop semantics as the extractor's own self-score
    // threshold in validateCandidates (below-threshold candidates are simply never
    // counted, not rejected-with-reason).
    let toReconcile = pooled.candidates
    // judges <= 1 disables judging entirely (judgeCandidate itself short-circuits with
    // panel: 0 — see judge.ts); gating the loop the same way here just skips the
    // pointless per-candidate call, it isn't required for correctness.
    if (opts.judges > 1) {
      // Spec §1.2: judge panels across candidates run CONCURRENTLY, not one candidate's
      // panel at a time. judgeCandidate never rejects (every LLM/parse failure inside it is
      // caught and turned into an abstention — see judge.ts), so Promise.all here can't
      // short-circuit on a per-candidate rejection; each closure is a single leaf-level
      // judgeCandidate call, side by side, same flat fan-out shape as judge.ts's own
      // per-candidate panel and prepareTranscript's EXTRACT×N loop above. Promise.all
      // preserves input order regardless of which candidate's panel settles first, so
      // mapping to { c, verdict } and then filtering/pushing in a plain for-loop keeps
      // `kept` in the same order as pooled.candidates.
      const judged = await Promise.all(
        pooled.candidates.map(async (c) => ({ c, verdict: await judgeCandidate(c, llm, opts.judges) })),
      )
      const kept: Candidate[] = []
      for (const { c, verdict } of judged) {
        console.error(
          `distiller: ${meta.sessionId}: judge: ${c.title} self:${verdict.selfScore} median:${verdict.salience} panel:${verdict.voted}/${verdict.panel}`,
        )
        if (verdict.salience < opts.salienceMin) continue
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

    return {
      meta, kind: "ready", promptHash,
      poolRaw, candidates: candidatesCount, rejected: allRejected.length,
      toReconcile, secretPool,
    }
  } catch (e) {
    console.error(`distiller: ${meta.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`)
    return { meta, kind: "error" }
  }
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
  const concurrency = opts.concurrency ?? 8
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

  // Sequential pre-loop: eligibility and the isProcessed ledger check are both read-only,
  // but the resulting dispatch list must be built up front (not decided inside a concurrent
  // task) so Phase A's fan-out and Phase B's commit order both work off one fixed,
  // deterministic list of transcripts, in scanSpool's stable (time_end) order.
  // Dedupe by (session_id, content_hash) during pre-pass — first wins, duplicates logged.
  const dispatch: TranscriptMeta[] = []
  const seenTranscripts = new Set<string>()
  for (const meta of metas) {
    if (!isEligible(meta, now, idleHours)) continue
    summary.eligible++
    if (deps.index.ledger.isProcessed(meta.sessionId, meta.contentHash)) {
      summary.skippedProcessed++
      continue
    }
    const dedupeKey = `${meta.sessionId}|${meta.contentHash}`
    if (seenTranscripts.has(dedupeKey)) {
      console.error(`distiller: duplicate dispatch: ${meta.sessionId}/${meta.contentHash} (first wins, dropping)`)
      // Same (session_id, content_hash) as an already-dispatched transcript this run — this
      // is functionally "already handled this run" the same way an isProcessed ledger hit
      // is "already handled a prior run", so it counts into skippedProcessed too (legacy
      // counter semantics: skippedProcessed == "eligible but not actually processed").
      summary.skippedProcessed++
      continue
    }
    seenTranscripts.add(dedupeKey)
    dispatch.push(meta)
  }

  // Phase A (concurrent, bounded): triage -> extract xN -> validate -> pool dedup -> judge,
  // per transcript, with ZERO store/index/ledger writes. Bounded by a Semaphore so one
  // pipeline run doesn't fire off an unbounded number of transcript tasks at once (the
  // per-LLM-call concurrency cap from spec §1.1 is a separate, tighter governor applied to
  // deps.llm itself by the caller). `prepared` comes back in dispatch (= metas) order
  // regardless of which task actually settles first — Promise.all preserves input order —
  // which is the property Phase B's determinism depends on.
  const sem = new Semaphore(concurrency)
  const prepared = await Promise.all(
    dispatch.map((meta) =>
      (async () => {
        const release = await sem.acquire()
        try {
          return await prepareTranscript(meta, deps.llm, { salienceMin, triageMode, extractRuns, judges })
        } finally {
          release()
        }
      })(),
    ),
  )

  // Phase B (strictly sequential, in the ORIGINAL metas order — not completion order):
  // secrets quarantine writes -> reconcile each candidate -> recordProcessed. RECONCILE/
  // COMMIT stay single-writer here: two concurrent reconciles racing the same store would
  // blind each other to just-added memories (duplicate ADDs), and the policy-interception +
  // id-uniquify checks have TOCTOU windows — so this loop is a plain sequential `for`, never
  // Promise.all, and it is the only place in the pipeline that touches the store/index/
  // ledger.
  for (const p of prepared) {
    if (p.kind === "error") {
      summary.errors++
      continue
    }
    if (p.kind === "ledgerOnly") {
      summary.triagedOut++
      if (p.triagedHeuristic) summary.triagedHeuristic++
      if (p.triagedLlm) summary.triagedLlm++
      try {
        deps.index.ledger.recordProcessed({
          session_id: p.meta.sessionId, content_hash: p.meta.contentHash,
          extractor_model: extractor, n_candidates: 0, n_committed: 0,
        })
      } catch (e) {
        summary.errors++
        console.error(`distiller: ${p.meta.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      continue
    }

    // p.kind === "ready"
    // Defensive re-check: even after dedupe in pre-pass, guard against concurrent writes
    // to the same (session_id, content_hash) pair if one somehow slipped through.
    if (deps.index.ledger.isProcessed(p.meta.sessionId, p.meta.contentHash)) {
      console.error(`distiller: ${p.meta.sessionId} already processed (defensive re-check), skipping`)
      continue
    }
    summary.rejected += p.rejected
    summary.poolRaw += p.poolRaw
    summary.candidates += p.candidates
    try {
      for (const sec of p.secretPool) {
        const qe = quarantineEntry(sec.item, p.meta, now, extractor, p.promptHash)
        qe.notes.push(`${now.toISOString().slice(0, 10)}: quarantined — secret scan: ${sec.matches.join(", ")}`)
        await writeQuarantineEntry(cfg.storeDir, deps.index, qe)
        summary.quarantined++
      }

      let committed = 0
      for (const c of p.toReconcile) {
        const r = await reconcileCandidate(c, p.meta, {
          llm: deps.llm, index: deps.index, storeDir: cfg.storeDir, now, extractorLabel: extractor, promptHash: p.promptHash,
        })
        if (r.op === "ADD") { summary.ops.added++; committed++ }
        else if (r.op === "UPDATE") { summary.ops.updated++; committed++ }
        else if (r.op === "SUPERSEDE") { summary.ops.superseded++; committed++ }
        else if (r.op === "SUPERSEDE_PENDING") { summary.quarantined++ }
        else summary.ops.nooped++
      }

      deps.index.ledger.recordProcessed({
        session_id: p.meta.sessionId, content_hash: p.meta.contentHash,
        extractor_model: extractor, n_candidates: p.candidates, n_committed: committed,
      })
    } catch (e) {
      summary.errors++
      console.error(`distiller: ${p.meta.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`)
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
