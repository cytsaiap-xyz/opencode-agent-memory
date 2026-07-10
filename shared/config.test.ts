import { describe, expect, test } from "bun:test"
import { defaultDbPath, loadConfig, projectSlug } from "./config"

describe("loadConfig", () => {
  test("defaults home to ~/.agent-memory", () => {
    const cfg = loadConfig({})
    expect(cfg.home.endsWith("/.agent-memory")).toBe(true)
    expect(cfg.transcriptsDir).toBe(`${cfg.home}/transcripts`)
    expect(cfg.storeDir).toBe(`${cfg.home}/store`)
    expect(cfg.logFile).toBe(`${cfg.home}/collector.log`)
    expect(cfg.minUserTurns).toBe(2)
    expect(cfg.ignoredProjects).toEqual([])
  })
  test("AGENT_MEMORY_HOME overrides home", () => {
    expect(loadConfig({ AGENT_MEMORY_HOME: "/x/mem" }).home).toBe("/x/mem")
  })
  test("AGENT_MEMORY_IGNORE parses comma list, trims, drops empties", () => {
    expect(loadConfig({ AGENT_MEMORY_IGNORE: " foo, bar ,,baz " }).ignoredProjects).toEqual(["foo", "bar", "baz"])
  })
})

describe("projectSlug", () => {
  test("uses last path segment, lowercased", () => {
    expect(projectSlug("/Users/x/Documents/Claude_Project/opencode-dynflow")).toBe("opencode-dynflow")
    expect(projectSlug("/a/My_Proj")).toBe("my_proj")
  })
  test("tolerates trailing slash and strange chars", () => {
    expect(projectSlug("/a/b/晶片 flow v2/")).toBe("flow-v2")
    expect(projectSlug("///")).toBe("unknown")
    expect(projectSlug("")).toBe("unknown")
  })
})

describe("defaultDbPath", () => {
  test("honors XDG_DATA_HOME", () => {
    expect(defaultDbPath({ XDG_DATA_HOME: "/xdg" })).toBe("/xdg/opencode/opencode.db")
  })
  test("falls back to ~/.local/share", () => {
    expect(defaultDbPath({}).endsWith("/.local/share/opencode/opencode.db")).toBe(true)
  })
})
