import { mkdirSync, unlinkSync, existsSync } from "fs"
import { join } from "path"

export interface SqliteProbe {
  ok: boolean
  reason?: string
}

export function probeSqlite(storeDir: string, env?: Record<string, string | undefined>): SqliteProbe {
  // Check for NO_SQLITE override first (no filesystem activity)
  if (env?.AGENT_MEMORY_NO_SQLITE === "1") {
    return { ok: false, reason: "disabled by AGENT_MEMORY_NO_SQLITE" }
  }

  try {
    // Create the store directory if it doesn't exist
    mkdirSync(storeDir, { recursive: true })

    // Dynamic import of bun:sqlite inside try block
    const { Database } = require("bun:sqlite")
    const probeFilePath = join(storeDir, ".sqlite-probe.tmp")

    // Open database
    const db = new Database(probeFilePath)

    try {
      // Set WAL mode
      db.exec("PRAGMA journal_mode = WAL")

      // Create table, insert, select roundtrip
      db.exec("CREATE TABLE t(x TEXT)")
      db.run("INSERT INTO t VALUES (?)", "probe")
      const result = db.prepare("SELECT x FROM t").get()

      if (result?.x !== "probe") {
        return { ok: false, reason: "sqlite roundtrip verification failed" }
      }
    } finally {
      // Close database
      db.close()
    }

    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  } finally {
    // Best-effort cleanup of probe files
    const probeFilePath = join(storeDir, ".sqlite-probe.tmp")
    const walFile = `${probeFilePath}-wal`
    const shmFile = `${probeFilePath}-shm`

    for (const file of [probeFilePath, walFile, shmFile]) {
      try {
        if (existsSync(file)) {
          unlinkSync(file)
        }
      } catch {
        // Best-effort, ignore errors
      }
    }
  }
}
