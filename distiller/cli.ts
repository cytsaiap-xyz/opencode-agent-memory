import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { loadConfig } from "../shared/config"
import { clientFromEnv, type LlmClient } from "./llm"
import { MemoryIndex } from "./ledger"
import { runPipeline } from "./pipeline"
import { approveEntry, rejectEntry } from "./reviewops"

export interface CliDeps { llm?: LlmClient; out?: (line: string) => void; err?: (line: string) => void }

const USAGE = "usage: distiller <run [--project <slug>] | reindex | review | approve <id> | reject <id> [--reason <text>] | stats>"

async function openIndex(cfg: { storeDir: string }, onError?: (msg: string) => void): Promise<MemoryIndex> {
  const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
  if (index.ftsRebuildNeeded) {
    const msg = `agent-memory: fts schema upgraded — rebuilding index from ${cfg.storeDir}`
    if (onError) onError(msg)
    else console.error(msg)
    await index.rebuildFrom(cfg.storeDir)
  }
  return index
}

const numEnv = (
  env: Record<string, string | undefined>, key: string, fallback: number,
  check: (n: number) => boolean,
): number => {
  const raw = env[key]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !check(n)) throw new Error(`${key} must be a valid number (got "${raw}")`)
  return n
}

export async function runCli(
  argv: string[], env: Record<string, string | undefined>, deps: CliDeps = {},
): Promise<number> {
  const out = deps.out ?? console.log
  const err = deps.err ?? console.error
  const [command, ...rest] = argv
  const cfg = loadConfig(env)
  try {
    switch (command) {
      case "run": {
        const idleHours = numEnv(env, "AGENT_MEMORY_IDLE_HOURS", 6, (n) => n >= 0)
        const salienceMin = numEnv(env, "AGENT_MEMORY_SALIENCE_MIN", 6, (n) => n >= 0 && n <= 10)
        const pi = rest.indexOf("--project")
        const project = pi >= 0 ? rest[pi + 1] : undefined
        if (pi >= 0 && !project) throw new Error("--project needs a value")
        const llm = deps.llm ?? clientFromEnv(env)
        mkdirSync(cfg.storeDir, { recursive: true })
        const index = await openIndex(cfg, err)
        try {
          const s = await runPipeline(cfg, { llm, index }, { project, idleHours, salienceMin })
          out(
            `distill done: ${s.ops.added} added, ${s.ops.updated} updated, ${s.ops.superseded} superseded, ` +
              `${s.ops.nooped} nooped, ${s.quarantined} quarantined, ${s.rejected} rejected, ${s.errors} errors ` +
              `(scanned ${s.scanned}, eligible ${s.eligible}, already-done ${s.skippedProcessed}, triaged ${s.triagedOut})`,
          )
          return s.errors > 0 ? 2 : 0
        } finally {
          index.close()
        }
      }
      case "reindex": {
        mkdirSync(cfg.storeDir, { recursive: true })
        const index = await openIndex(cfg, err)
        try {
          out(`reindexed ${await index.rebuildFrom(cfg.storeDir)} memories`)
          return 0
        } finally {
          index.close()
        }
      }
      case "review": {
        mkdirSync(cfg.storeDir, { recursive: true })
        const index = await openIndex(cfg, err)
        try {
          const { listEntryPaths, readEntry } = await import("./store")
          const { readdirSync } = await import("node:fs")
          const shown: Map<string, boolean> = new Map()

          // Scan memories directory for any pending entries a human moved there
          for (const p of listEntryPaths(cfg.storeDir)) {
            try {
              const e = await readEntry(p)
              if (e.review === "human_pending" && e.status !== "archived") {
                const note = e.notes.at(-1) ?? "no note"
                out(`${e.id} — ${e.title} (${note})`)
                shown.set(e.id, true)
              }
            } catch {
              err(`skipping corrupt entry: ${p}`)
            }
          }

          // Scan quarantine directory
          let quarantineNames: string[] = []
          try {
            quarantineNames = readdirSync(join(cfg.storeDir, "quarantine"))
          } catch {
            // no quarantine dir
          }
          for (const n of quarantineNames) {
            if (!n.endsWith(".md")) continue
            try {
              const e = await readEntry(join(cfg.storeDir, "quarantine", n))
              if (e.review === "human_pending" && e.status !== "archived" && !shown.has(e.id)) {
                const note = e.notes.at(-1) ?? "no note"
                out(`${e.id} — ${e.title} (${note})`)
                shown.set(e.id, true)
              }
            } catch {
              err(`skipping corrupt entry: quarantine/${n}`)
            }
          }

          if (shown.size === 0) out("quarantine empty")
          return 0
        } finally {
          index.close()
        }
      }
      case "approve": {
        const id = rest[0]
        if (!id) throw new Error("approve needs an <id> argument")
        mkdirSync(cfg.storeDir, { recursive: true })
        const index = await openIndex(cfg, err)
        try {
          const result = await approveEntry(cfg.storeDir, index, id)
          if (result.warning) err(`distiller: ${result.warning}`)
          const finalPath = index.getById(result.entry.id)?.path ?? result.movedTo ?? "(unknown path)"
          out(`approved ${result.entry.id} → ${finalPath}`)
          return 0
        } finally {
          index.close()
        }
      }
      case "reject": {
        const id = rest[0]
        if (!id) throw new Error("reject needs an <id> argument")
        const ri = rest.indexOf("--reason")
        const reason = ri >= 0 ? rest[ri + 1] : undefined
        if (ri >= 0 && !reason) throw new Error("--reason needs a value")
        mkdirSync(cfg.storeDir, { recursive: true })
        const index = await openIndex(cfg, err)
        try {
          const rejected = await rejectEntry(cfg.storeDir, index, id, reason)
          out(`rejected ${rejected.id}`)
          return 0
        } finally {
          index.close()
        }
      }
      case "stats": {
        mkdirSync(cfg.storeDir, { recursive: true })
        const index = await openIndex(cfg, err)
        try {
          const s = index.stats()
          out(`memories: ${JSON.stringify(s.byStatus)}; types: ${JSON.stringify(s.byType)}; sessions processed: ${s.sessions}`)
          return 0
        } finally {
          index.close()
        }
      }
      default:
        err(USAGE)
        return 1
    }
  } catch (e) {
    err(`distiller: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2), process.env))
}
