import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { defaultDbPath, loadConfig } from "../shared/config"
import { exportSession as realExportSession } from "./export"

export function createCollectorPlugin(deps: {
  exportSession?: typeof realExportSession
  env?: Record<string, string | undefined>
} = {}): Plugin {
  const doExport = deps.exportSession ?? realExportSession
  const env = deps.env ?? process.env

  return async () => {
    const cfg = loadConfig(env)
    const dbPath = defaultDbPath(env)

    const log = async (line: string) => {
      try {
        await mkdir(dirname(cfg.logFile), { recursive: true })
        await appendFile(cfg.logFile, `${new Date().toISOString()} ${line}\n`)
      } catch {
        // logging must never break the host
      }
    }

    return {
      event: async ({ event }) => {
        if (event.type !== "session.idle") return
        const sessionID = (event.properties as { sessionID?: string }).sessionID
        if (!sessionID) return
        try {
          const res = await doExport(cfg, dbPath, sessionID)
          await log(`${sessionID}: ${res.status}${res.reason ? ` (${res.reason})` : ""}`)
        } catch (e) {
          await log(`ERROR ${sessionID}: ${e instanceof Error ? e.message : String(e)}`)
        }
      },
    }
  }
}

export const AgentMemoryCollector: Plugin = createCollectorPlugin()
