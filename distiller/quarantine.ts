import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { MemoryQuery } from "./indexes"
import { quarantinePath, serializeEntry, uniquifyEntryId } from "./store"
import type { MemoryEntry } from "./types"

/**
 * Writes e under quarantine/ with id uniquified against BOTH the filesystem
 * and the index (-2/-3… suffix convention, via uniquifyEntryId); upserts the
 * index; returns the final entry (id may differ from input).
 *
 * entryId is deterministic on project+title+day, so a same-project/title/day
 * candidate can otherwise carry the SAME id as an existing active row;
 * upsertEntry would then repoint that active row's path to the quarantine
 * file, making the active memory vanish from search. Matches addEntry's
 * uniquify convention in reconcile.ts (both now share uniquifyEntryId).
 */
export async function writeQuarantineEntry(storeDir: string, index: MemoryQuery, e: MemoryEntry): Promise<MemoryEntry> {
  const qe = uniquifyEntryId(e, (id) => quarantinePath(storeDir, id), (id) => index.getById(id))
  const qPath = quarantinePath(storeDir, qe.id)
  await mkdir(dirname(qPath), { recursive: true })
  await Bun.write(qPath, serializeEntry(qe))
  index.upsertEntry(qe, qPath)
  return qe
}
