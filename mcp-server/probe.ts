// Dev/verification probe: query the real store through the actual MCP server
// (in-memory transport). Usage: bun mcp-server/probe.ts <query> [--project p] | --stats
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { loadConfig } from "../shared/config"
import { MemoryIndex } from "../distiller/ledger"
import { buildServer } from "./server"

const args = process.argv.slice(2)
const cfg = loadConfig()
mkdirSync(cfg.storeDir, { recursive: true })
const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
if (index.ftsRebuildNeeded) {
  console.error(`agent-memory: fts schema upgraded — rebuilding index from ${cfg.storeDir}`)
  await index.rebuildFrom(cfg.storeDir)
}
const server = buildServer({ index, storeDir: cfg.storeDir })
const [ct, st] = InMemoryTransport.createLinkedPair()
await server.connect(st)
const client = new Client({ name: "probe", version: "0.0.1" })
await client.connect(ct)

let res: unknown
if (args[0] === "--stats") {
  res = await client.callTool({ name: "memory_stats", arguments: {} })
} else {
  const query = args[0]
  if (!query) {
    console.error("usage: bun mcp-server/probe.ts <query> [--project p] | --stats")
    process.exit(1)
  }
  const pi = args.indexOf("--project")
  const project = pi >= 0 ? args[pi + 1] : undefined
  res = await client.callTool({ name: "search_memory", arguments: { query, project } })
}
console.log((res as { content: Array<{ text: string }> }).content[0]?.text ?? "no content")
index.close()
process.exit(0)
