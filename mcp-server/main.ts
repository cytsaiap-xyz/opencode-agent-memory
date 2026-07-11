import { mkdirSync } from "node:fs"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "../shared/config"
import { probeSqlite } from "../shared/sqliteProbe"
import { openMemoryIndex } from "../distiller/indexes"
import { buildServer } from "./server"

if (import.meta.main) {
  const cfg = loadConfig()
  mkdirSync(cfg.storeDir, { recursive: true })
  // console.error writes to stderr — mcp paths must never write to stdout, since
  // stdout is the JSON-RPC transport.
  const probe = probeSqlite(cfg.storeDir, process.env)
  const index = openMemoryIndex(cfg.storeDir, probe, { warn: console.error })
  if (index.mode === "sqlite" && index.ftsRebuildNeeded) {
    console.error(`agent-memory: fts schema upgraded — rebuilding index from ${cfg.storeDir}`)
    await index.rebuildFrom(cfg.storeDir)
  }
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
