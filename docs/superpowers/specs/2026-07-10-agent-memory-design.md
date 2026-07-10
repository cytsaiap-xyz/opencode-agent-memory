# opencode-agent-memory — Design Spec

**Date:** 2026-07-10
**Status:** DRAFT — pending user approval
**Repo:** `opencode-agent-memory` (new, private)

## 1. Goal

A self-hosted agent-memory system that turns opencode conversation history into
durable, queryable engineering knowledge (development decisions, debugging root
causes, IC-design know-how, techfile/DRM/DRC handling experience), feeding the
team's existing markdown LLM-wiki knowledge system and letting agents
self-improve from engineer experience.

Three components, one monorepo:

| Component | Kind | Job |
|---|---|---|
| `collector/` | opencode plugin (TS) | on `session.idle`, export the session from opencode.db as a human-readable markdown transcript |
| `distiller/` | scheduled batch CLI (TS+Bun) | filter + consolidate transcripts into structured memory entries via LLM |
| `mcp-server/` | MCP server (TS+Bun) | query interface over the memory store |

## 2. Constraints (binding)

- **Fully on-prem.** No external API calls anywhere. LLM = self-hosted vLLM
  (OpenAI-compatible endpoint) in production; `opencode run` as dev fallback.
- **Deployment environment uncertain** (locked-down corporate Linux likely).
  Every deployable ships as a **single self-contained binary** via
  `bun build --compile` — no npm install, no native compile deps at install time.
- **Storage core: markdown files + SQLite FTS5** (route C from the research
  reports in `docs/research/`). No vector DB, no graph DB in phase 1. SQLite via
  built-in `bun:sqlite` only.
- **Stack: TypeScript + Bun** for all three components; shared schema code in
  `shared/`.
- All LLM output entering structured data is schema-validated per field
  (house rule); memory entries additionally require evidence-anchor verification.
- Communication 繁中; code/commits/docs English. Conventional commits with scope.

## 3. Architecture and data flow

```
opencode.db (live, WAL)
   │  read-only (bun:sqlite { readonly: true })
   ▼
[collector plugin]  ── session.idle(sessionID) ──►  export transcript
   │
   ▼
~/.agent-memory/transcripts/<project-slug>/<session_id>.md     (spool, overwrite + content_hash)
   │
   ▼  cron / manual run
[distiller]  INGEST → TRIAGE → EXTRACT → VALIDATE → RECONCILE → COMMIT → PUBLISH
   │
   ▼
~/.agent-memory/store/
   ├── memories/<project-slug>/<mem_id>.md    (canonical: one memory per file, YAML frontmatter)
   ├── memories/global/<mem_id>.md            (promoted cross-project knowledge)
   ├── index.db                               (SQLite: FTS5 + ledger + access stats; REBUILDABLE)
   └── quarantine/<mem_id>.md                 (failed validation / conflicts pending human review)
   │
   ▼
[mcp-server]  search_memory / get_memory / list_domains / memory_stats
```

Root directory configurable via `AGENT_MEMORY_HOME` (default `~/.agent-memory`).
Everything under `store/memories/` is designed to be committed to a git repo and
consumed by the LLM-wiki system directly (same markdown ecosystem).

`index.db` is a derived projection — deletable and rebuilt from the markdown
files with `distiller reindex`. Markdown is the single source of truth.

## 4. collector/ — opencode plugin

- Registers `event` hook; on `event.type === "session.idle"`:
  1. Open opencode.db **read-only**; load session, messages, parts.
  2. Skip if: session belongs to an ignored project (configurable list), or is a
     child session (`parent_id` set — subagent noise), or has < 2 user turns.
  3. Render transcript (format §5) to
     `~/.agent-memory/transcripts/<project-slug>/<session_id>.md` — full
     overwrite each time (idle re-fires as sessions resume; collector is
     stateless; downstream dedup via `content_hash`).
- Failure policy: never break the host. Every hook body wrapped in try/catch;
  errors logged to `~/.agent-memory/collector.log`, never thrown (dynflow
  pitfall #12/#13 lineage: bundle exports only plugin functions; self-contained
  bundle; installer reuses dynflow's broken-`main` trap check).
- Ships as `dist/agent-memory-collector.js` installed to
  `~/.config/opencode/plugins/` by `scripts/install.sh` (adapted from dynflow).
- Also provides `collector backfill` mode (same code path run as CLI) to export
  ALL historical sessions once — the DB already holds 706 sessions on the dev
  machine; day-one value comes from backfill, not just new sessions.

## 5. Intermediate transcript format (validated in Spike A)

```markdown
---
session_id: ses_…
project_dir: /path/to/project
title: "…"
model: provider/model
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

- Human-readable first: sequential turn numbers, HH:MM timestamps, roles.
- `{#msg_id}` anchors are the **evidence contract**: every distilled memory must
  cite anchors that exist, verified deterministically.
- Dropped: `reasoning`, `step-start`, `step-finish`, snapshot parts. Tool calls
  collapsed to one line. Full fidelity stays in opencode.db; transcripts are the
  distillation view, not an archive.

## 6. distiller/ — batch pipeline

CLI: `distiller run [--since …] [--project …]`, `distiller reindex`,
`distiller review` (list quarantine), `distiller stats`. Scheduled externally
(cron/launchd/systemd — environment-dependent, out of scope).

Stages per transcript (session = unit of work):

1. **INGEST** — enumerate spool; skip if ledger has `(session_id, content_hash,
   pipeline_version)` match. Only transcripts idle > N hours (default 6) eligible.
2. **TRIAGE** — cheap gate: heuristics first (min turns, min user text length),
   then optional small-model yes/no "does this contain durable knowledge?".
   Most sessions yield nothing; skipping is the cost saver.
3. **EXTRACT** — big model, 6-type taxonomy (`decision`, `root_cause`, `pitfall`,
   `know_how`, `convention`, `workflow`), strict JSON, salience 0-10 with
   configurable cutoff (default ≥ 6), `volatile` flag, evidence anchors required.
   vLLM: `response_format: json_schema` (guided decoding). Prompt in
   `distiller/prompts/extract.txt`, versioned; `prompt_hash` recorded.
4. **VALIDATE** (deterministic, no LLM) — per-field schema; every evidence
   anchor exists in the transcript; lesson ≤ 80 words; secret scan (regex +
   entropy) → quarantine on hit.
5. **RECONCILE** (Mem0 loop) — per candidate: FTS query top-s similar existing
   memories (BM25 over title/trigger/lesson/domain); LLM tool-call chooses
   **ADD / UPDATE / SUPERSEDE / NOOP**. UPDATE appends an evidence row (+
   confidence); SUPERSEDE sets old entry `status: superseded`,
   `superseded_by: <id>` — never delete.
6. **COMMIT** — write/update memory markdown files; append ledger row; entries
   with confidence < auto-threshold or type ∈ {decision, convention} conflicts →
   `quarantine/` for human review.
7. **PUBLISH** — refresh FTS index; regenerate `store/INDEX.md` (human-readable
   catalog grouped by type × domain, MEMORY.md-index style).

Confidence is deterministic, not LLM-rated:
`0.4 + 0.15·(independent_sessions−1) + 0.2·human_approved − 0.2·contradicted`,
clamped [0.1, 0.95]. Scope: `project` by default; REFLECT-style promotion to
`global/` when the same lesson accrues evidence from ≥ 2 projects (phase-1
implementation: reconciler detects cross-project UPDATE and flags for promotion).

LLM backend abstraction: `LlmClient` interface with two impls —
`VllmClient` (OpenAI-compatible `/chat/completions`, `guided_json`) and
`OpencodeRunClient` (dev fallback shelling to `opencode run --pure`, message
BEFORE `--file=` flag per Spike A gotcha).

## 7. Memory entry format (canonical markdown)

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

One memory per file; filename = id. Frontmatter is the machine layer (parsed
into index.db); body is the wiki-ready human layer. `[[mem_id]]` links allowed
in Notes for A-MEM-style cross-references.

## 8. mcp-server/ — query interface

MCP over stdio (`@modelcontextprotocol/sdk`, pinned), single compiled binary.

Tools:
- `search_memory({ query, project?, type?, domain?, include_tentative? })` —
  FTS5 BM25 ranked, boosted by confidence and recency; default filter
  `status=active AND confidence >= 0.5`; returns trigger+lesson+id+confidence,
  max 10. Records `access_count`/`last_accessed` (reinforcement signal).
- `get_memory({ id })` — full entry including evidence and notes.
- `list_domains({ project? })` — domain/type counts for orientation.
- `memory_stats()` — store totals, last distill run, quarantine count.

Read-only against the store; writes only access stats to index.db. This keeps
mcp-server safe to point at a git-synced read replica of the store.

## 9. Testing

- `bun:test` throughout; per-test tmp dirs; **polling not sleeps** for async
  file assertions (pitfall #10).
- collector: fixture opencode.db built in-test (real schema DDL); renders
  golden-file transcripts; idle-refire overwrite semantics.
- distiller: LlmClient faked; stage-by-stage unit tests + one end-to-end run on
  a fixture transcript; ledger idempotency (rerun = all NOOP); evidence
  hallucination rejection; secret quarantine.
- mcp-server: in-process tool-call tests over a fixture store.
- VERIFY.md for what needs a live opencode / real vLLM (headlessly verifiable
  items MUST actually be executed — pitfall #12 meta-lesson).

## 10. Out of scope (phase 1)

- Wiki auto-merge (memories are wiki-*ready*; merging into the existing LLM-wiki
  KMS is a later phase — likely a REFLECT stage rendering per-domain pages).
- Weekly cross-session REFLECT clustering (schema supports it; job comes later).
- Graphiti/Cognee derived index (route B tier-2; store layout keeps it possible).
- Embedding/vector retrieval (FTS5 first; add only if recall provably falls short).
- Multi-user/team concurrency (single-engineer store per machine; team sync via git).

## 11. Open questions resolved

1. Storage core markdown + SQLite FTS5 — **approved by user 2026-07-10**.
2. TS+Bun monorepo — **approved**; deployment uncertainty answered with
   single-binary compile artifacts.
3. Extraction feasibility — **Spike A PASS** (4/4 valid, 0 hallucinated evidence).
