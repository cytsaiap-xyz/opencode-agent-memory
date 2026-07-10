import { homedir } from "node:os"
import { join } from "node:path"

export interface MemoryConfig {
  home: string
  transcriptsDir: string
  storeDir: string
  logFile: string
  ignoredProjects: string[]
  minUserTurns: number
}

export function loadConfig(env: Record<string, string | undefined> = process.env): MemoryConfig {
  const home = env.AGENT_MEMORY_HOME ?? join(homedir(), ".agent-memory")
  return {
    home,
    transcriptsDir: join(home, "transcripts"),
    storeDir: join(home, "store"),
    logFile: join(home, "collector.log"),
    ignoredProjects: (env.AGENT_MEMORY_IGNORE ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    minUserTurns: 2,
  }
}

export function projectSlug(directory: string): string {
  const base = directory.replace(/\/+$/, "").split("/").pop() ?? ""
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "unknown"
}

export function defaultDbPath(env: Record<string, string | undefined> = process.env): string {
  const dataHome = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "opencode.db")
}
