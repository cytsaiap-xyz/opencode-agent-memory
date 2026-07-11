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

## Quick start (one command)

```bash
./scripts/setup.sh --backfill --schedule "0 3 * * *"
```

Idempotent one-shot setup: installs the collector plugin globally, registers
the MCP server in `~/.config/opencode/opencode.json` (merge — existing config
is never clobbered; invalid JSON aborts), exports all historical sessions,
and installs a nightly `distill run` cron entry via `scripts/run-distill.sh`
(logs to `~/.agent-memory/distill.log`, resolves bun without relying on
cron's PATH). Both flags are optional; re-running is always safe. Restart
opencode afterwards.

macOS note: cron may need Full Disk Access if the repo lives under
Documents/Desktop (TCC). On servers, a systemd timer calling
`scripts/run-distill.sh` works equally well.

## Install (collector only)

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
bun run distill review                   # list ALL entries pending human review
bun run distill approve <id>             # release a pending entry (see Review workflow below)
bun run distill reject <id> [--reason "<text>"]  # archive a pending entry, never delete
bun run distill stats                    # print counts by status/type + sessions processed
```

`run` prints a one-line summary, e.g.:

```
distill done: 3 added, 1 updated, 0 superseded, 2 nooped, 1 quarantined, 0 rejected, 0 errors (scanned 12, eligible 8, already-done 5, triaged 1)
```

Exit codes: `0` success, `1` bad usage/config (unknown command, missing
`--project` value, invalid env value), `2` one or more transcripts errored
during a `run` (the rest of the batch still completes).

### Review workflow

`distill review` lists every entry with `review: human_pending` and
`status != archived` — both the `quarantine/` directory (secret-scan hits,
and `SUPERSEDE_PENDING` entries, see below) and `memories/<project>/` (a
human may have moved a file there by hand without flipping its `review`
field yet). Each line is `<id> — <title> (<last note>)`; a corrupt file is
skipped with a `skipping corrupt entry: <path>` warning on stderr instead of
aborting the whole listing.

**`distill approve <id>`** — releases the entry:
1. Must currently be `review: human_pending` and `status != archived`
   (anything else → friendly error, exit 1).
2. Sets `status: active`, `review: human_approved`, recomputes confidence via
   `computeConfidence({ sessions: <distinct evidence sessions>, humanApproved:
   true, contradicted: false })` (this is the only place the `+0.2
   human_approved` term in the confidence formula is ever triggered), appends
   a dated `approved by human` note.
3. If the file lives under `quarantine/`, moves it into
   `memories/<project>/<id>.md`; on a destination collision the id is
   uniquified with the existing `-2`/`-3` convention (the approved entry
   moves under the new id; the file already occupying the destination is
   never touched).
4. If the entry has a `supersedes: <target_id>` field (see below), tombstones
   the target now — `status: superseded`, `superseded_by: <the approved
   entry's FINAL id, after any rename>` — unless the target has drifted out
   of the index, in which case approval still succeeds with a
   `supersede target <id> not found — approved without tombstoning` warning
   on stderr.

**`distill reject <id> [--reason "<text>"]`** — archives the entry in place
(never deletes it): `status: archived`, appends a dated
`rejected by human — <reason, default "not specified">` note. The file stays
exactly where it was (`quarantine/` or `memories/`); `status: archived`
alone is what excludes it from `distill review` and from every serving path
(reindex still walks archived files — they just don't show up as pending or
in search results).

**Worked example — the decision-supersede flow.** A signed-off `decision`
memory (`mem_20260710_8cd55e`, "useful skew is banned") is active. A later
session argues the ban should be lifted. During RECONCILE the LLM proposes
`SUPERSEDE` against that memory — but because its `type` is `decision` (team
policy, not a fact), `reconcile.ts` does **not** apply it automatically. It
instead writes a new quarantined entry with `supersedes: mem_20260710_8cd55e`
and a note like `pending review — proposes to supersede
mem_20260710_8cd55e: …`. The old rule keeps answering agent queries exactly
as before.

```bash
bun run distill review
# mem_20260711_a1b2c3 — Allow useful skew (pending review — proposes to supersede mem_20260710_8cd55e: …)

bun run distill reject mem_20260711_a1b2c3 --reason "still banned"
# rejected mem_20260711_a1b2c3
```

The proposal is archived, `mem_20260710_8cd55e` is never touched, and an
agent asking about useful skew still gets the original "forbidden" answer.
Had this been `approve`d instead, `mem_20260710_8cd55e` would be tombstoned
(`status: superseded`, `superseded_by: mem_20260711_a1b2c3`) and the new
entry would become the active answer. The other four memory types
(`root_cause`, `pitfall`, `know_how`, `workflow`) are factual, not policy —
their SUPERSEDEs still apply automatically, with no review step.

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

### CJK search & trigram FTS

`memories_fts` uses FTS5's `trigram` tokenizer (not the default `unicode61`,
which never splits a contiguous CJK run into separate tokens). `search()`
(shared by the distiller's RECONCILE step and `search_memory`) partitions the
query into tokens and picks a strategy per query:

- Any token **≥ 3 code points** (checked with `[...token].length`, so a
  3-character CJK run counts) → those tokens drive a normal `MATCH` query,
  bm25-ranked as before. This covers both English words and CJK runs of 3+
  characters, e.g. `"時序收斂"` or `"收斂技巧"` both match a lesson
  containing `時序收斂技巧`.
- If **no** token reaches 3 code points (e.g. a bare 2-character CJK query
  like `"時序"`), the query falls back to an index-accelerated `LIKE` scan
  (`title`/`trigger`/`lesson`/`domain` LIKE `%tok%`, OR-joined per token,
  metacharacters `%`/`_` escaped) with `score = 0` for every hit — ordering
  then falls entirely to confidence/recency. `"首都"` (a 2-char query with no
  hits anywhere in the store) still returns `[]` without error; the LIKE path
  never throws even against `%`/`_` inside the query text.
- **Mixed queries ignore the short tokens.** If a query has at least one
  ≥3-code-point token, only those tokens are used for MATCH — any shorter
  tokens in the same query are silently dropped. This is documented behavior,
  not a bug: don't expect a 2-char CJK token to add extra recall alongside a
  longer English/CJK token in the same query.
- **Index auto-rebuild on upgrade.** `index.db` tracks its own schema via
  `PRAGMA user_version`. A pre-trigram (`< 2`) database is migrated in place
  the first time it's opened after upgrading: the old FTS table is dropped
  and recreated with the trigram tokenizer, and if the store already had
  memory rows, `MemoryIndex.ftsRebuildNeeded` comes back `true`. Every
  storeDir-owning entry point (`distiller/cli.ts`, `mcp-server/main.ts`,
  `mcp-server/probe.ts`) checks this flag and calls `rebuildFrom(storeDir)`
  automatically, printing
  `agent-memory: fts schema upgraded — rebuilding index from <storeDir>`
  to stderr exactly once. The very next invocation opens at `user_version =
  2` already and does nothing extra — no manual `reindex` step required.
  Fresh stores are created at `user_version = 2` directly and never see the
  notice.
- **English substring side effect.** Because trigram indexing is
  character-based rather than word-based, it also enables substring matches
  within English words that `unicode61` would have missed — e.g. a query for
  `"parasitic"` now also matches text containing `"parasitics"`. This is a
  mild recall improvement (bm25 ranking still applies on top), not a
  regression; existing English search tests are the regression net for it.

## SQLite-optional mode

`index.db` is an optional accelerator, not a dependency. On startup, every
entry point (`distiller/cli.ts`, `mcp-server/main.ts`, `mcp-server/probe.ts`,
`eval/`) runs a one-time probe (`shared/sqliteProbe.ts`): open a throwaway
`bun:sqlite` database under `<storeDir>/.sqlite-probe.tmp`, set
`PRAGMA journal_mode = WAL`, create a table, insert, read back, close, and
unlink the probe files. If that roundtrip succeeds, everything runs exactly
as documented above — sqlite mode is byte-identical to how this system has
always behaved, nothing to configure. If it throws for any reason (no
`bun:sqlite` native bindings, a restricted/read-only mount, filesystem
locking not supported, etc.), the system transparently falls back to scanning
the markdown store directly. **The markdown files under `store/memories/` and
`store/quarantine/` are always the source of truth; `index.db` is always a
derived, disposable projection of them** — this is true in both modes, which
is exactly what makes the fallback safe.

Force fallback mode deliberately (e.g. to test it, or because sqlite passes
the probe but is known to be unreliable in your environment) with:

```bash
AGENT_MEMORY_NO_SQLITE=1 bun run distill run
AGENT_MEMORY_NO_SQLITE=1 bun run mcp
AGENT_MEMORY_NO_SQLITE=1 bun run mcp:probe "<query>"
```

When the probe fails (or `AGENT_MEMORY_NO_SQLITE=1` is set), exactly one
warning is printed to **stderr** per process, never stdout (the mcp-server's
stdout is the MCP protocol channel):

```
agent-memory: sqlite unavailable (<reason>) — markdown-scan mode: search is
O(n) without bm25 ranking, access stats disabled, ledger uses ledger.jsonl
```

### What degrades and what's genuinely lost

| Capability | sqlite mode | fallback (filescan) mode | What's actually lost |
|---|---|---|---|
| `search_memory` ranking | FTS5 bm25 + trigram tokenizer | deterministic keyword scoring: `hits = Σ per token (title×3 + trigger×2 + lesson×1 + domain×2)` case-insensitive substring counts, `score = -hits`, zero-hit entries excluded | Not bm25 — a cruder but fully deterministic and documented substring scorer. At wiki scale (≤ low thousands of entries) this is a full markdown parse-and-scan per query, measured-fine. |
| CJK search (e.g. `"時序"`) | trigram FTS (3+ char runs) / LIKE fallback (2-char) | native substring match, no tokenizer needed, works for any length | Nothing — filescan CJK search is arguably simpler/more predictable than the trigram/LIKE split. |
| `get_memory` / `getById` | indexed lookup | filename scan (`<id>.md` across `memories/` + `quarantine/`) | Nothing functionally — O(n) instead of O(1), invisible at wiki scale. |
| `memory_stats` / `distill stats` | table aggregate | markdown scan, counts `byStatus`/`byType` | Nothing — same numbers either way (see VERIFY item 3). |
| Access stats (`recordAccess`, the ranking recency/reinforcement signal) | tracked (`access_count`, `last_accessed`) | **switched off** — `recordAccess` is a no-op, `accessStats` returns `null`, `memory_stats`/`search_memory` report `accessAvailable: false` | **Genuinely lost.** There is no filesystem-native way to track per-entry access counts without reintroducing a database, so this signal simply disappears in fallback mode. Ranking still applies the confidence/recency boost — it just loses the "which entries actually get queried" reinforcement input. |
| Idempotency ledger (`processed_sessions`) | sqlite table | **`store/ledger.jsonl`** append-only file (see below) | Nothing — same correctness guarantee, different storage. |
| `distill reindex` | rebuilds `index.db` from markdown | no-op: prints `markdown is the store — nothing to rebuild (filescan mode)`, exit 0 | Nothing to lose — there's no derived index to rebuild when markdown is read directly. |

### `ledger.jsonl`

Idempotency (never re-extracting the same transcript twice) matters for
correctness, not just token cost — a nightly run without it would re-process
every transcript in history every night, multiplying wall-clock time and
churning already-committed memories with spurious "re-extracted" update
noise. In fallback mode this ledger lives at `<storeDir>/ledger.jsonl`: one
JSON line per processed session (`session_id`, `content_hash`,
`pipeline_version`, `extractor_model`, `processed_at`, `n_candidates`,
`n_committed` — the same fields as the sqlite table), written by a single
writer (the distiller), append-only. A crash mid-append at worst truncates
the final line; the loader tolerates a torn final line silently (any other
corrupt line logs one aggregate warning and is skipped). Sqlite mode and
fallback mode never share or migrate ledger state — switching modes means,
at worst, one extra re-extraction pass per transcript, and RECONCILE's own
dedup logic absorbs the rest.

### Corporate-deploy note

There is nothing to configure for either mode. If `bun:sqlite` works in your
environment, you automatically get the full accelerated path (bm25 ranking,
access stats, O(1) lookups) with zero setup. If it doesn't — a restricted
corporate mount, missing native bindings, whatever the cause — the system
degrades to the markdown-scan fallback automatically, on its own, with a
clear one-line warning explaining exactly what's off. Either way `setup.sh`,
`distill run`, and the mcp-server work end-to-end; the only operational
difference is that stderr will carry the warning line above once per process
in fallback mode. See `docs/superpowers/VERIFY-sqlite-optional.md` for the
verification record of this behavior against a real store.

## Regression eval

`eval/` is a deterministic regression harness (`bun run eval`) that answers two
questions after any prompt, model, threshold, or ranking change: does
extraction still pull the knowledge it should (and nothing from noise), and
does retrieval still surface the expected memory for realistic queries? The
judge is pure type+keyword matching — **no LLM grading anywhere in scoring**,
because an LLM-graded eval would drift with the very model changes it's
supposed to measure. Full design: `docs/superpowers/specs/2026-07-11-regression-eval-design.md`.

An eval run never touches `~/.agent-memory`: fixtures live in the repo
(`eval/fixtures/`, real sanitized transcripts), retrieval builds a throwaway
index in a tmp dir from a checked-in golden store (`eval/retrieval/store/`),
and extraction skips RECONCILE/COMMIT entirely — it only runs
`parseTranscript → buildExtractPrompt → LlmClient.complete → validateCandidates`
and scores the result.

### Commands

```bash
bun run eval                    # both suites: extraction + retrieval
bun run eval --extraction-only  # only the 3 fixture cases (calls the LLM, seconds-to-minutes)
bun run eval --retrieval-only   # only the 4 golden queries (no LLM, <1s)
```

Exit code `0` when everything passes, `1` on any failure — CI-compatible.
Each run appends one line to `eval/results.jsonl`
(`{ ts, model: llm.describe(), extraction, retrieval, pass }`); the file is
tracked in git but **not every run should be committed** — only append (and
commit) a line when it represents a meaningful result you want in history
(a baseline, or a deliberate model/prompt-change comparison). Throwaway
verification runs while iterating don't need to be kept — the results.jsonl
diff is a two-line comparison tool, not an audit log of every invocation.
`--retrieval-only` never appends to `results.jsonl` regardless — a retrieval
smoke check makes zero LLM calls and carries no model/prompt/threshold
signal, so it isn't a model eval worth tracking in that history.

### `eval/cases.json` — extraction expectations

```jsonc
{
  "fixture": "ppa-timing-closure.md",   // file under eval/fixtures/
  "salience_min": 6,                    // optional, default 6
  "expect": [                           // each rule needs >= min matching candidates
    { "type": "decision", "keywords": ["useful skew"], "min": 1 }, // type optional
    { "keywords": ["retiming"] }        // type omitted = match any type
  ],
  "forbid": [{ "keywords": ["lunch"] }],// no candidate may match any of these
  "max_extra": 8,                       // cap on valid candidates matched by no expect rule
  "max_total": 0                        // for noise fixtures: total valid candidates must be 0
}
```

A candidate matches a rule iff `candidate.type === rule.type` (when given)
AND every keyword is a case-insensitive substring of
`title + " " + trigger + " " + lesson`. LLM output that fails to parse or
fails per-candidate validation (bad schema, hallucinated evidence anchor)
counts as an eval failure for that fixture — that's the schema-fidelity
signal a model switch needs, distinct from a plain expectation miss.

**Footgun: an `expect` or `forbid` rule with `"keywords": []` matches every
candidate of the given type (or every candidate at all, if `type` is also
omitted).** `rule.keywords.every(...)` is vacuously `true` on an empty array,
so an empty-keywords rule isn't "match nothing" — it's "match everything."
On `expect` this makes the rule trivially pass as long as any candidate
exists (defeating the point of the assertion); on `forbid` it flags every
single candidate as forbidden. Always give at least one real keyword.

### `eval/retrieval/queries.json` — retrieval expectations

```jsonc
{ "query": "useful skew setup timing", "expect_id": "mem_20260710_8cd55e", "within_top": 3 }
```

Pass iff `expect_id` appears in the first `within_top` results returned by
`searchMemory` against the golden store. Fully deterministic, zero LLM calls.

### Adding a fixture

1. Drop a real (or hand-written, `serializeEntry`-shaped) transcript into
   `eval/fixtures/<name>.md`. Sanitize on check-in — no credentials, no
   external names; run `scanSecrets` (`distiller/extract.ts`) over the body
   first.
2. Add a case to `eval/cases.json`. Pick `expect` keywords from the
   **strongest, most literal content signals actually present in the
   transcript** (a term the transcript itself uses, not a paraphrase) so the
   case stays robust across models — see "cross-model robustness" below.
   Prefer omitting `type` unless the classification is unambiguous; two
   defensible types for the same content (e.g. "team policy" as `decision`
   vs `convention`) will flake a type-constrained rule across LLM calls even
   with a fixed model, purely from sampling variance.
3. For a zero-extraction ("noise") fixture, use `"expect": [], "max_total": 0`.
4. Run `bun run eval --extraction-only` a few times before committing — the
   opencode-run dev backend (see below) is noticeably less schema-stable
   than vLLM with guided decoding, so a case should be re-run enough times
   to confirm it isn't accidentally pinned to one lucky sample.
5. For retrieval, add real (or `serializeEntry`-built) entries under
   `eval/retrieval/store/memories/<project>/` and a query in
   `eval/retrieval/queries.json`.

### Cross-model robustness

Expectations must be chosen to survive a model swap: match on strong content
signals with a generous `min`/`max_extra`, not on the exact candidate count
or exact type a specific model happened to produce. In practice this means
keeping `expect` rules keyword-only unless a type distinction is genuinely
unambiguous — during this eval's own baseline run, an `expect` rule
type-constrained to `decision` and another constrained to `pitfall` each
flaked (matched a semantically-correct but differently-typed candidate)
purely from run-to-run sampling variance on the *same* backend and model;
loosening both to keyword-only (no type constraint) fixed it without
weakening the assertion's intent.

### Model-switch workflow

Switching the distiller's LLM backend (or its prompt, or the salience
threshold) is exactly what this harness exists to gate:

```bash
# baseline already in eval/results.jsonl (opencode-run backend)
AGENT_MEMORY_LLM=vllm AGENT_MEMORY_VLLM_URL=http://... AGENT_MEMORY_VLLM_MODEL=... \
  bun run eval --extraction-only
```

Then diff the new `eval/results.jsonl` line against the baseline line —
`model` changes, and `extraction.{fixturesPass,expectationsMet,errors}`
should hold or improve. Run it twice before trusting the result: LLM output
is nondeterministic, so a single green run doesn't prove stability, and a
single red run doesn't prove a regression — only a repeatable difference
does. Commit the new results.jsonl line once you've confirmed it's real.

## Development

```bash
bun install
bun test          # bun:test, all collector + distiller + shared unit tests
bun run typecheck  # tsc --noEmit
bun run build      # bundles collector/plugin-entry.ts -> dist/agent-memory-collector.js
bun run distill run [--project <slug>]  # run the distiller pipeline once
bun run eval [--extraction-only|--retrieval-only]  # regression eval (see above)
bun run mcp                              # start the mcp-server over stdio
bun run mcp:probe "<query>" | --stats    # probe the server without an MCP host
```

Repo layout:

```
shared/     config loading, project slugs, default DB path (shared with distiller)
collector/  db.ts (read-only bundle load), transcript.ts (render), export.ts (skip/write rules),
            plugin.ts (session.idle hook), plugin-entry.ts (bundle entrypoint — exports only
            the plugin, per the opencode loader's function-exports-only contract), backfill.ts (CLI)
distiller/  cli.ts (run/reindex/review/approve/reject/stats), pipeline.ts (stage orchestration),
            transcripts.ts (spool scan/parse), extract.ts (prompt + validation), reconcile.ts
            (Mem0-style ADD/UPDATE/SUPERSEDE/NOOP, decision/convention SUPERSEDE interception),
            reviewops.ts (approveEntry/rejectEntry — the human review loop), quarantine.ts
            (shared uniquified quarantine writer), store.ts (markdown entry read/write), ledger.ts
            (sqlite index + idempotency + trigram FTS), llm.ts (vllm / opencode-run clients)
mcp-server/ query.ts (search/rank + get/list/stats over MemoryIndex), server.ts (buildServer():
            tool registration/schemas), main.ts (stdio entrypoint), probe.ts (in-memory-transport
            CLI probe, no MCP host required)
eval/       match.ts (deterministic candidate matcher/scorer), run.ts (harness: extraction +
            retrieval suites, scorecard, results.jsonl history), fixtures/ (real sanitized
            transcripts), cases.json (extraction expectations), retrieval/ (golden store +
            queries.json), results.jsonl (append-only run history, tracked)
docs/       design spec, research reports, superpowers specs/plans/SPIKE.md
scripts/    install.sh
```

See `docs/superpowers/specs/2026-07-10-agent-memory-design.md` for the full
architecture, `docs/superpowers/specs/2026-07-11-regression-eval-design.md`
for the eval harness design,
`docs/superpowers/specs/2026-07-11-sqlite-optional-design.md` for the
sqlite-optional design, `docs/superpowers/VERIFY.md` for the collector's
manual verification checklist, `docs/superpowers/VERIFY-distiller.md` for the
distiller's, `docs/superpowers/VERIFY-mcp.md` for the mcp-server's,
`docs/superpowers/VERIFY-eval.md` for the eval harness's, and
`docs/superpowers/VERIFY-sqlite-optional.md` for the sqlite-optional mode's.
