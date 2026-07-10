import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("stdio entry answers initialize and tools/list over real stdio", async () => {
  const home = mkdtempSync(join(tmpdir(), "amem-main-"))
  const proc = Bun.spawn(["bun", "mcp-server/main.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, AGENT_MEMORY_HOME: home },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const send = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + "\n")
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  proc.stdin.flush()

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !buf.includes('"tools"')) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
    ])
    if (done && !value) break
    if (value) buf += decoder.decode(value)
  }
  proc.kill()
  expect(buf).toContain('"serverInfo"')
  expect(buf).toContain("agent-memory")
  expect(buf).toContain("search_memory")
}, 15_000)
