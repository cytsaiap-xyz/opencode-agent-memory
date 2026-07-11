import { mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import type { MemoryQuery } from "./indexes"
import { quarantinePath, serializeEntry } from "./store"
import type { MemoryEntry } from "./types"

/**
 * Writes e under quarantine/ with id uniquified against BOTH the filesystem
 * and the index (-2/-3… suffix convention); upserts the index; returns the
 * final entry (id may differ from input).
 *
 * entryId is deterministic on project+title+day, so a same-project/title/day
 * candidate can otherwise carry the SAME id as an existing active row;
 * upsertEntry would then repoint that active row's path to the quarantine
 * file, making the active memory vanish from search. Matches addEntry's
 * uniquify convention in reconcile.ts.
 */
export async function writeQuarantineEntry(storeDir: string, index: MemoryQuery, e: MemoryEntry): Promise<MemoryEntry> {
  let qe = e
  let qPath = quarantinePath(storeDir, qe.id)
  if (existsSync(qPath) || index.getById(qe.id) !== null) {
    let suffix = 2
    while (
      existsSync(quarantinePath(storeDir, `${qe.id}-${suffix}`)) ||
      index.getById(`${qe.id}-${suffix}`) !== null
    ) {
      suffix++
    }
    qe = { ...qe, id: `${qe.id}-${suffix}` }
    qPath = quarantinePath(storeDir, qe.id)
  }
  await mkdir(dirname(qPath), { recursive: true })
  await Bun.write(qPath, serializeEntry(qe))
  index.upsertEntry(qe, qPath)
  return qe
}
