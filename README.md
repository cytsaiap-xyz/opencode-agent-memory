# opencode-agent-memory

A self-hosted agent-memory system that turns opencode conversation history
into durable, queryable engineering knowledge (development decisions,
debugging root causes, design know-how, recurring pitfalls).

## What it is

Three components, one monorepo, fully on-prem (no external API calls):

| Component | Kind | Job | Status |
|---|---|---|---|
| `collector/` | opencode plugin (TS) | on `session.idle`, export the session from `opencode.db` as a human-readable markdown transcript | **shipped** |
| `distiller/` | scheduled batch CLI (TS+Bun) | filter + consolidate transcripts into structured memory entries via LLM | **shipped** |
| `mcp-server/` | MCP server (TS+Bun) | query interface over the memory store | **shipped** |

This repo ships all three components. See
`docs/superpowers/specs/2026-07-10-agent-memory-design.md` for the full
design.

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

## Distiller

The distiller turns idle transcripts under
`${AGENT_MEMORY_HOME:-~/.agent-memory}/transcripts/` into structured,
deduplicated memory entries under `store/`. Unlike the collector, it does not
run per-session — it's a scheduled batch job (see Scheduling below).

### Pipeline stages

Each eligible transcript (one session = one unit of work) goes through:

```
INGEST → TRIAGE → EXTRACT → VALIDATE → RECONCILE → COMMIT → PUBLISH
```

1. **INGEST** — scan the transcript spool; skip a session if the ledger
   already has a row for its `(session_id, content_hash, pipeline_version)`,
   and skip any transcript that hasn't been idle for `AGENT_MEMORY_IDLE_HOURS`
   yet.
2. **TRIAGE** — a cheap, LLM-free gate: transcripts whose body is under 400
   characters are skipped (a ledger row with 0 candidates is still recorded,
   so they aren't rescanned every run) without ever calling the LLM.
3. **EXTRACT** — one big-model call per transcript, strict JSON array output
   against a 6-type taxonomy (`decision`, `root_cause`, `pitfall`, `know_how`,
   `convention`, `workflow`); candidates scoring below
   `AGENT_MEMORY_SALIENCE_MIN` are silently dropped.
4. **VALIDATE** (deterministic, no LLM) — per-field schema, every evidence
   `message_id` must match a real `{#msg_id}` anchor in the transcript
   (a hallucinated anchor rejects the candidate), `lesson` ≤ 80 words, and a
   secret/high-entropy-token scan — a hit sends the candidate to quarantine
   instead of rejecting it.
5. **RECONCILE** (Mem0-style) — FTS-query the top 5 similar `active` memories,
   then an LLM call picks exactly one of `ADD` / `UPDATE` / `SUPERSEDE` /
   `NOOP`. `SUPERSEDE` marks the old entry `status: superseded` and sets its
   `superseded_by`; entries are never deleted.
6. **COMMIT** — write/update the memory markdown file(s) and append a ledger
   row recording candidate/committed counts.
7. **PUBLISH** — regenerate `store/INDEX.md`, a human-readable catalog grouped
   by project, sorted by type then confidence (descending). This only happens
   at the end of `distill run` — `reindex`/`review`/`stats` don't touch it.

### CLI usage

```bash
bun run distill run [--project <slug>]   # run the pipeline once
bun run distill reindex                  # rebuild index.db from memories/ on disk
bun run distill review                   # list quarantined entries needing human review
bun run distill stats                    # print counts by status/type + sessions processed
```

`run` prints a one-line summary, e.g.:

```
distill done: 3 added, 1 updated, 0 superseded, 2 nooped, 1 quarantined, 0 rejected, 0 errors (scanned 12, eligible 8, already-done 5, triaged 1)
```

Exit codes: `0` success, `1` bad usage/config (unknown command, missing
`--project` value, invalid env value), `2` one or more transcripts errored
during a `run` (the rest of the batch still completes).

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AGENT_MEMORY_LLM` | *(unset)* | `vllm` selects the vLLM backend; anything else (or unset) falls back to `opencode-run`. |
| `AGENT_MEMORY_VLLM_URL` | — | Base URL of an OpenAI-compatible `/chat/completions` endpoint. Required when `AGENT_MEMORY_LLM=vllm`. |
| `AGENT_MEMORY_VLLM_MODEL` | — | Model name sent to the vLLM endpoint. Required when `AGENT_MEMORY_LLM=vllm`. |
| `AGENT_MEMORY_VLLM_KEY` | *(none)* | Optional bearer token, sent as `Authorization: Bearer <key>` when set. |
| `AGENT_MEMORY_IDLE_HOURS` | `6` | Minimum hours since a transcript's `time_end` before it becomes eligible. Must be `>= 0`. |
| `AGENT_MEMORY_SALIENCE_MIN` | `6` | Minimum salience (0-10) an extracted candidate must score to survive; below this it's dropped, not rejected. Must be in `[0, 10]`. |

`AGENT_MEMORY_HOME` (see the collector's Configuration table above) is shared
— it also determines `store/` and `transcripts/` for the distiller.

### Memory entry format

One markdown file per memory, filename = id. Frontmatter is the machine layer
(parsed into `index.db`); the body is the human-readable wiki layer:

```markdown
---
id: mem_20260710_a3f9c1
memory_class: semantic            # episodic | semantic | procedural
type: root_cause                  # decision|root_cause|pitfall|know_how|convention|workflow
title: "…"
trigger: "when …"
project: opencode-dynflow         # or "global"
scope: project                    # project | global
domain: [sta, eco-flow]
volatile: false
confidence: 0.55
status: active                    # candidate | active | superseded | quarantined | archived
superseded_by: null
review: auto                      # auto | human_pending | human_approved
evidence:
  - { session: ses_…, anchors: [msg_…, msg_…], observed_at: ISO8601 }
provenance:
  extractor: "distiller v0.1 / <model>"
  prompt_hash: sha256:…
created_at: ISO8601
updated_at: ISO8601
---
<lesson text, imperative/conditional, ≤ 80 words>

## Notes
<optional longer narrative added by UPDATE ops, append-only with dated bullets>
```

Confidence is deterministic, never LLM-rated:
`0.5 + 0.15·(independent_sessions−1) + 0.2·human_approved − 0.25·contradicted`,
clamped to `[0.1, 0.95]` and rounded to 2 decimals. The base is `0.5` rather
than a more conservative `0.4` because every candidate has already passed the
salience gate — a `0.4` base would put every brand-new, single-session memory
below the MCP query default of `confidence >= 0.5`, making the store
invisible on day one (this is a deliberate amendment over the initial spec
draft — see `docs/superpowers/specs/2026-07-10-agent-memory-design.md` §6).

### Store layout

```
${AGENT_MEMORY_HOME:-~/.agent-memory}/store/
├── memories/<project>/<id>.md   # active/candidate/superseded/archived entries
├── quarantine/<id>.md           # entries that failed the secret scan; human review required
├── index.db                     # sqlite3 + FTS5, rebuildable any time via `bun run distill reindex`
└── INDEX.md                     # human-readable catalog, regenerated at the end of every `distill run`
```

`index.db` is a derived cache, not a source of truth, so it's safe to delete
and rebuild with `bun run distill reindex`. One caveat: `reindex` only walks
`memories/`, so quarantined entries (which live under `quarantine/`) drop out
of `index.db` until they're promoted into `memories/` — `bun run distill
review`, however, reads `quarantine/` directly and is unaffected (see
LLM_WIKI for detail).

### Scheduling

The distiller does not schedule itself — run it externally:

```bash
# cron (crontab -e): once a day at 03:00
0 3 * * * cd /path/to/opencode-agent-memory && bun run distill run >> ~/.agent-memory/distill.log 2>&1
```

```xml
<!-- launchd (~/Library/LaunchAgents/com.agent-memory.distill.plist), macOS -->
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>-lc</string>
  <string>cd /path/to/opencode-agent-memory && bun run distill run</string>
</array>
<key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
```

### opencode-run vs vLLM

By default (`AGENT_MEMORY_LLM` unset) the distiller shells out to `opencode
run --pure --title distiller "<prompt>"` — this is the **dev fallback**: no
extra infrastructure to stand up, but slower and only as reliable as whatever
model opencode itself is configured with. For production, point
`AGENT_MEMORY_LLM=vllm` at a self-hosted vLLM server
(`AGENT_MEMORY_VLLM_URL`, `AGENT_MEMORY_VLLM_MODEL`) — it always requests
`response_format: json_schema` (guided decoding), which yields far more
reliable strict-JSON output for the EXTRACT/RECONCILE stages than a CLI
assistant turn.

## MCP Server

`mcp-server/` exposes the memory store to any MCP-speaking agent host over
stdio (`@modelcontextprotocol/sdk`), read-only against the store's content.

### Tools

| Tool | Args | Returns | When to call |
|---|---|---|---|
| `search_memory` | `query` (required), `project?`, `type?` (one of the six memory types), `domain?`, `include_tentative?` (bool), `limit?` (1-50, default 10) | Ranked list of `{ id, title, trigger, lesson, type, project, domain, confidence, updated_at }` | Before solving a problem — check whether a teammate (or a past agent session) already hit this and left a lesson. |
| `get_memory` | `id` | Full entry (frontmatter + lesson + `## Notes`) plus its file `path` | You already have a memory `id` (e.g. from a `search_memory` hit or an `INDEX.md`/`[[mem_id]]` reference) and need the full evidence/notes, not just the summary. |
| `list_domains` | `project?` | Active-memory counts by `domains`, `types`, and `projects` | Orient before searching — see what domain tags and projects actually have coverage. |
| `memory_stats` | *(none)* | Store totals: `byStatus`, `byType`, `sessions`, `lastProcessedAt`, `quarantineFiles` | Check store health, confirm the distiller is actually running, or size up how much has accumulated. |

`search_memory`'s default filter is `status=active AND confidence >= 0.5`;
pass `include_tentative: true` to also see lower-confidence candidates.
Results are FTS5 BM25-ranked, then reordered by rank *position* nudged by
confidence and a 30-day recency bonus (see LLM_WIKI for the exact formula) —
so a strong keyword match several ranks ahead of a fresher/higher-confidence
one still wins.

### Registering with an MCP host

**opencode** (global `~/.config/opencode/opencode.json`, or per-project
`opencode.json`):

```json
{
  "mcp": {
    "agent-memory": {
      "type": "local",
      "command": ["bun", "/ABSOLUTE/PATH/TO/opencode-agent-memory/mcp-server/main.ts"]
    }
  }
}
```

(Field shapes verified against `@opencode-ai/sdk`'s `McpLocalConfig`:
`type: "local"`, `command: string[]`, optional `environment` for env vars
like `AGENT_MEMORY_HOME`.)

**Claude Code**:

```bash
claude mcp add agent-memory -- bun /ABSOLUTE/PATH/TO/opencode-agent-memory/mcp-server/main.ts
```

### Probing without an MCP host

`mcp-server/probe.ts` drives the real `buildServer()` over an in-memory MCP
transport — no host required, useful for smoke-testing a store or debugging
ranking:

```bash
bun run mcp:probe "<query>" [--project <slug>]   # calls search_memory
bun run mcp:probe --stats                        # calls memory_stats
```

### Concurrency and read-only guarantee

`index.db` is opened with `PRAGMA journal_mode = WAL` and
`PRAGMA busy_timeout = 5000`, so the mcp-server and a scheduled `distill run`
can hold it open at the same time without lock errors. The server never
writes memory content — the only write path is `recordAccess()`, which bumps
`access_count`/`last_accessed` on `search_memory`/`get_memory` hits as a
reinforcement signal. This makes it safe to point `mcp-server` at a
git-synced read replica of the store, as long as `index.db` itself stays
writable (see LLM_WIKI for what happens if it isn't).

## Development

```bash
bun install
bun test          # bun:test, all collector + distiller + shared unit tests
bun run typecheck  # tsc --noEmit
bun run build      # bundles collector/plugin-entry.ts -> dist/agent-memory-collector.js
bun run distill run [--project <slug>]  # run the distiller pipeline once
bun run mcp                              # start the mcp-server over stdio
bun run mcp:probe "<query>" | --stats    # probe the server without an MCP host
```

Repo layout:

```
shared/     config loading, project slugs, default DB path (shared with distiller)
collector/  db.ts (read-only bundle load), transcript.ts (render), export.ts (skip/write rules),
            plugin.ts (session.idle hook), plugin-entry.ts (bundle entrypoint — exports only
            the plugin, per the opencode loader's function-exports-only contract), backfill.ts (CLI)
distiller/  cli.ts (run/reindex/review/stats), pipeline.ts (stage orchestration), transcripts.ts
            (spool scan/parse), extract.ts (prompt + validation), reconcile.ts (Mem0-style ADD/
            UPDATE/SUPERSEDE/NOOP), store.ts (markdown entry read/write), ledger.ts (sqlite index +
            idempotency), llm.ts (vllm / opencode-run clients)
mcp-server/ query.ts (search/rank + get/list/stats over MemoryIndex), server.ts (buildServer():
            tool registration/schemas), main.ts (stdio entrypoint), probe.ts (in-memory-transport
            CLI probe, no MCP host required)
docs/       design spec, research reports, superpowers specs/plans/SPIKE.md
scripts/    install.sh
```

See `docs/superpowers/specs/2026-07-10-agent-memory-design.md` for the full
architecture, `docs/superpowers/VERIFY.md` for the collector's manual
verification checklist, `docs/superpowers/VERIFY-distiller.md` for the
distiller's, and `docs/superpowers/VERIFY-mcp.md` for the mcp-server's.
