import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { MemoryIndex } from "../distiller/ledger"
import { getMemory, listDomains, memoryStats, searchMemory } from "./query"

const MEMORY_TYPES = ["decision", "root_cause", "pitfall", "know_how", "convention", "workflow"] as const

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] })
const fail = (message: string): ToolResult => ({ isError: true, content: [{ type: "text", text: message }] })

const guarded = <A>(fn: (args: A) => ToolResult) => async (args: A): Promise<ToolResult> => {
  try {
    return fn(args)
  } catch (e) {
    return fail(`tool failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function buildServer(deps: { index: MemoryIndex; storeDir: string }): McpServer {
  const server = new McpServer({ name: "agent-memory", version: "0.1.0" })

  server.registerTool(
    "search_memory",
    {
      description:
        "Search the team's distilled engineering memory — debugging root causes, pitfalls, " +
        "decisions, conventions, workflows and know-how extracted from past AI-agent sessions. " +
        "Returns lessons with confidence scores; use trigger/lesson text to judge relevance. " +
        "Call this before solving a problem that teammates may have hit before.",
      inputSchema: {
        query: z.string().min(1).describe("Full-text query (error messages, tool names, concepts)"),
        project: z.string().optional().describe("Restrict to one project slug"),
        type: z.enum(MEMORY_TYPES).optional(),
        domain: z.string().optional().describe("Restrict to a domain tag, e.g. 'sta'"),
        include_tentative: z.boolean().optional().describe("Include low-confidence (<0.5) memories"),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    guarded((args) => ok(searchMemory(deps.index, args))),
  )

  server.registerTool(
    "get_memory",
    {
      description: "Fetch one memory entry in full (lesson, evidence pointers, notes, provenance) by id.",
      inputSchema: { id: z.string().describe("Memory id, e.g. mem_20260710_a3f9c1") },
    },
    guarded(({ id }) => {
      const entry = getMemory(deps.index, id)
      return entry ? ok(entry) : fail(`memory not found: ${id}`)
    }),
  )

  server.registerTool(
    "list_domains",
    {
      description: "List active-memory counts by domain tag, type, and project — use to orient before searching.",
      inputSchema: { project: z.string().optional() },
    },
    guarded(({ project }) => ok(listDomains(deps.storeDir, project))),
  )

  server.registerTool(
    "memory_stats",
    {
      description: "Store totals: memories by status/type, sessions processed, last distill time, quarantine count.",
      inputSchema: {},
    },
    guarded(() => ok(memoryStats(deps.index, deps.storeDir))),
  )

  return server
}
