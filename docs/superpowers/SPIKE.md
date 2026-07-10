# Spike Log — opencode-agent-memory

## Spike A: end-to-end extraction feasibility (2026-07-10)

**Question:** Can the full collector → distiller extraction path work against real data —
opencode.db read → human-readable markdown transcript → LLM extraction → validated
structured memories with verifiable evidence pointers?

**Method:**
1. `spikes/export-session.ts` (bun:sqlite, read-only) exported real session
   `ses_3a34e0294ffeE3za8GmSU1b2VC` (23 messages, 22 rendered turns, 12,210 chars)
   as markdown with YAML frontmatter + per-turn anchors `{#msg_id}`.
   Dropped parts by design: `reasoning`, `step-start`, `step-finish`; `tool` parts
   collapsed to one-line summaries.
2. Extraction via `opencode run --pure` (model: `opencode/big-pickle`, 19,001 in /
   792 out tokens) with the 6-type taxonomy prompt (`spikes/extract-prompt.txt`),
   strict-JSON output, salience ≥ 6 cutoff, evidence citations required.
3. Deterministic validation: per-field schema check + every `evidence.message_id`
   must exist as a `{#...}` anchor in the transcript (hallucination detector).

**Result: PASS — 4/4 extracted items schema-valid, 0 hallucinated evidence IDs.**
Items were reasonable (2× workflow, 1× convention, 1× know_how) with correct
salience gating and sensible lessons.

**Findings / gotchas recorded:**
- `opencode run` `-f/--file` is a yargs ARRAY flag — it greedily swallows the
  following message positional ("File not found: <prompt text>"). The message
  must come BEFORE the flag: `opencode run "<msg>" --file=x.md`.
- opencode.db is live (WAL); read-only open (`{ readonly: true }` in bun:sqlite)
  works fine concurrently with a running opencode instance.
- `message.data.role` + text/tool part filtering is sufficient to produce a
  readable transcript; no other part types needed for distillation.
- big-pickle (default free-tier model) already produces clean strict JSON without
  fences for this prompt shape. Company vLLM models must be re-validated with the
  same harness (validation script generalizes; keep it in the distiller as the
  permanent VALIDATE stage).

**Decision: PROCEED.** Architecture route C (markdown + SQLite FTS5, TS+Bun,
single-binary deploys) is confirmed feasible end-to-end on real data.

**Open items deferred to spec/plan:**
- Evidence anchor format: keep `{#msg_id}` heading anchors (validated here).
- Salience threshold 6 worked on first try; make it configurable.
- `opencode run` as extraction backend is the dev-machine fallback; production
  distiller calls vLLM's OpenAI-compatible API directly (with `guided_json`).
