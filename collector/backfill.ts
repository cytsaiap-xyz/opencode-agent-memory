import type { MemoryConfig } from "../shared/config"
import { defaultDbPath, loadConfig } from "../shared/config"
import { listRootSessionIDs } from "./db"
import { exportSession } from "./export"

export interface BackfillSummary {
  written: number
  unchanged: number
  skipped: number
  errors: number
}

export async function runBackfill(
  cfg: MemoryConfig,
  dbPath: string,
  opts: { limit?: number } = {},
): Promise<BackfillSummary> {
  const summary: BackfillSummary = { written: 0, unchanged: 0, skipped: 0, errors: 0 }
  let ids = listRootSessionIDs(dbPath)
  if (opts.limit !== undefined) ids = ids.slice(0, opts.limit)
  for (const id of ids) {
    try {
      const res = await exportSession(cfg, dbPath, id)
      summary[res.status]++
    } catch (e) {
      summary.errors++
      console.error(`backfill: ${id} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return summary
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const dbPath = flag("--db") ?? defaultDbPath()
  const limitRaw = flag("--limit")
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    console.error("--limit must be a positive integer")
    process.exit(1)
  }
  const summary = await runBackfill(loadConfig(), dbPath, { limit })
  console.log(
    `backfill done: ${summary.written} written, ${summary.unchanged} unchanged, ` +
      `${summary.skipped} skipped, ${summary.errors} errors`,
  )
}
