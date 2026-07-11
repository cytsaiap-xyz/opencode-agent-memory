import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { probeSqlite } from "./sqliteProbe"
import { mkdtempSync, chmodSync, readdirSync } from "fs"
import { existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("probeSqlite", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "probe-"))
  })

  afterEach(() => {
    try {
      // Restore permissions if they were changed
      chmodSync(testDir, 0o755)
    } catch {}
  })

  test("should probe successfully on writable directory and clean up probe files", async () => {
    const result = probeSqlite(testDir)

    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()

    // Verify probe files are cleaned up
    const probeFile = join(testDir, ".sqlite-probe.tmp")
    const walFile = join(testDir, ".sqlite-probe.tmp-wal")
    const shmFile = join(testDir, ".sqlite-probe.tmp-shm")

    expect(existsSync(probeFile)).toBe(false)
    expect(existsSync(walFile)).toBe(false)
    expect(existsSync(shmFile)).toBe(false)
  })

  test("should return not-ok with exact reason when AGENT_MEMORY_NO_SQLITE is set to '1'", () => {
    const result = probeSqlite(testDir, { AGENT_MEMORY_NO_SQLITE: "1" })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe("disabled by AGENT_MEMORY_NO_SQLITE")
  })

  test("should not create any files when AGENT_MEMORY_NO_SQLITE is set to '1'", () => {
    const filesBefore = readdirSync(testDir)
    probeSqlite(testDir, { AGENT_MEMORY_NO_SQLITE: "1" })
    const filesAfter = readdirSync(testDir)

    expect(filesBefore.length).toBe(filesAfter.length)
  })

  test("should return not-ok when directory is not writable", () => {
    // Remove write permission
    chmodSync(testDir, 0o444)

    const result = probeSqlite(testDir)

    expect(result.ok).toBe(false)
    expect(result.reason).toBeDefined()
    // Should contain an error message about permissions or inability to write
    expect(typeof result.reason).toBe("string")
    expect(result.reason!.length).toBeGreaterThan(0)
  })

  test("should create storeDir if it doesn't exist", () => {
    const nonExistentDir = join(testDir, "nested", "store", "dir")

    const result = probeSqlite(nonExistentDir)

    expect(result.ok).toBe(true)
    expect(existsSync(nonExistentDir)).toBe(true)
  })
})
