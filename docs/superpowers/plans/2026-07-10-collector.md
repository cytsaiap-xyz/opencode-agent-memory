# Collector (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monorepo scaffold + the collector: an opencode plugin that, on `session.idle`, exports the session from opencode.db as a human-readable markdown transcript with evidence anchors; plus a backfill CLI for the existing session history and an installer.

**Architecture:** Pure functions (`db.ts` read → `transcript.ts` render → `export.ts` write) composed by a thin plugin shell (`plugin.ts`) and a CLI (`backfill.ts`). Zero runtime dependencies (`bun:sqlite`, `node:crypto` built-ins only). Spec: `docs/superpowers/specs/2026-07-10-agent-memory-design.md` §4-§5; validated end-to-end by Spike A (`docs/superpowers/SPIKE.md`).

**Tech Stack:** TypeScript + Bun, `bun:test`, `bun:sqlite` (read-only), `@opencode-ai/plugin` (types only, devDependency).

## Global Constraints

- **Zero runtime dependencies.** devDependencies allowed: `@opencode-ai/plugin@1.17.9`, `@types/bun` only.
- The plugin must NEVER throw into the host: every hook body try/catch; logging failures swallowed (dynflow lineage).
- The shipped bundle exports ONLY plugin functions (opencode loader contract — recurring pitfall #12); entry file is `collector/plugin-entry.ts`.
- Tests: per-test unique tmp dirs; **poll for async file effects, never fixed sleeps** (pitfall #10).
- opencode.db is always opened `{ readonly: true }`.
- `content_hash` is computed over the transcript BODY only (never over `exported_at`), so an unchanged session re-exports to an identical hash.
- Event type string is exactly `"session.idle"`; payload `event.properties.sessionID` (verified against SDK types 2026-07-10).
- Commits: conventional, English, scope per component, each ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01ALAk5sCENNGXZyy6mSg8tF`

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`
- Modify: `.gitignore` (already exists)

**Interfaces:**
- Produces: `bun test` and `bun run build` runnable from repo root; TS strict mode for all later tasks.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "agent-memory",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "bun build collector/plugin-entry.ts --outfile dist/agent-memory-collector.js --target bun --format esm",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "1.17.9",
    "@types/bun": "latest",
    "typescript": "^5.9.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["shared", "collector", "distiller", "mcp-server"]
}
```

`bunfig.toml`:
```toml
[install]
exact = true
```

- [ ] **Step 2: Install and verify**

Run: `bun install && bun run typecheck`
Expected: exit 0 (no source files yet — empty include is fine).

- [ ] **Step 3: Commit**

```bash
git add package.json tsconfig.json bunfig.toml bun.lock
git commit -m "chore: scaffold bun monorepo with strict typescript"
```

---

### Task 2: shared/config.ts — paths and project slugs

**Files:**
- Create: `shared/config.ts`
- Test: `shared/config.test.ts`

**Interfaces:**
- Produces:
  - `interface MemoryConfig { home: string; transcriptsDir: string; storeDir: string; logFile: string; ignoredProjects: string[]; minUserTurns: number }`
  - `loadConfig(env?: Record<string, string | undefined>): MemoryConfig`
  - `projectSlug(directory: string): string`
  - `defaultDbPath(env?: Record<string, string | undefined>): string`

- [ ] **Step 1: Write the failing tests**

`shared/config.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test shared/config.test.ts`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 3: Implement**

`shared/config.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test shared/config.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/config.ts shared/config.test.ts
git commit -m "feat(shared): config loading, project slugs, default db path"
```

---

### Task 3: collector/db.ts — read-only session loading

**Files:**
- Create: `collector/db.ts`, `collector/fixtures.ts`
- Test: `collector/db.test.ts`

**Interfaces:**
- Produces:
  - `interface SessionRow { id: string; parent_id: string | null; directory: string; title: string; time_created: number; time_updated: number; tokens_input: number; tokens_output: number; model: string | null }`
  - `interface MessageBundle { id: string; time_created: number; data: { role?: string; modelID?: string; providerID?: string } & Record<string, unknown> }`
  - `interface PartBundle { message_id: string; data: { type?: string; text?: string; tool?: string; state?: Record<string, unknown> } & Record<string, unknown> }`
  - `interface SessionBundle { session: SessionRow; messages: MessageBundle[]; parts: PartBundle[] }`
  - `loadSessionBundle(dbPath: string, sessionID: string): SessionBundle | null` (messages ordered by `time_created, id`; parts by `id`)
  - `listRootSessionIDs(dbPath: string): string[]` (`parent_id IS NULL`, ordered by `time_updated`)
- `collector/fixtures.ts` (test helper, never imported by production code): `makeFixtureDb(dir: string, sessions: FixtureSession[]): string` returning the db path.

- [ ] **Step 1: Write the fixture helper**

`collector/fixtures.ts`:
```ts
import { Database } from "bun:sqlite"
import { join } from "node:path"

export interface FixtureMessage {
  id: string
  role: "user" | "assistant"
  time: number
  parts: Array<Record<string, unknown>>
  modelID?: string
}

export interface FixtureSession {
  id: string
  directory?: string
  title?: string
  parentID?: string | null
  model?: string | null
  messages: FixtureMessage[]
}

/** Creates a minimal opencode.db matching the real production DDL (columns used by the collector). */
export function makeFixtureDb(dir: string, sessions: FixtureSession[]): string {
  const path = join(dir, "opencode.db")
  const db = new Database(path, { create: true })
  db.run(`CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
    directory text NOT NULL, title text NOT NULL, version text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL,
    model text, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL)`)
  db.run(`CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, data text NOT NULL)`)
  db.run(`CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`)

  let partSeq = 0
  for (const s of sessions) {
    const times = s.messages.map((m) => m.time)
    const t0 = Math.min(...(times.length ? times : [1000]))
    const t1 = Math.max(...(times.length ? times : [1000]))
    db.run(
      `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, model)
       VALUES (?, 'prj', ?, 'slug', ?, ?, '1.0.0', ?, ?, ?)`,
      [s.id, s.parentID ?? null, s.directory ?? "/tmp/proj", s.title ?? "fixture", t0, t1, s.model ?? null],
    )
    for (const m of s.messages) {
      const data: Record<string, unknown> = { role: m.role, time: { created: m.time } }
      if (m.modelID) data.modelID = m.modelID
      db.run(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`, [
        m.id, s.id, m.time, m.time, JSON.stringify(data),
      ])
      for (const p of m.parts) {
        partSeq++
        db.run(
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
          [`prt_${String(partSeq).padStart(6, "0")}`, m.id, s.id, m.time, m.time, JSON.stringify(p)],
        )
      }
    }
  }
  db.close()
  return path
}
```

- [ ] **Step 2: Write the failing tests**

`collector/db.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSessionBundle, listRootSessionIDs } from "./db"
import { makeFixtureDb } from "./fixtures"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-db-"))

test("loadSessionBundle returns typed session, ordered messages, parsed parts", () => {
  const db = makeFixtureDb(tmp(), [
    {
      id: "ses_a",
      directory: "/x/projA",
      title: "hello",
      messages: [
        { id: "msg_2", role: "assistant", time: 2000, parts: [{ type: "text", text: "hi back" }], modelID: "m1" },
        { id: "msg_1", role: "user", time: 1000, parts: [{ type: "text", text: "hi" }] },
      ],
    },
  ])
  const b = loadSessionBundle(db, "ses_a")
  expect(b).not.toBeNull()
  expect(b!.session.title).toBe("hello")
  expect(b!.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]) // time-ordered
  expect(b!.messages[0]!.data.role).toBe("user")
  expect(b!.parts.filter((p) => p.message_id === "msg_1")[0]!.data.text).toBe("hi")
})

test("loadSessionBundle returns null for unknown session", () => {
  const db = makeFixtureDb(tmp(), [])
  expect(loadSessionBundle(db, "ses_missing")).toBeNull()
})

test("loadSessionBundle tolerates corrupt part JSON (skips the part)", () => {
  const dir = tmp()
  const db = makeFixtureDb(dir, [
    { id: "ses_a", messages: [{ id: "msg_1", role: "user", time: 1, parts: [{ type: "text", text: "ok" }] }] },
  ])
  const { Database } = require("bun:sqlite")
  const raw = new Database(db)
  raw.run(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES ('prt_bad', 'msg_1', 'ses_a', 1, 1, '{not json')`)
  raw.close()
  const b = loadSessionBundle(db, "ses_a")
  expect(b!.parts.length).toBe(1) // corrupt part dropped, valid part kept
})

test("listRootSessionIDs excludes child sessions", () => {
  const db = makeFixtureDb(tmp(), [
    { id: "ses_root", messages: [{ id: "m1", role: "user", time: 1, parts: [] }] },
    { id: "ses_child", parentID: "ses_root", messages: [{ id: "m2", role: "user", time: 2, parts: [] }] },
  ])
  expect(listRootSessionIDs(db)).toEqual(["ses_root"])
})

test("opens the database read-only", () => {
  const db = makeFixtureDb(tmp(), [])
  // loadSessionBundle must not create tables/rows; verify by opening a fresh nonexistent path
  expect(() => loadSessionBundle(join(tmp(), "nope.db"), "x")).toThrow()
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test collector/db.test.ts`
Expected: FAIL — cannot resolve `./db`.

- [ ] **Step 4: Implement**

`collector/db.ts`:
```ts
import { Database } from "bun:sqlite"

export interface SessionRow {
  id: string
  parent_id: string | null
  directory: string
  title: string
  time_created: number
  time_updated: number
  tokens_input: number
  tokens_output: number
  model: string | null
}

export interface MessageBundle {
  id: string
  time_created: number
  data: { role?: string; modelID?: string; providerID?: string } & Record<string, unknown>
}

export interface PartBundle {
  message_id: string
  data: { type?: string; text?: string; tool?: string; state?: Record<string, unknown> } & Record<string, unknown>
}

export interface SessionBundle {
  session: SessionRow
  messages: MessageBundle[]
  parts: PartBundle[]
}

const parseJson = (raw: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(raw)
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function loadSessionBundle(dbPath: string, sessionID: string): SessionBundle | null {
  const db = new Database(dbPath, { readonly: true })
  try {
    const session = db
      .query(
        `SELECT id, parent_id, directory, title, time_created, time_updated,
                tokens_input, tokens_output, model
         FROM session WHERE id = ?`,
      )
      .get(sessionID) as SessionRow | null
    if (!session) return null

    const messages: MessageBundle[] = []
    for (const row of db
      .query(`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id`)
      .all(sessionID) as Array<{ id: string; time_created: number; data: string }>) {
      const data = parseJson(row.data)
      if (data) messages.push({ id: row.id, time_created: row.time_created, data })
    }

    const parts: PartBundle[] = []
    for (const row of db
      .query(`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id`)
      .all(sessionID) as Array<{ message_id: string; data: string }>) {
      const data = parseJson(row.data)
      if (data) parts.push({ message_id: row.message_id, data })
    }

    return { session, messages, parts }
  } finally {
    db.close()
  }
}

export function listRootSessionIDs(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.query(`SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated`).all() as Array<{ id: string }>)
      .map((r) => r.id)
  } finally {
    db.close()
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test collector/db.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add collector/db.ts collector/fixtures.ts collector/db.test.ts
git commit -m "feat(collector): read-only session loading from opencode.db"
```

---

### Task 4: collector/transcript.ts — markdown rendering with stable content hash

**Files:**
- Create: `collector/transcript.ts`
- Test: `collector/transcript.test.ts`

**Interfaces:**
- Consumes: `SessionBundle` from Task 3.
- Produces:
  - `interface TranscriptResult { markdown: string; turns: number; userTurns: number; contentHash: string }`
  - `renderTranscript(bundle: SessionBundle, exportedAt: Date): TranscriptResult`
- Format contract (Spike A): YAML frontmatter incl. `content_hash: sha256:<16 hex>`; turn headings `## T<n> [HH:MM] User|Assistant {#<message_id>}`; tool parts as `> 🔧 <tool> <input ≤160 chars> → <status>`; `reasoning`/`step-start`/`step-finish` dropped; messages with no renderable body skipped entirely.
- `contentHash` = sha256 over the BODY (turn sections only) — same session content ⇒ same hash regardless of `exportedAt`.

- [ ] **Step 1: Write the failing tests**

`collector/transcript.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { renderTranscript } from "./transcript"
import type { SessionBundle } from "./db"

const bundle = (overrides?: Partial<SessionBundle>): SessionBundle => ({
  session: {
    id: "ses_a", parent_id: null, directory: "/x/projA", title: "T \"quoted\"",
    time_created: 1000, time_updated: 5000, tokens_input: 10, tokens_output: 5,
    model: JSON.stringify({ id: "big-pickle", providerID: "opencode" }),
  },
  messages: [
    { id: "msg_u1", time_created: 1000, data: { role: "user" } },
    { id: "msg_a1", time_created: 2000, data: { role: "assistant", modelID: "m2" } },
    { id: "msg_empty", time_created: 3000, data: { role: "assistant" } },
  ],
  parts: [
    { message_id: "msg_u1", data: { type: "text", text: "  hello  " } },
    { message_id: "msg_a1", data: { type: "reasoning", text: "secret thoughts" } },
    { message_id: "msg_a1", data: { type: "step-start" } },
    { message_id: "msg_a1", data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "x".repeat(300) } } } },
    { message_id: "msg_a1", data: { type: "text", text: "done" } },
  ],
  ...overrides,
})

test("renders frontmatter, turns, anchors; drops noise part types and empty messages", () => {
  const r = renderTranscript(bundle(), new Date("2026-07-10T03:00:00Z"))
  expect(r.turns).toBe(2)
  expect(r.userTurns).toBe(1)
  expect(r.markdown).toContain("session_id: ses_a")
  expect(r.markdown).toContain('title: "T \\"quoted\\""')
  expect(r.markdown).toContain("model: opencode/big-pickle")
  expect(r.markdown).toContain("## T1 [00:00] User {#msg_u1}")
  expect(r.markdown).toContain("hello") // trimmed
  expect(r.markdown).toContain("## T2 [00:00] Assistant {#msg_a1}")
  expect(r.markdown).not.toContain("secret thoughts") // reasoning dropped
  expect(r.markdown).not.toContain("msg_empty") // empty message skipped
  expect(r.markdown).toContain("> 🔧 bash")
  expect(r.markdown).toContain("→ completed")
})

test("tool input is truncated to 160 chars with ellipsis", () => {
  const r = renderTranscript(bundle(), new Date())
  const line = r.markdown.split("\n").find((l) => l.startsWith("> 🔧 bash"))!
  expect(line).toContain("…")
  expect(line.length).toBeLessThan(200)
})

test("contentHash is stable across exportedAt and present in frontmatter", () => {
  const a = renderTranscript(bundle(), new Date("2026-01-01T00:00:00Z"))
  const b = renderTranscript(bundle(), new Date("2026-06-30T12:34:56Z"))
  expect(a.contentHash).toBe(b.contentHash)
  expect(a.contentHash).toMatch(/^sha256:[0-9a-f]{16}$/)
  expect(a.markdown).toContain(`content_hash: ${a.contentHash}`)
  expect(a.markdown).toContain("exported_at: 2026-01-01T00:00:00.000Z")
})

test("contentHash changes when body changes", () => {
  const a = renderTranscript(bundle(), new Date())
  const changed = bundle()
  changed.parts[0]!.data.text = "different"
  const b = renderTranscript(changed, new Date())
  expect(a.contentHash).not.toBe(b.contentHash)
})

test("model falls back to last message modelID when session.model is absent", () => {
  const noModel = bundle()
  noModel.session.model = null
  const r = renderTranscript(noModel, new Date())
  expect(r.markdown).toContain("model: m2")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test collector/transcript.test.ts`
Expected: FAIL — cannot resolve `./transcript`.

- [ ] **Step 3: Implement**

`collector/transcript.ts`:
```ts
import { createHash } from "node:crypto"
import type { PartBundle, SessionBundle } from "./db"

export interface TranscriptResult {
  markdown: string
  turns: number
  userTurns: number
  contentHash: string
}

const DROPPED_TYPES = new Set(["reasoning", "step-start", "step-finish", "snapshot", "patch"])

const iso = (ms: number) => new Date(ms).toISOString()
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

function toolSummary(part: PartBundle["data"]): string {
  const tool = String(part.tool ?? "unknown")
  const state = (part.state ?? {}) as Record<string, unknown>
  const status = String(state.status ?? "?")
  let input = ""
  if (state.input !== undefined) {
    try {
      input = JSON.stringify(state.input)
    } catch {
      input = "[unserializable]"
    }
  }
  if (input.length > 160) input = input.slice(0, 160) + "…"
  return `> 🔧 ${tool} ${input} → ${status}`
}

function sessionModel(bundle: SessionBundle): string {
  if (bundle.session.model) {
    try {
      const m = JSON.parse(bundle.session.model) as { id?: string; providerID?: string }
      if (m.id) return m.providerID ? `${m.providerID}/${m.id}` : m.id
    } catch {
      // fall through to message scan
    }
  }
  for (let i = bundle.messages.length - 1; i >= 0; i--) {
    const id = bundle.messages[i]?.data.modelID
    if (typeof id === "string" && id) return id
  }
  return "unknown"
}

export function renderTranscript(bundle: SessionBundle, exportedAt: Date): TranscriptResult {
  const partsByMessage = new Map<string, PartBundle[]>()
  for (const p of bundle.parts) {
    const list = partsByMessage.get(p.message_id) ?? []
    list.push(p)
    partsByMessage.set(p.message_id, list)
  }

  const lines: string[] = []
  let turns = 0
  let userTurns = 0
  for (const m of bundle.messages) {
    const role = String(m.data.role ?? "")
    const body: string[] = []
    for (const p of partsByMessage.get(m.id) ?? []) {
      const type = String(p.data.type ?? "")
      if (DROPPED_TYPES.has(type)) continue
      if (type === "text" && typeof p.data.text === "string" && p.data.text.trim()) {
        body.push(p.data.text.trim())
      } else if (type === "tool") {
        body.push(toolSummary(p.data))
      }
    }
    if (body.length === 0) continue
    turns++
    if (role === "user") userTurns++
    const who = role === "user" ? "User" : "Assistant"
    lines.push(`## T${turns} [${hhmm(m.time_created)}] ${who} {#${m.id}}`, "", body.join("\n\n"), "")
  }

  const bodyText = lines.join("\n")
  const contentHash = "sha256:" + createHash("sha256").update(bodyText).digest("hex").slice(0, 16)

  const header = [
    "---",
    `session_id: ${bundle.session.id}`,
    `project_dir: ${bundle.session.directory}`,
    `title: ${JSON.stringify(bundle.session.title)}`,
    `model: ${sessionModel(bundle)}`,
    `time_start: ${iso(bundle.session.time_created)}`,
    `time_end: ${iso(bundle.session.time_updated)}`,
    `turns: ${turns}`,
    `tokens: { input: ${bundle.session.tokens_input}, output: ${bundle.session.tokens_output} }`,
    `content_hash: ${contentHash}`,
    `exported_at: ${exportedAt.toISOString()}`,
    "---",
    "",
  ].join("\n")

  return { markdown: header + bodyText, turns, userTurns, contentHash }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test collector/transcript.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add collector/transcript.ts collector/transcript.test.ts
git commit -m "feat(collector): markdown transcript rendering with stable content hash"
```

---

### Task 5: collector/export.ts — skip rules, unchanged detection, atomic write

**Files:**
- Create: `collector/export.ts`
- Test: `collector/export.test.ts`

**Interfaces:**
- Consumes: `loadSessionBundle` (Task 3), `renderTranscript` (Task 4), `MemoryConfig`/`projectSlug` (Task 2).
- Produces:
  - `type ExportOutcome = { status: "written" | "unchanged" | "skipped"; reason?: string; path?: string }`
  - `exportSession(cfg: MemoryConfig, dbPath: string, sessionID: string, now?: Date): Promise<ExportOutcome>`
- Skip reasons (exact strings): `"not found"`, `"child session"`, `"ignored project"`, `"too few user turns"`.
- Destination: `<transcriptsDir>/<projectSlug(directory)>/<session_id>.md`; parent dirs created; full overwrite.
- Unchanged: existing file whose frontmatter `content_hash:` line equals the new hash ⇒ no write.
- Ignored project match: `cfg.ignoredProjects` entry equals the project slug OR is a substring of `session.directory`.

- [ ] **Step 1: Write the failing tests**

`collector/export.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../shared/config"
import { exportSession } from "./export"
import { makeFixtureDb, type FixtureSession } from "./fixtures"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-exp-"))

const richSession = (id: string, dir = "/x/projA"): FixtureSession => ({
  id,
  directory: dir,
  messages: [
    { id: `${id}_u1`, role: "user", time: 1000, parts: [{ type: "text", text: "q1" }] },
    { id: `${id}_a1`, role: "assistant", time: 2000, parts: [{ type: "text", text: "a1" }] },
    { id: `${id}_u2`, role: "user", time: 3000, parts: [{ type: "text", text: "q2" }] },
  ],
})

const setup = (sessions: FixtureSession[]) => {
  const dir = tmp()
  const dbPath = makeFixtureDb(dir, sessions)
  const cfg = loadConfig({ AGENT_MEMORY_HOME: join(dir, "mem") })
  return { dbPath, cfg }
}

test("writes transcript to <transcripts>/<slug>/<id>.md", async () => {
  const { dbPath, cfg } = setup([richSession("ses_a")])
  const r = await exportSession(cfg, dbPath, "ses_a", new Date(0))
  expect(r.status).toBe("written")
  expect(r.path).toBe(join(cfg.transcriptsDir, "proja", "ses_a.md"))
  expect(readFileSync(r.path!, "utf8")).toContain("## T1")
})

test("second export of unchanged session is 'unchanged' and does not rewrite", async () => {
  const { dbPath, cfg } = setup([richSession("ses_a")])
  const first = await exportSession(cfg, dbPath, "ses_a", new Date(0))
  const mtime1 = statSync(first.path!).mtimeMs
  const second = await exportSession(cfg, dbPath, "ses_a", new Date(999999))
  expect(second.status).toBe("unchanged")
  expect(statSync(first.path!).mtimeMs).toBe(mtime1)
})

test("skips: unknown id, child session, ignored project, too few user turns", async () => {
  const child: FixtureSession = { ...richSession("ses_c"), parentID: "ses_a" }
  const thin: FixtureSession = {
    id: "ses_t", directory: "/x/projA",
    messages: [{ id: "t_u1", role: "user", time: 1, parts: [{ type: "text", text: "hi" }] }],
  }
  const ignored = richSession("ses_i", "/x/secret-proj")
  const { dbPath, cfg } = setup([richSession("ses_a"), child, thin, ignored])
  const cfgIgnore = { ...cfg, ignoredProjects: ["secret-proj"] }

  expect((await exportSession(cfg, dbPath, "ses_missing")).reason).toBe("not found")
  expect((await exportSession(cfg, dbPath, "ses_c")).reason).toBe("child session")
  expect((await exportSession(cfg, dbPath, "ses_t")).reason).toBe("too few user turns")
  expect((await exportSession(cfgIgnore, dbPath, "ses_i")).reason).toBe("ignored project")
})

test("re-export after session grows overwrites with new hash", async () => {
  const dir = tmp()
  const grown = richSession("ses_g")
  const dbPath = makeFixtureDb(dir, [grown])
  const cfg = loadConfig({ AGENT_MEMORY_HOME: join(dir, "mem") })
  const first = await exportSession(cfg, dbPath, "ses_g", new Date(0))
  const { Database } = require("bun:sqlite")
  const raw = new Database(dbPath)
  raw.run(`INSERT INTO message (id, session_id, time_created, time_updated, data)
           VALUES ('ses_g_a2', 'ses_g', 4000, 4000, '{"role":"assistant"}')`)
  raw.run(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES ('prt_new', 'ses_g_a2', 'ses_g', 4000, 4000, '{"type":"text","text":"more"}')`)
  raw.close()
  const second = await exportSession(cfg, dbPath, "ses_g", new Date(0))
  expect(second.status).toBe("written")
  expect(readFileSync(first.path!, "utf8")).toContain("more")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test collector/export.test.ts`
Expected: FAIL — cannot resolve `./export`.

- [ ] **Step 3: Implement**

`collector/export.ts`:
```ts
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { MemoryConfig } from "../shared/config"
import { projectSlug } from "../shared/config"
import { loadSessionBundle } from "./db"
import { renderTranscript } from "./transcript"

export type ExportOutcome = { status: "written" | "unchanged" | "skipped"; reason?: string; path?: string }

export async function exportSession(
  cfg: MemoryConfig,
  dbPath: string,
  sessionID: string,
  now: Date = new Date(),
): Promise<ExportOutcome> {
  const bundle = loadSessionBundle(dbPath, sessionID)
  if (!bundle) return { status: "skipped", reason: "not found" }
  if (bundle.session.parent_id) return { status: "skipped", reason: "child session" }

  const slug = projectSlug(bundle.session.directory)
  const ignored = cfg.ignoredProjects.some((p) => p === slug || bundle.session.directory.includes(p))
  if (ignored) return { status: "skipped", reason: "ignored project" }

  const rendered = renderTranscript(bundle, now)
  if (rendered.userTurns < cfg.minUserTurns) return { status: "skipped", reason: "too few user turns" }

  const path = join(cfg.transcriptsDir, slug, `${bundle.session.id}.md`)
  const existing = Bun.file(path)
  if (await existing.exists()) {
    const head = (await existing.text()).slice(0, 600)
    if (head.includes(`content_hash: ${rendered.contentHash}`)) return { status: "unchanged", path }
  }

  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, rendered.markdown)
  return { status: "written", path }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test collector/export.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add collector/export.ts collector/export.test.ts
git commit -m "feat(collector): session export with skip rules and unchanged detection"
```

---

### Task 6: collector/plugin.ts + plugin-entry.ts — the opencode plugin shell

**Files:**
- Create: `collector/plugin.ts`, `collector/plugin-entry.ts`
- Test: `collector/plugin.test.ts`

**Interfaces:**
- Consumes: `exportSession` (Task 5), `loadConfig`/`defaultDbPath` (Task 2).
- Produces:
  - `createCollectorPlugin(deps?: { exportSession?: typeof exportSession; env?: Record<string, string | undefined> })` — testable factory.
  - `AgentMemoryCollector: Plugin` — the real plugin (factory with defaults).
  - `collector/plugin-entry.ts` — bundle entry exporting ONLY `AgentMemoryCollector` (named + default). Loader contract (pitfall #12).
- Behavior: reacts only to `event.type === "session.idle"`; extracts `event.properties.sessionID`; appends one log line per event to `cfg.logFile` (`<iso> <sessionID>: <status>[ (<reason>)]` or `<iso> ERROR <detail>`); NEVER throws (outer try/catch; log-append failures swallowed).

- [ ] **Step 1: Write the failing tests**

`collector/plugin.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as entry from "./plugin-entry"
import { createCollectorPlugin } from "./plugin"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-plg-"))

const pollFile = async (path: string, timeoutMs = 2000): Promise<string> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const f = Bun.file(path)
    if (await f.exists()) {
      const text = await f.text()
      if (text.length > 0) return text
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timeout waiting for ${path}`)
}

const ctx = { client: {}, directory: "/tmp", worktree: "/tmp" } as never

test("bundle entry exports only plugin functions (loader contract)", () => {
  const values = Object.values(entry)
  expect(values.length).toBeGreaterThan(0)
  for (const v of values) expect(typeof v).toBe("function")
})

test("session.idle triggers export and logs the outcome", async () => {
  const home = join(tmp(), "mem")
  const calls: string[] = []
  const plugin = createCollectorPlugin({
    env: { AGENT_MEMORY_HOME: home },
    exportSession: async (_cfg, _db, id) => {
      calls.push(id)
      return { status: "written", path: "/x" }
    },
  })
  const hooks = await plugin(ctx)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_x" } } as never })
  expect(calls).toEqual(["ses_x"])
  const log = await pollFile(join(home, "collector.log"))
  expect(log).toContain("ses_x: written")
})

test("non-idle events are ignored", async () => {
  const calls: string[] = []
  const plugin = createCollectorPlugin({
    env: { AGENT_MEMORY_HOME: join(tmp(), "mem") },
    exportSession: async () => {
      calls.push("no")
      return { status: "written" }
    },
  })
  const hooks = await plugin(ctx)
  await hooks.event!({ event: { type: "session.updated", properties: {} } as never })
  expect(calls).toEqual([])
})

test("exporter failure is swallowed and logged, never thrown", async () => {
  const home = join(tmp(), "mem")
  const plugin = createCollectorPlugin({
    env: { AGENT_MEMORY_HOME: home },
    exportSession: async () => {
      throw new Error("db exploded")
    },
  })
  const hooks = await plugin(ctx)
  await expect(
    hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_x" } } as never }),
  ).resolves.toBeUndefined()
  const log = await pollFile(join(home, "collector.log"))
  expect(log).toContain("ERROR")
  expect(log).toContain("db exploded")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test collector/plugin.test.ts`
Expected: FAIL — cannot resolve `./plugin` / `./plugin-entry`.

- [ ] **Step 3: Implement**

`collector/plugin.ts`:
```ts
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
```

`collector/plugin-entry.ts`:
```ts
// Bundle entry. The opencode loader iterates Object.values(module) and rejects
// the whole module if any export is not a function (recurring pitfall #12).
// Export ONLY the plugin.
import { AgentMemoryCollector } from "./plugin"
export { AgentMemoryCollector }
export default AgentMemoryCollector
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test collector/plugin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify the built bundle also honors the loader contract**

Run: `bun run build && bun -e 'const m = await import("./dist/agent-memory-collector.js"); for (const [k,v] of Object.entries(m)) { if (typeof v !== "function") { console.error("non-function export:", k); process.exit(1) } } console.log("bundle exports OK:", Object.keys(m).join(", "))'`
Expected: `bundle exports OK: AgentMemoryCollector, default`

- [ ] **Step 6: Commit**

```bash
git add collector/plugin.ts collector/plugin-entry.ts collector/plugin.test.ts
git commit -m "feat(collector): session.idle plugin shell with never-throw guarantee"
```

---

### Task 7: collector/backfill.ts — historical export CLI

**Files:**
- Create: `collector/backfill.ts`
- Test: `collector/backfill.test.ts`

**Interfaces:**
- Consumes: `listRootSessionIDs` (Task 3), `exportSession` (Task 5), `loadConfig`/`defaultDbPath` (Task 2).
- Produces:
  - `runBackfill(cfg: MemoryConfig, dbPath: string, opts?: { limit?: number }): Promise<{ written: number; unchanged: number; skipped: number; errors: number }>`
  - CLI entrypoint (same file, `import.meta.main` guard): `bun collector/backfill.ts [--db <path>] [--limit <n>]` printing the summary and exiting 0.
- Per-session errors are counted and logged to stderr, never abort the run.

- [ ] **Step 1: Write the failing tests**

`collector/backfill.test.ts`:
```ts
import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../shared/config"
import { runBackfill } from "./backfill"
import { makeFixtureDb, type FixtureSession } from "./fixtures"

const rich = (id: string): FixtureSession => ({
  id,
  directory: "/x/projA",
  messages: [
    { id: `${id}_u1`, role: "user", time: 1000, parts: [{ type: "text", text: "q" }] },
    { id: `${id}_a1`, role: "assistant", time: 2000, parts: [{ type: "text", text: "a" }] },
    { id: `${id}_u2`, role: "user", time: 3000, parts: [{ type: "text", text: "q2" }] },
  ],
})

test("backfills all root sessions, skipping thin/child ones; rerun is all-unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-bf-"))
  const thin: FixtureSession = {
    id: "ses_thin", directory: "/x/projA",
    messages: [{ id: "th_u1", role: "user", time: 1, parts: [{ type: "text", text: "hi" }] }],
  }
  const child: FixtureSession = { ...rich("ses_child"), parentID: "ses_a" }
  const dbPath = makeFixtureDb(dir, [rich("ses_a"), rich("ses_b"), thin, child])
  const cfg = loadConfig({ AGENT_MEMORY_HOME: join(dir, "mem") })

  const r1 = await runBackfill(cfg, dbPath)
  expect(r1).toEqual({ written: 2, unchanged: 0, skipped: 1, errors: 0 })
  expect(readdirSync(join(cfg.transcriptsDir, "proja")).sort()).toEqual(["ses_a.md", "ses_b.md"])

  const r2 = await runBackfill(cfg, dbPath)
  expect(r2).toEqual({ written: 0, unchanged: 2, skipped: 1, errors: 0 })
})

test("limit caps processed sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-bf-"))
  const dbPath = makeFixtureDb(dir, [rich("ses_a"), rich("ses_b"), rich("ses_c")])
  const cfg = loadConfig({ AGENT_MEMORY_HOME: join(dir, "mem") })
  const r = await runBackfill(cfg, dbPath, { limit: 1 })
  expect(r.written).toBe(1)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test collector/backfill.test.ts`
Expected: FAIL — cannot resolve `./backfill`.

- [ ] **Step 3: Implement**

`collector/backfill.ts`:
```ts
import type { MemoryConfig } from "../shared/config"
import { defaultDbPath, loadConfig } from "../shared/config"
import { listRootSessionIDs } from "./db"
import { exportSession } from "./export"

export interface BackfillSummary {
  written: number
  unchanged: number
  skipped: number
  errors: number
}

export async function runBackfill(
  cfg: MemoryConfig,
  dbPath: string,
  opts: { limit?: number } = {},
): Promise<BackfillSummary> {
  const summary: BackfillSummary = { written: 0, unchanged: 0, skipped: 0, errors: 0 }
  let ids = listRootSessionIDs(dbPath)
  if (opts.limit !== undefined) ids = ids.slice(0, opts.limit)
  for (const id of ids) {
    try {
      const res = await exportSession(cfg, dbPath, id)
      summary[res.status]++
    } catch (e) {
      summary.errors++
      console.error(`backfill: ${id} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return summary
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const dbPath = flag("--db") ?? defaultDbPath()
  const limitRaw = flag("--limit")
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    console.error("--limit must be a positive integer")
    process.exit(1)
  }
  const summary = await runBackfill(loadConfig(), dbPath, { limit })
  console.log(
    `backfill done: ${summary.written} written, ${summary.unchanged} unchanged, ` +
      `${summary.skipped} skipped, ${summary.errors} errors`,
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test collector/backfill.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add collector/backfill.ts collector/backfill.test.ts
git commit -m "feat(collector): backfill CLI for historical sessions"
```

---

### Task 8: installer + README + LLM_WIKI

**Files:**
- Create: `scripts/install.sh`, `README.md`, `LLM_WIKI.md`, `docs/superpowers/VERIFY.md`

**Interfaces:**
- Consumes: `bun run build` output `dist/agent-memory-collector.js` (Task 6).
- Produces: global install into `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/agent-memory-collector.js` with the broken-`main` trap warning (recurring pitfall #13).

- [ ] **Step 1: Write `scripts/install.sh`**

```bash
#!/usr/bin/env bash
# agent-memory collector installer
#
# Builds the collector plugin and installs it globally into
# ${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/ .
#
# Usage:
#   ./scripts/install.sh                 # global install
#   ./scripts/install.sh --name <f.js>   # override installed filename
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_NAME="agent-memory-collector.js"

while [ $# -gt 0 ]; do
  case "$1" in
    --name)
      shift
      [ $# -gt 0 ] || { echo "error: --name needs a value" >&2; exit 1; }
      PLUGIN_NAME="$1"
      ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown flag $1" >&2; exit 1 ;;
  esac
  shift
done

command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }
case "$PLUGIN_NAME" in *.js) ;; *) echo "error: --name must end in .js" >&2; exit 1 ;; esac

echo "==> Building agent-memory collector"
cd "$REPO_DIR"
[ -d node_modules ] || bun install
bun run build >/dev/null
[ -f dist/agent-memory-collector.js ] || { echo "error: build produced no bundle" >&2; exit 1; }

PLUGINS_DIR="$CONFIG_DIR/plugins"
DEST="$PLUGINS_DIR/$PLUGIN_NAME"
echo "==> Installing -> $DEST"
mkdir -p "$PLUGINS_DIR"
cp dist/agent-memory-collector.js "$DEST"

# Trap check: a package.json in the plugins dir whose "main" doesn't resolve
# silently disables EVERY flat plugin in this directory (root-caused 2026-07-10).
PKG_JSON="$PLUGINS_DIR/package.json"
if [ -f "$PKG_JSON" ]; then
  BROKEN_MAIN=$(bun -e '
    try {
      const fs = require("node:fs"), path = require("node:path")
      const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      if (pkg.main && !fs.existsSync(path.join(path.dirname(process.argv[1]), pkg.main))) console.log(pkg.main)
    } catch {}
  ' "$PKG_JSON")
  if [ -n "$BROKEN_MAIN" ]; then
    printf '\033[31m✗ WARNING:\033[0m %s\n' "$PKG_JSON has \"main\": \"$BROKEN_MAIN\" pointing at a missing file."
    printf '  %s\n' "This silently disables EVERY plugin in $PLUGINS_DIR (including this one)."
    printf '  %s\n' "Fix: remove the \"main\" field (back it up first), then restart opencode."
  fi
fi

cat <<EOF

Done. Next steps:
  1. Restart opencode.
  2. Transcripts appear under \${AGENT_MEMORY_HOME:-~/.agent-memory}/transcripts/
     after a session goes idle; check ~/.agent-memory/collector.log.
  3. Export history once: bun $REPO_DIR/collector/backfill.ts
EOF
```

Run: `chmod +x scripts/install.sh && bash -n scripts/install.sh`
Expected: exit 0.

- [ ] **Step 2: Write `README.md`** (English)

Sections: What it is (3 components, collector shipped, distiller/mcp-server upcoming); Install (script + manual); How it works (session.idle → transcript format sample from Spike A); Backfill; Configuration (`AGENT_MEMORY_HOME`, `AGENT_MEMORY_IGNORE`); Troubleshooting (collector.log, broken-main trap, read-only DB note); Development (bun test / build layout).

- [ ] **Step 3: Write `LLM_WIKI.md`** (繁體中文)

架構總覽（三元件、資料流圖）、入口點（`collector/plugin-entry.ts`、`collector/backfill.ts`）、常用指令（`bun test`、`bun run build`、`./scripts/install.sh`）、中繼格式契約（§5 of spec）、已知陷阱（loader contract、broken-main、live WAL DB read-only、content_hash 覆寫語義、`opencode run -f` 吞參數）、與 spec/plans/research 文件的對照表。

- [ ] **Step 4: Write `docs/superpowers/VERIFY.md`**

```markdown
# VERIFY — collector (Plan 1)

Status: PENDING USER VERIFICATION

Headless items (executor MUST run these, not defer):
1. `bun test` — all green.
2. `bun run typecheck` — clean.
3. `bun run build` + loader-contract check (Task 6 Step 5 command) — bundle exports only functions.
4. `bun collector/backfill.ts --limit 5` against the real local opencode.db —
   summary prints, transcripts appear under ~/.agent-memory/transcripts/, files
   are readable markdown with anchors.

Interactive items (user):
5. `./scripts/install.sh`, restart opencode, run any short session, wait for
   idle → transcript for that session exists and collector.log shows the write.
6. Resume the same session, go idle again → log shows `unchanged` (or `written`
   if content actually grew), no duplicate files.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh README.md LLM_WIKI.md docs/superpowers/VERIFY.md
git commit -m "docs: installer, readme, llm wiki, and verification checklist for collector"
```
