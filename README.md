# opencode-agent-memory

A self-hosted agent-memory system that turns opencode conversation history
into durable, queryable engineering knowledge (development decisions,
debugging root causes, design know-how, recurring pitfalls).

## What it is

Three components, one monorepo, fully on-prem (no external API calls):

| Component | Kind | Job | Status |
|---|---|---|---|
| `collector/` | opencode plugin (TS) | on `session.idle`, export the session from `opencode.db` as a human-readable markdown transcript | **shipped** |
| `distiller/` | scheduled batch CLI (TS+Bun) | filter + consolidate transcripts into structured memory entries via LLM | upcoming |
| `mcp-server/` | MCP server (TS+Bun) | query interface over the memory store | upcoming |

This repo currently ships the **collector** only. `distiller/` and
`mcp-server/` are placeholders for later phases (see
`docs/superpowers/specs/2026-07-10-agent-memory-design.md`).

## Install

```bash
./scripts/install.sh
```

This builds `dist/agent-memory-collector.js` (`bun run build`) and copies it
to `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/agent-memory-collector.js`.
Restart opencode afterwards to pick it up. Use `--name <file.js>` to install
under a different filename.

Manual install, if you'd rather not run the script:

```bash
bun install
bun run build
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
cp dist/agent-memory-collector.js "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/"
```

## How it works

The plugin registers an `event` hook. When opencode emits `session.idle`, the
collector:

1. Opens `opencode.db` **read-only** and loads the session, its messages, and
   parts.
2. Skips the session if it belongs to an ignored project, is a child/subagent
   session (`parent_id` set), or has fewer than 2 user turns.
3. Renders a markdown transcript and writes it to
   `${AGENT_MEMORY_HOME:-~/.agent-memory}/transcripts/<project-slug>/<session_id>.md`,
   overwriting any previous export for that session (the collector is
   stateless; downstream consumers dedup on `content_hash`).

Sample transcript format (frontmatter + turn anchors — see spec §5 for the
full contract):

```markdown
---
session_id: ses_…
project_dir: "/path/to/project"
title: "…"
model: "provider/model"
time_start: ISO8601
time_end: ISO8601
turns: 22
tokens: { input: 43821, output: 6469 }
content_hash: sha256:9e1159a3827a3c90     # over rendered body, for idempotency
exported_at: ISO8601
---
## T1 [15:08] User {#msg_c5cb1fd710012z2Z1AYeaLc7B9}

<user text>

## T2 [15:09] Assistant {#msg_…}

<assistant text>

> 🔧 <tool> <input ≤160 chars> → <status>
```

`{#msg_id}` anchors are the evidence contract for the distiller: every future
distilled memory must cite anchors that actually exist in the transcript.
`reasoning`, `step-start`, `step-finish`, and snapshot/patch parts are
dropped by design; tool calls are collapsed to a single summary line. Full
fidelity always remains in `opencode.db` — transcripts are a distillation
view, not an archive.

The hook body is wrapped in try/catch and never throws: failures are logged
to `collector.log` instead of breaking the host session.

## Backfill

The DB already holds historical sessions before the plugin is ever
installed. Run the same export path as a one-off CLI to backfill them all:

```bash
bun collector/backfill.ts
```

Options:

```bash
bun collector/backfill.ts --limit 5        # only process the first N root sessions
bun collector/backfill.ts --db /path/to/opencode.db   # override the DB path
```

It prints a summary line when done, e.g.:

```
backfill done: 12 written, 3 unchanged, 40 skipped, 0 errors
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AGENT_MEMORY_HOME` | `~/.agent-memory` | Root directory for transcripts, the future store, and `collector.log`. |
| `AGENT_MEMORY_IGNORE` | *(empty)* | Comma-separated list of project slugs or directory substrings to skip exporting entirely. |

opencode's own DB path is derived from `XDG_DATA_HOME` (default
`~/.local/share`) as `$XDG_DATA_HOME/opencode/opencode.db`; override it with
`--db` on the backfill CLI if your install lives elsewhere.

## Troubleshooting

- **Nothing gets written after a session goes idle.** Check
  `${AGENT_MEMORY_HOME:-~/.agent-memory}/collector.log` — every run (skip,
  write, or error) appends one line there. Common skip reasons: `child
  session`, `too few user turns`, `ignored project`, `not found`.
- **The plugin doesn't seem to load at all, and neither do your other
  plugins.** If `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/` contains a
  `package.json` whose `"main"` field points at a file that doesn't exist,
  opencode silently disables **every** plugin in that directory — not just
  this one. `scripts/install.sh` checks for this on every run and prints a
  warning if it finds one. Fix: back up and remove the `"main"` field from
  that `package.json`, then restart opencode.
- **Is it safe to run while opencode is open?** Yes — `opencode.db` is a live
  WAL-mode SQLite database, and the collector always opens it read-only
  (`new Database(dbPath, { readonly: true })`). It never writes to
  `opencode.db`.

## Development

```bash
bun install
bun test          # bun:test, all collector + shared unit tests
bun run typecheck  # tsc --noEmit
bun run build      # bundles collector/plugin-entry.ts -> dist/agent-memory-collector.js
```

Repo layout:

```
shared/     config loading, project slugs, default DB path (shared with distiller later)
collector/  db.ts (read-only bundle load), transcript.ts (render), export.ts (skip/write rules),
            plugin.ts (session.idle hook), plugin-entry.ts (bundle entrypoint — exports only
            the plugin, per the opencode loader's function-exports-only contract), backfill.ts (CLI)
distiller/  placeholder — phase 2
mcp-server/ placeholder — phase 2
docs/       design spec, research reports, superpowers specs/plans/SPIKE.md
scripts/    install.sh
```

See `docs/superpowers/specs/2026-07-10-agent-memory-design.md` for the full
architecture and `docs/superpowers/VERIFY.md` for the manual verification
checklist.
