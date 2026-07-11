import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { MemoryConfig } from "../shared/config"
import { buildClusters, type Cluster } from "./cluster"
import type { Candidate } from "./extract"
import { stripFences } from "./extract"
import type { MemoryQuery } from "./indexes"
import { judgeCandidate } from "./judge"
import type { LlmClient } from "./llm"
import { writeQuarantineEntry } from "./quarantine"
import { applySupersession, findExistingPending } from "./reconcile"
import { computeConfidence, entryId, entryPath, listEntryPaths, readEntry, uniquifyEntryId, writeEntry } from "./store"
import { scanSpool } from "./transcripts"
import type { EvidenceRef, MemoryEntry, MemoryStatus, MemoryType } from "./types"

const TYPES: readonly MemoryType[] = ["decision", "root_cause", "pitfall", "know_how", "convention", "workflow"]

export type ReflectOp =
  | { op: "insight"; type: MemoryType; title: string; trigger: string; lesson: string; domain: string[]; cites: string[] }
  | { op: "merge"; keep: string; absorb: string[]; reason: string }
  | { op: "none"; reason: string }

export const REFLECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["insight", "merge", "none"] },
    type: { type: "string", enum: [...TYPES] },
    title: { type: "string" },
    trigger: { type: "string" },
    lesson: { type: "string" },
    domain: { type: "array", items: { type: "string" } },
    cites: { type: "array", items: { type: "string" } },
    keep: { type: "string" },
    absorb: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["op"],
}

const REFLECT_SYSTEM = `You perform cross-session reflection over a cluster of related engineering memories from a knowledge store. The cluster below was grouped by shared domain and textual similarity. Choose exactly ONE operation:
- insight: the members reveal a genuinely higher-order pattern across sessions that no single member already states (not a restatement of one member). Emit {"op":"insight","type":"<decision|root_cause|pitfall|know_how|convention|workflow>","title":"...","trigger":"...","lesson":"...","domain":["..."],"cites":["<>=2 member ids that support this insight>"]}.
- merge: two or more members state the SAME lesson in different words (a near-duplicate write-time reconcile missed). Emit {"op":"merge","keep":"<member id to keep>","absorb":["<member id(s) to absorb into keep>"],"reason":"..."}.
- none: the cluster is thematic coincidence only; do nothing. Emit {"op":"none","reason":"..."}.
Reply with ONLY valid JSON, no prose, no markdown fences.`

const REFLECT_PROMPT_HASH = "sha256:" + createHash("sha256").update(REFLECT_SYSTEM).digest("hex").slice(0, 16)

export function buildReflectPrompt(cluster: Cluster): { system: string; prompt: string } {
  const lines = cluster.members.map(
    (m) => `- id: ${m.entry.id}\n  type: ${m.entry.type}\n  title: ${m.entry.title}\n  trigger: ${m.entry.trigger}\n  lesson: ${m.entry.lesson}`,
  )
  return {
    system: REFLECT_SYSTEM,
    prompt: `Domain: ${cluster.domain}\n\nCluster members:\n${lines.join("\n")}`,
  }
}

export function parseReflectOp(raw: string, memberIds: string[]): ReflectOp {
  const o = JSON.parse(stripFences(raw)) as Record<string, unknown>
  const op = o.op

  if (op === "none") {
    return { op: "none", reason: typeof o.reason === "string" ? o.reason : "unspecified" }
  }

  if (op === "insight") {
    const type = o.type
    if (typeof type !== "string" || !(TYPES as readonly string[]).includes(type))
      throw new Error(`reflect: insight has invalid type "${String(type)}"`)
    const title = o.title
    if (typeof title !== "string" || title.trim() === "") throw new Error("reflect: insight.title must be a non-empty string")
    const trigger = o.trigger
    if (typeof trigger !== "string" || trigger.trim() === "") throw new Error("reflect: insight.trigger must be a non-empty string")
    const lesson = o.lesson
    if (typeof lesson !== "string" || lesson.trim() === "") throw new Error("reflect: insight.lesson must be a non-empty string")
    const domain = o.domain
    if (!Array.isArray(domain) || domain.length === 0 || !domain.every((d) => typeof d === "string" && d))
      throw new Error("reflect: insight.domain must be a non-empty string array")
    const cites = o.cites
    if (!Array.isArray(cites) || cites.length < 2 || !cites.every((c) => typeof c === "string" && memberIds.includes(c)))
      throw new Error("reflect: insight.cites must be >=2 member ids drawn from the cluster")
    return {
      op: "insight", type: type as MemoryType, title, trigger, lesson,
      domain: domain as string[], cites: cites as string[],
    }
  }

  if (op === "merge") {
    const keep = o.keep
    if (typeof keep !== "string" || !memberIds.includes(keep))
      throw new Error(`reflect: merge.keep "${String(keep)}" is not one of the cluster members`)
    const absorb = o.absorb
    if (!Array.isArray(absorb) || absorb.length === 0 || !absorb.every((a) => typeof a === "string" && memberIds.includes(a)))
      throw new Error("reflect: merge.absorb must be a non-empty array of cluster member ids")
    if ((absorb as string[]).includes(keep)) throw new Error("reflect: merge.keep must not also appear in absorb")
    return { op: "merge", keep, absorb: absorb as string[], reason: typeof o.reason === "string" ? o.reason : "unspecified" }
  }

  throw new Error(`reflect: invalid op "${String(op)}"`)
}

export interface ReflectSummary {
  clusters: number; insights: number; merges: number; mergesPending: number
  promotions: number; skipped: number; errors: number
}

export interface ReflectDeps {
  index: MemoryQuery; storeDir: string; llm: LlmClient; judges: number
  salienceMin: number; now: Date; dryRun: boolean; log: (line: string) => void
}

// Reads the ENTIRE store (memories/ via listEntryPaths, plus quarantine/) — used both for the
// active-only clustering input and for the promoted_from/status lookups the promotion scan
// needs (which must also see pending quarantine copies). Tolerant of unparseable files and of
// a missing quarantine/ directory, matching FileScanIndex's own scan semantics.
async function readAllStoreEntries(storeDir: string): Promise<Array<{ entry: MemoryEntry; path: string }>> {
  const paths = [...listEntryPaths(storeDir)]
  const quarantineDir = join(storeDir, "quarantine")
  try {
    for (const f of readdirSync(quarantineDir)) if (f.endsWith(".md")) paths.push(join(quarantineDir, f))
  } catch {
    // no quarantine dir yet
  }
  const out: Array<{ entry: MemoryEntry; path: string }> = []
  for (const p of paths) {
    try {
      out.push({ entry: await readEntry(p), path: p })
    } catch {
      // unparseable entry: tolerate, skip (never abort the scan)
    }
  }
  return out
}

// Evidence refs carry no project field, so "distinct evidence projects" is resolved by
// cross-referencing each evidence session id against the live transcript spool (a session
// lives under exactly one project directory). Sessions whose transcript has since been
// cleaned up are simply not counted — this is a best-effort signal layered on top of the
// always-reliable "promotion candidate" note reconcile already leaves.
function distinctEvidenceProjects(entry: MemoryEntry, sessionProject: Map<string, string>): number {
  const projects = new Set<string>()
  for (const ev of entry.evidence) {
    const p = sessionProject.get(ev.session)
    if (p) projects.add(p)
  }
  return projects.size
}

// Union of evidence lists, deduped by session — same-session refs have their anchors merged
// (deduped) rather than duplicated, matching reconcile's own "dedup by session" evidence rule.
function unionEvidenceRefs(lists: EvidenceRef[][]): EvidenceRef[] {
  const bySession = new Map<string, EvidenceRef>()
  for (const list of lists) {
    for (const ev of list) {
      const existing = bySession.get(ev.session)
      if (existing) bySession.set(ev.session, { ...existing, anchors: [...new Set([...existing.anchors, ...ev.anchors])] })
      else bySession.set(ev.session, { ...ev, anchors: [...ev.anchors] })
    }
  }
  return [...bySession.values()]
}

const derivedFromNote = (memberIds: string[]): string => `derived from: ${[...memberIds].sort().join(",")}`

// True when some active entry's notes already carry the EXACT derived-from tag for this
// member set — anchored to end-of-note (not a bare substring test) so a superset cluster's
// tag (e.g. "derived from: a,b,c") can never be mistaken for a match on a subset's tag
// ("derived from: a,b").
function hasDerivedFromNote(entries: Array<{ entry: MemoryEntry }>, tag: string): boolean {
  const marker = "derived from: "
  return entries.some(({ entry }) =>
    entry.notes.some((n) => {
      const idx = n.indexOf(marker)
      return idx !== -1 && n.slice(idx) === tag
    }),
  )
}

export async function runReflect(cfg: MemoryConfig, deps: ReflectDeps, opts?: { project?: string }): Promise<ReflectSummary> {
  const summary: ReflectSummary = { clusters: 0, insights: 0, merges: 0, mergesPending: 0, promotions: 0, skipped: 0, errors: 0 }
  const project = opts?.project

  const sessionProject = new Map<string, string>()
  try {
    for (const t of scanSpool(cfg.transcriptsDir)) sessionProject.set(t.sessionId, t.project)
  } catch {
    // transcripts spool unreadable: promotion scan falls back to the notes-based signal only
  }

  const initialAll = await readAllStoreEntries(deps.storeDir)
  const activeAll = initialAll.filter(({ entry }) => entry.status === "active")
  // Insight entries carry their own "derived from:" note and must never become raw material
  // for a FURTHER insight — the design spec is explicit that insight-of-insights recursion is
  // out of scope. Without this exclusion, a synthesized insight (same domain, textually
  // similar to the members it was derived from) would rejoin a cluster with those very
  // members on the next run, changing the cluster's member-id tag and defeating the
  // pre-LLM idempotency check below.
  const clusterInput = activeAll.filter(
    ({ entry }) => !project || entry.project === project,
  ).filter(({ entry }) => !entry.notes.some((n) => n.includes("derived from: ")))

  const clusters = buildClusters(clusterInput)
  summary.clusters = clusters.length

  // Tracks members tombstoned by an EARLIER cluster within this same run (a multi-domain
  // member can appear in more than one cluster) so a later cluster's merge doesn't try to
  // absorb an already-gone member — the initial `activeAll` snapshot alone can't see this.
  const statusOverride = new Map<string, MemoryStatus>()

  for (const cluster of clusters) {
    try {
      const memberIds = cluster.members.map((m) => m.entry.id).sort()
      const tag = derivedFromNote(memberIds)
      if (hasDerivedFromNote(activeAll, tag)) {
        summary.skipped++
        continue
      }

      const { system, prompt } = buildReflectPrompt(cluster)
      const raw = await deps.llm.complete({ system, prompt, schema: REFLECT_SCHEMA })

      let op: ReflectOp
      try {
        op = parseReflectOp(raw, cluster.members.map((m) => m.entry.id))
      } catch (e) {
        summary.errors++
        deps.log(`reflect: cluster [${memberIds.join(",")}] parse error: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }

      if (op.op === "none") {
        summary.skipped++
        continue
      }

      if (op.op === "insight") {
        const candidate: Candidate = {
          type: op.type, title: op.title, trigger: op.trigger, lesson: op.lesson,
          domain: op.domain, evidence: [], salience: 10, volatile: false,
        }
        let judgeNote: string | undefined
        if (deps.judges > 1) {
          const verdict = await judgeCandidate(candidate, deps.llm, deps.judges)
          // Fail CLOSED, not open: a total panel failure (every judge abstained) makes
          // judgeCandidate fall back to the candidate's own synthetic self-score (10 for a
          // reflect-derived insight, by construction above), which would otherwise
          // auto-pass every insight whenever the judge panel is unavailable. An insight
          // that never got independent judgment is withheld, not written on a
          // rubber-stamped self-score.
          if (verdict.usedFallback) {
            summary.skipped++
            deps.log(`reflect: cluster [${memberIds.join(",")}] insight judge panel failed — withheld`)
            continue
          }
          if (verdict.salience < deps.salienceMin) {
            summary.skipped++
            continue
          }
          judgeNote = `judged: median ${verdict.salience} (${verdict.voted}/${verdict.panel})`
        }

        const sortedMembers = [...cluster.members].sort((a, b) => a.entry.id.localeCompare(b.entry.id))
        const dateStr = deps.now.toISOString().slice(0, 10)
        const notes: string[] = [`${dateStr}: ${tag}`]
        if (judgeNote) notes.push(`${dateStr}: ${judgeNote}`)

        const projects = new Set(sortedMembers.map((m) => m.entry.project))
        const entryProject = projects.size === 1 ? [...projects][0]! : "global"
        const scope: "project" | "global" = entryProject === "global" ? "global" : "project"

        const evidence = unionEvidenceRefs(sortedMembers.map((m) => m.entry.evidence))
        const sessions = new Set(evidence.map((e) => e.session)).size
        const confidence = computeConfidence({ sessions, humanApproved: false, contradicted: false })

        const nowIso = deps.now.toISOString()
        const entry: MemoryEntry = {
          id: entryId(entryProject, op.title, deps.now),
          memory_class: "semantic",
          type: op.type,
          title: op.title,
          trigger: op.trigger,
          project: entryProject,
          scope,
          domain: op.domain,
          volatile: false,
          confidence,
          status: "active",
          superseded_by: null,
          supersedes: null,
          promoted_from: null,
          absorbs: null,
          review: "auto",
          evidence,
          provenance: { extractor: `distiller v0.1 reflect / ${deps.llm.describe()}`, prompt_hash: REFLECT_PROMPT_HASH },
          created_at: nowIso,
          updated_at: nowIso,
          lesson: op.lesson,
          notes,
        }

        if (deps.dryRun) {
          deps.log(`[dry-run] insight: would create "${entry.title}" (${entry.type}) citing ${memberIds.join(",")}`)
        } else {
          // entryId is deterministic on project+title+day: a same-project/title/day
          // collision with an existing (possibly unrelated) entry must never silently
          // overwrite that entry's file or repoint its index row — uniquify against
          // both the filesystem and the index first, mirroring reconcile.ts's addEntry
          // / quarantine.ts's writeQuarantineEntry convention.
          const finalEntry = uniquifyEntryId(
            entry,
            (id) => entryPath(deps.storeDir, { ...entry, id }),
            (id) => deps.index.getById(id),
          )
          const path = await writeEntry(deps.storeDir, finalEntry)
          deps.index.upsertEntry(finalEntry, path)
        }
        summary.insights++
        continue
      }

      // op.op === "merge"
      const keepItem = cluster.members.find((m) => m.entry.id === op.keep)!
      const alreadyGone = op.absorb.some((id) => {
        const current = statusOverride.get(id) ?? cluster.members.find((m) => m.entry.id === id)!.entry.status
        return current !== "active"
      })
      if (alreadyGone) {
        summary.skipped++
        continue
      }

      // decision/convention KEEP entries are deliberate human calls — same governance
      // reconcile.ts already applies to its own UPDATE/SUPERSEDE targets. Absorbing
      // evidence into a policy KEEP via a raw writeEntry would be an ungated mutation of
      // that policy (and could silently fold a CONTRADICTING session in as corroborating
      // evidence), so once the keep side is policy-typed, EVERY absorb in this merge — not
      // just ones that are themselves policy-typed — is forced through pending review
      // instead of being applied directly. Policy entries only change through
      // human-approved ops.
      const keepIsPolicy = keepItem.entry.type === "decision" || keepItem.entry.type === "convention"
      const policyAbsorbIds = op.absorb.filter((id) => {
        const t = cluster.members.find((m) => m.entry.id === id)!.entry
        return keepIsPolicy || t.type === "decision" || t.type === "convention"
      })
      const directAbsorbIds = op.absorb.filter((id) => !policyAbsorbIds.includes(id))

      // Idempotency: a policy-routed absorb stays "active" (nothing is applied until a
      // human approves the pending proposal), so alreadyGone above can't catch a rerun of
      // the SAME cluster — the cluster still reforms every run. This only fires for an
      // ALL-policy merge (every absorb id routed to pending review): a mixed merge always
      // has at least one direct absorb already tombstoned by the first run, which
      // alreadyGone above already caught. supersedes now points at the KEEP (not the
      // absorb ids — see the enriched-proposal construction below), so a pending proposal
      // "for this merge" is found by looking up keep.id, not any absorb id.
      if (policyAbsorbIds.length === op.absorb.length && findExistingPending(deps.storeDir, op.keep) !== null) {
        summary.skipped++
        deps.log(`reflect: cluster [${memberIds.join(",")}] merge already pending review — skipping`)
        continue
      }

      const dateStr = deps.now.toISOString().slice(0, 10)
      const directlyAbsorbed: MemoryEntry[] = []

      // Non-policy absorbs: unchanged direct-tombstone path.
      for (const absorbId of directAbsorbIds) {
        const target = cluster.members.find((m) => m.entry.id === absorbId)!.entry
        summary.merges++
        statusOverride.set(target.id, "superseded")
        directlyAbsorbed.push(target)
        if (deps.dryRun) deps.log(`[dry-run] merge: ${target.id} -> superseded by ${op.keep}`)
        else await applySupersession(target, keepItem.entry.id, op.reason, { storeDir: deps.storeDir, index: deps.index, now: deps.now })
      }

      if (directlyAbsorbed.length > 0) {
        if (deps.dryRun) {
          deps.log(`[dry-run] merge: keep ${op.keep} gains evidence from ${directlyAbsorbed.map((e) => e.id).join(",")}`)
        } else {
          const keepHit = deps.index.getById(op.keep)
          const currentKeep = keepHit ? keepHit.entry : keepItem.entry
          const merged = unionEvidenceRefs([currentKeep.evidence, ...directlyAbsorbed.map((e) => e.evidence)])
          // FIX 3: recompute confidence exactly like reconcile's applyUpdate — over the
          // distinct session count post-merge, carrying forward whatever human-approval
          // state the keep already has. Previously this was left stale at whatever
          // confidence the keep happened to have before absorption.
          const sessions = new Set(merged.map((e) => e.session)).size
          const updatedKeep: MemoryEntry = {
            ...currentKeep,
            evidence: merged,
            confidence: computeConfidence({ sessions, humanApproved: currentKeep.review === "human_approved", contradicted: false }),
            notes: [...currentKeep.notes, `${dateStr}: absorbed ${directlyAbsorbed.map((e) => e.id).join(", ")} — ${op.reason}`],
            updated_at: deps.now.toISOString(),
          }
          const path = await writeEntry(deps.storeDir, updatedKeep)
          deps.index.upsertEntry(updatedKeep, path)
        }
      }

      // Policy absorbs: ONE enriched-keep merge proposal covering every policy-routed
      // absorb id in this cluster — this is the convergent redesign (see module-level
      // note above applySupersession's import). The old design cloned KEEP with
      // supersedes pointing at the ABSORB id; approving it left keep untouched and
      // activated a near-duplicate clone alongside it, so the next reflect run
      // re-clustered {keep, clone} and proposed the same merge forever. Now the proposal
      // IS keep enriched with the absorbed evidence, supersedes points at KEEP itself, and
      // `absorbs` carries every id approveEntry must also tombstone — approval yields
      // exactly one active entry, not two.
      if (policyAbsorbIds.length > 0) {
        summary.mergesPending += policyAbsorbIds.length
        const why = keepIsPolicy ? `keep ${op.keep} is policy-type (${keepItem.entry.type})` : `absorbed member(s) are policy-type`
        if (deps.dryRun) {
          deps.log(`[dry-run] merge: ${policyAbsorbIds.join(",")} -> pending review (${why}), enriched replacement of ${op.keep}`)
        } else {
          // Re-read keep from the index so the proposal reflects any direct absorption
          // just applied above (a mixed merge enriches keep with non-policy evidence
          // first, then the policy proposal is built on top of that already-enriched
          // keep — no evidence is lost by processing direct absorbs first).
          const keepHit2 = deps.index.getById(op.keep)
          const baseKeep = keepHit2 ? keepHit2.entry : keepItem.entry
          const policyTargets = policyAbsorbIds.map((id) => cluster.members.find((m) => m.entry.id === id)!.entry)
          const mergedEvidence = unionEvidenceRefs([baseKeep.evidence, ...policyTargets.map((t) => t.evidence)])
          const sessions = new Set(mergedEvidence.map((e) => e.session)).size
          const pending: MemoryEntry = {
            ...baseKeep,
            evidence: mergedEvidence,
            confidence: computeConfidence({ sessions, humanApproved: false, contradicted: false }),
            status: "quarantined",
            review: "human_pending",
            supersedes: op.keep,
            absorbs: policyAbsorbIds,
            promoted_from: null,
            updated_at: deps.now.toISOString(),
            notes: [
              ...baseKeep.notes,
              `${dateStr}: merge proposal: enriched replacement of ${op.keep}; absorbs ${policyAbsorbIds.join(",")}`,
            ],
          }
          await writeQuarantineEntry(deps.storeDir, deps.index, pending)
        }
      }
    } catch (e) {
      summary.errors++
      deps.log(`reflect: cluster error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Promotion scan — re-read the store so it reflects any mutations just applied above (this
  // is identical to the pre-cluster snapshot in dry-run mode, since nothing was written).
  const finalAll = await readAllStoreEntries(deps.storeDir)
  const promotionCandidates = finalAll.filter(
    ({ entry }) => entry.status === "active" && entry.scope === "project" && (!project || entry.project === project),
  )

  for (const { entry } of promotionCandidates) {
    const distinctProjects = distinctEvidenceProjects(entry, sessionProject)
    const flagged = entry.notes.some((n) => n.includes("promotion candidate"))
    if (distinctProjects < 2 && !flagged) continue

    const alreadyPromoted = finalAll.some(({ entry: e }) => e.status !== "archived" && e.promoted_from === entry.id)
    if (alreadyPromoted) {
      summary.skipped++
      continue
    }

    if (deps.dryRun) {
      deps.log(`[dry-run] promotion: would queue global copy of ${entry.id} "${entry.title}"`)
      summary.promotions++
      continue
    }

    const nowIso = deps.now.toISOString()
    const dateStr = nowIso.slice(0, 10)
    const pending: MemoryEntry = {
      ...entry,
      id: entryId("global", entry.title, deps.now),
      project: "global",
      scope: "global",
      status: "quarantined",
      review: "human_pending",
      promoted_from: entry.id,
      supersedes: null,
      superseded_by: null,
      // entry may itself be the result of a prior approved policy merge and still carry
      // its absorbs list — a promoted CLONE inheriting that list would re-tombstone
      // already-superseded entries (pointing their superseded_by at this new promotion
      // copy) the moment the promotion is approved. Never inherited.
      absorbs: null,
      updated_at: nowIso,
      notes: [...entry.notes, `${dateStr}: pending promotion from ${entry.id} (project ${entry.project})`],
    }
    await writeQuarantineEntry(deps.storeDir, deps.index, pending)
    summary.promotions++
  }

  return summary
}
