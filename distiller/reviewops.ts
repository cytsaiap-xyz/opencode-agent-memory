import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join, sep } from "node:path"
import type { SearchHit } from "./ledger"
import type { MemoryQuery } from "./indexes"
import { computeConfidence, entryPath, serializeEntry, writeEntry } from "./store"
import type { MemoryEntry } from "./types"

export interface ApproveResult {
  entry: MemoryEntry
  movedTo: string | null
  supersededTarget: string | null
  warning?: string
}

function requirePending(index: MemoryQuery, id: string): SearchHit {
  const hit = index.getById(id)
  if (!hit) throw new Error(`memory ${id} not found`)
  if (hit.entry.review !== "human_pending" || hit.entry.status === "archived")
    throw new Error(`memory ${id} is not pending review`)
  return hit
}

export async function approveEntry(
  storeDir: string,
  index: MemoryQuery,
  id: string,
  now: Date = new Date(),
): Promise<ApproveResult> {
  const { entry: original, path: currentPath } = requirePending(index, id)
  const originalId = original.id
  const dateStr = now.toISOString().slice(0, 10)

  // Step 1: activate + approve + recompute confidence + note.
  let entry: MemoryEntry = {
    ...original,
    status: "active",
    review: "human_approved",
    confidence: computeConfidence({
      sessions: new Set(original.evidence.map((e) => e.session)).size,
      humanApproved: true,
      contradicted: false,
    }),
    notes: [...original.notes, `${dateStr}: approved by human`],
    updated_at: now.toISOString(),
  }

  // Step 3 (performed before step 2's tombstoning, so superseded_by records the final id):
  // move the file out of quarantine/ into memories/<project>/, uniquifying the id on collision.
  let movedTo: string | null = null
  const quarantineDir = join(storeDir, "quarantine")
  if (currentPath.startsWith(quarantineDir + sep)) {
    let dest = entryPath(storeDir, entry)
    const selfHit = index.getById(entry.id)
    const collision = existsSync(dest) || (selfHit !== null && selfHit.path !== currentPath)
    if (collision) {
      let suffix = 2
      let candidateId = `${entry.id}-${suffix}`
      let candidateDest = entryPath(storeDir, { ...entry, id: candidateId })
      while (existsSync(candidateDest) || index.getById(candidateId) !== null) {
        suffix++
        candidateId = `${entry.id}-${suffix}`
        candidateDest = entryPath(storeDir, { ...entry, id: candidateId })
      }
      entry = { ...entry, id: candidateId }
      dest = candidateDest
    }
    await writeEntry(storeDir, entry)
    await unlink(currentPath)
    if (entry.id !== originalId) index.removeEntry(originalId)
    index.upsertEntry(entry, dest)
    movedTo = dest
  } else {
    // Already living under memories/ — persist the field changes in place.
    await Bun.write(currentPath, serializeEntry(entry))
    index.upsertEntry(entry, currentPath)
  }

  // Step 2: tombstone the supersedes target (if any), now that entry.id is final.
  let supersededTarget: string | null = null
  let warning: string | undefined
  if (entry.supersedes) {
    const targetHit = index.getById(entry.supersedes)
    if (targetHit) {
      const target: MemoryEntry = {
        ...targetHit.entry,
        status: "superseded",
        superseded_by: entry.id,
        updated_at: now.toISOString(),
        notes: [...targetHit.entry.notes, `${dateStr}: superseded by ${entry.id} — approved by human`],
      }
      await Bun.write(targetHit.path, serializeEntry(target))
      index.upsertEntry(target, targetHit.path)
      supersededTarget = target.id
    } else {
      warning = `supersede target ${entry.supersedes} not found — approved without tombstoning`
    }
  }

  // Step 2b: tombstone every id in entry.absorbs (the enriched-merge-proposal absorb list —
  // see reflect.ts's policy-merge path), now that entry.id is final — same mechanics and
  // same best-effort-missing-target handling as the supersedes tombstoning just above. This
  // is what makes a policy-merge approval CONVERGE: the approved entry replaces keep
  // (supersedes) AND every absorbed id, so the active set ends up with exactly one entry
  // instead of a duplicate-content clone sitting alongside the original keep.
  if (entry.absorbs && entry.absorbs.length > 0) {
    for (const absorbId of entry.absorbs) {
      const absorbHit = index.getById(absorbId)
      if (absorbHit) {
        const absorbed: MemoryEntry = {
          ...absorbHit.entry,
          status: "superseded",
          superseded_by: entry.id,
          updated_at: now.toISOString(),
          notes: [...absorbHit.entry.notes, `${dateStr}: superseded by ${entry.id} — approved by human (absorbed by merge)`],
        }
        await Bun.write(absorbHit.path, serializeEntry(absorbed))
        index.upsertEntry(absorbed, absorbHit.path)
      } else {
        const w = `absorb target ${absorbId} not found — approved without tombstoning`
        warning = warning ? `${warning}; ${w}` : w
      }
    }
  }

  // Step 4: reciprocal note on the promotion source, if any — best-effort, exactly like the
  // supersedes-target-missing case above: a source that has drifted out of the index never
  // blocks the approval, it only downgrades to a warning.
  if (entry.promoted_from) {
    const sourceHit = index.getById(entry.promoted_from)
    if (sourceHit) {
      const source: MemoryEntry = {
        ...sourceHit.entry,
        updated_at: now.toISOString(),
        notes: [...sourceHit.entry.notes, `${dateStr}: promoted to ${entry.id}`],
      }
      await Bun.write(sourceHit.path, serializeEntry(source))
      index.upsertEntry(source, sourceHit.path)
    } else {
      const w = `promoted_from source ${entry.promoted_from} not found — approved without reciprocal note`
      warning = warning ? `${warning}; ${w}` : w
    }
  }

  return { entry, movedTo, supersededTarget, warning }
}

export async function rejectEntry(
  storeDir: string,
  index: MemoryQuery,
  id: string,
  reason?: string,
  now: Date = new Date(),
): Promise<MemoryEntry> {
  const { entry: original, path } = requirePending(index, id)
  const dateStr = now.toISOString().slice(0, 10)
  const entry: MemoryEntry = {
    ...original,
    status: "archived",
    notes: [...original.notes, `${dateStr}: rejected by human — ${reason ?? "not specified"}`],
    updated_at: now.toISOString(),
  }
  await Bun.write(path, serializeEntry(entry))
  index.upsertEntry(entry, path)
  return entry
}
