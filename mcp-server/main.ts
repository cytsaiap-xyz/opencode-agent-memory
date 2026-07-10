import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "../shared/config"
import { MemoryIndex } from "../distiller/ledger"
import { buildServer } from "./server"

if (import.meta.main) {
  const cfg = loadConfig()
  mkdirSync(cfg.storeDir, { recursive: true })
  const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
  const server = buildServer({ index, storeDir: cfg.storeDir })
  const shutdown = () => {
    index.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  await server.connect(new StdioServerTransport())
  console.error(`agent-memory mcp server ready (store: ${cfg.storeDir})`)
}
