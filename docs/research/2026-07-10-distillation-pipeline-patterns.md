# Consolidation/Distillation Stage Design Patterns for AI Agent Memory Systems

## Research Report — Offline Batch Distillation of Coding-Agent Logs into Durable Knowledge (2025–2026 state of practice)

Context assumed throughout: nightly/cron batch pipeline, self-hosted vLLM (OpenAI-compatible), opencode conversation logs from semiconductor/IC-design engineers, outputs feeding an MCP query tool + markdown wiki.

---

## 1. Reflection / Consolidation Techniques — the canonical patterns

### 1.1 Generative Agents reflection trees (Stanford, 2023 — still the baseline pattern)
- Memory stream = append-only log of natural-language records with `created_at`, `last_accessed`, and an LLM-rated **importance score (1–10)**.
- **Reflection trigger**: when the sum of importance scores of recent events exceeds a threshold (150 in the paper) — i.e., reflect on *accumulated salience*, not wall-clock time. For a batch pipeline: trigger a "higher-order reflection" pass when enough new memories about a topic accumulate.
- **Reflection procedure**: (1) ask the LLM "given these N recent records, what are the 3 most salient high-level questions?", (2) retrieve evidence per question, (3) generate insights **with citations to the source records**. Insights are written back as first-class memories, so reflections can reflect on reflections — a tree of increasing abstraction with provenance pointers down to raw observations.
- Retrieval score = `α·recency + β·importance + γ·relevance` — worth copying for the MCP query tool ranking.
- **Transferable pattern**: two-level distillation. Level 1 extracts atomic facts/lessons per session; Level 2 (weekly) reflects across Level-1 memories to produce synthesized "insight" entries that cite Level-1 IDs. This is exactly what a wiki page wants as input.

### 1.2 Letta sleep-time compute (2025)
- **Dual-agent split**: a primary agent serves live traffic; a *sleep agent* runs asynchronously and is the **only writer** to the memory blocks the primary agent reads. This single-writer discipline eliminates write races and lets consolidation be non-blocking and "anytime" — the primary always reads the latest committed state.
- Core framing: sleep-time reasoning converts **"raw context" into "learned context"** — clean, concise, reorganized memory — so runtime agents don't repeat reasoning.
- **Model asymmetry**: fast/cheap model online, **stronger/slower model for the sleep agent** because it has no latency constraint. The batch job can afford the largest vLLM-hosted model (or higher reasoning-effort settings) precisely because it's offline. Frequency is a tunable cost/quality knob.
- Direct mapping: opencode sessions = primary agent traffic; the cron distiller = the sleep agent; MCP-served memory files = the shared memory blocks.

### 1.3 Mem0 two-phase extract-then-reconcile loop (the most-copied production pattern)
- **Phase 1 — Extraction**: input = latest exchange + rolling summary + last *m* messages; LLM emits a small set of **candidate facts** (concise natural-language memories).
- **Phase 2 — Update**: for each candidate, retrieve top-*s* semantically similar existing memories, then have the LLM choose exactly one operation via **tool/function calling** (not free text):
  - **ADD** — no semantically equivalent memory exists
  - **UPDATE** — augment/refine an existing memory (keep its ID)
  - **DELETE** — new information contradicts an existing memory
  - **NOOP** — nothing new
- Key insight: **never let extraction write directly to the store**. The reconciliation step against retrieved neighbors is what keeps the store coherent, deduplicated, and contradiction-free over thousands of sessions. Mem0's update prompt is customizable — write a domain-specific one (see §2).
- Mem0 reports ~26% accuracy improvement over full-context baselines with far fewer tokens; the paper (arXiv 2504.19413) includes the actual prompts.

### 1.4 Hierarchical summarization (MemoryBank, TiMem, and others)
- Pyramid: raw turns → per-session summary → daily/weekly event summaries → global profile/portrait. Each layer is regenerated from the layer below, never from raw logs, keeping cost bounded.
- Caution from 2026 practice (Hindsight/vectorize): the old LangChain-style **"summarize-and-drop" is considered deprecated** — lossy summaries destroy retrievable detail. Preferred: keep raw transcripts immutable on disk, store *fact-level* extractions, and use summaries only as navigational overviews (perfect fit for wiki index pages).

### 1.5 Forgetting curves (MemoryBank) and decay
- MemoryBank applies **Ebbinghaus exponential decay**: each memory has a strength `S`; retention `R = e^(−t/S)`; every recall event increases `S` (spaced-repetition style), so used memories persist and unused ones fade below a retrieval threshold.
- Known limitation: time+recall-frequency is one-dimensional; newer work adds importance/novelty weighting. Practical 2026 consensus (Hindsight): **apply decay only to temporally volatile claims** ("we're on PDK v1.2", "the flow currently breaks on tool X") — *not* to timeless lessons ("negative setup slack on this corner usually means the SDC constraint is wrong"). Tag entries `volatile: true/false` at extraction time and decay only volatile ones.
- memtrace (coding-agent memory product) ships "**confidence decay**: recalled memories stay fresh, stale ones fade" plus a `scan` command that **flags memories whose source files changed** — an excellent, cheap invalidation signal for code-linked memories.

### 1.6 Zettelkasten linking — A-MEM (NeurIPS 2025)
- Each memory is an **atomic note** with structured attributes: content, contextual description, keywords, tags, embeddings.
- **Link generation**: on insert, retrieve nearest historical notes and let the LLM decide which links are meaningful (not just cosine-threshold edges).
- **Memory evolution**: inserting a new note can trigger the LLM to *rewrite the context/tags of existing linked notes* — old memories get refined by new experience rather than only superseded.
- For wiki output this is gold: A-MEM notes ≈ wiki pages with "See also" links; memory evolution ≈ the batch job amending existing wiki pages when new sessions add nuance.

### 1.7 ExpeL — insight lists with voting (best fit for "lessons" quality control)
- Collects **success and failure trajectories**, then compares success/failure pairs to extract *why* things worked. Maintains a numbered list of insights edited via **ADD / UPVOTE / DOWNVOTE / EDIT** operations; insights that keep getting downvoted fall out.
- The upvote counter doubles as a natural **confidence score**: a lesson independently re-derived from 5 different sessions is trustworthy; a one-off observation is tentative. Contrasting failed-then-succeeded debugging sequences is *the* highest-signal extraction target in coding logs.

---

## 2. What to EXTRACT from coding-agent conversations (and what to discard)

### 2.1 The signal taxonomy that recurs across systems
Survey work ("Memory in the Age of AI Agents", arXiv 2512.13564) splits distillation targets into **factual memory** (declarative, verifiable facts about the environment/codebase/user) and **experiential memory** (strategies distilled from trajectories: planning principles from successes, corrective signals from failures). Concretely, for coding-agent logs the high-value categories seen across memtrace, agentmemory, ExpeL, and the ECC "instinct" system:

| Extract (durable) | Discard (noise) |
|---|---|
| **Decisions + rationale** ("chose approach A over B because…", esp. when user overrode the agent) | Transient task chatter, greetings, planning back-and-forth |
| **Debugging root causes**: error signature → root cause → fix (the *resolved* end of a debug arc) | Intermediate failed hypotheses (except as contrast in the lesson) |
| **Pitfalls / gotchas**: "X looks like it should work but fails because Y" | Raw stack traces, full tool outputs |
| **User corrections** ("no, use X instead") — highest-signal single event type | File contents pasted into context (they live in git, not memory) |
| **Domain know-how** (IC-specific: tool-flow quirks, PDK/corner conventions, EDA CLI incantations, constraint idioms) | Boilerplate code, generated scaffolding |
| **Tool usage tricks**: non-obvious flags, env setup, "API quirks and successful subroutines" | Anything reproducible from docs in one lookup |
| **Conventions/preferences**: naming, style, review norms observed repeatedly | One-off stylistic accidents |
| **Repeated workflows** (same tool sequence ≥2–3 times → procedural memory candidate) | Single occurrences of a sequence |

### 2.2 Published pattern-detector design (ECC continuous-learning-v2 "observer")
A shipped, coding-agent-specific design (installed locally at `~/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.9.0/skills/continuous-learning-v2/`) uses a cheap background model over an `observations.jsonl` event log and looks for exactly four patterns:
1. **User corrections** → "when doing X, prefer Y"
2. **Error resolutions** (error output followed by fix, same error resolved similarly multiple times) → "when encountering error X, try Y"
3. **Repeated workflows** (same tool sequence, files that change together) → procedural instinct
4. **Tool preferences** (consistently grep-before-edit, etc.)

Each yields an atomic **"instinct"** (YAML: `id`, `trigger`, `confidence 0.3–0.9`, `domain`, `source`, `scope: project|global`, plus Action + Evidence sections). Notably it solves cross-project contamination via **project-scoped storage with promotion to global only when a pattern is seen in 2+ projects** — directly relevant when engineers work across multiple IC projects.

### 2.3 A distillation-prompt skeleton that works (synthesized from Mem0/D-Mem/ExpeL practice)
Published extraction prompts converge on: extractor-as-parser (reduces hallucination vs. free reasoning), strict JSON, per-item salience scoring with a cutoff, and explicit negative instructions. Skeleton for the vLLM job:

```text
You are a knowledge distiller for an IC-design engineering team. You will read one
complete AI-coding-agent session transcript. Extract ONLY durable engineering
knowledge a colleague would want six months from now.

Extract items of these types:
- decision: a technical choice plus the rationale (especially user overrides of the agent)
- root_cause: error/symptom -> underlying cause -> verified fix
- pitfall: something that looks right but fails, and why
- know_how: domain/tool knowledge (EDA flows, PDK conventions, scripts, flags)
- convention: a team/project preference the user enforced or repeated
- workflow: a multi-step procedure that was executed successfully and is reusable

Do NOT extract: file contents, boilerplate, transient task details, anything true
only for this one task, secrets/credentials (flag them instead), or knowledge
obvious from public documentation.

Rules:
- Each item must be atomic (one lesson), self-contained (understandable without
  the transcript), and cite the message/turn IDs it came from.
- Write lesson text as an imperative or conditional ("When X, do Y because Z").
- Score salience 0-10; emit only items scoring >= 6.
- If the session contains a failed attempt later corrected, extract the CONTRAST
  (what was wrong, what fixed it), not the failure alone.
- Mark volatile=true if the fact can go stale (tool versions, current bugs, WIP state).

Output: strict JSON array conforming to the provided schema. If nothing qualifies,
output [].
```

D-Mem-style salience gating (only keep score ≥ threshold) is the single most effective anti-noise lever; Graphlit and Mem0 docs both stress "over-extraction creates noise — focus on decisions, tasks, ownership, dependencies."

**Practical vLLM note**: use structured output (vLLM supports `guided_json` / `response_format: json_schema`) so schema conformance is enforced by the decoder, and still schema-validate per field afterward (consistent with the house rule about validating LLM output before it enters structured data).

---

## 3. Schema design for engineering-knowledge memory entries

### 3.1 Memory typing: episodic vs semantic vs procedural
The 2025–2026 convergence (CoALA lineage, MIRIX, Memanto, LangGraph docs):
- **Episodic** — "what happened": session summaries, specific debug incidents, timestamped. Substrate from which the other two are derived; consolidation = episodic → semantic ("identifying patterns across interactions and distilling them into reusable knowledge").
- **Semantic** — "what is true": facts about the codebase, tools, domain; the bulk of the wiki.
- **Procedural** — "how to do": workflows, runbooks, checklists; MIRIX notes these encode user habits/scripts. Voyager's lesson applies: store procedures as close to **executable/verbatim form** (commands, scripts) as possible — retrieval by description, execution deterministic.
- MIRIX (arXiv 2507.07957) adds three more worth stealing: **Resource** (pointers to documents/transcripts), **Knowledge Vault** (verbatim sensitive strings — here: *exclude/redact*, since fab/PDK data is sensitive), and **Core** (always-in-context profile — analogous to a per-engineer/per-project header block).

Keep episodic entries (one per session) even though semantic/procedural entries are the product: they are the provenance anchors and the input to weekly cross-session reflection.

### 3.2 Recommended memory-entry schema (synthesized)
Combining Mem0 (fact + reconciliation), A-MEM (notes + links + evolution), Zep/Graphiti (bi-temporal validity), ECC instincts (trigger/confidence/evidence/scope), and MemLineage (provenance):

```jsonc
{
  "id": "mem_2026-07-08_a3f9c1",          // stable ULID
  "memory_class": "semantic",              // episodic | semantic | procedural
  "type": "root_cause",                    // decision | root_cause | pitfall |
                                           // know_how | convention | workflow | profile
  "title": "Hold violations after ECO route come from stale SPEF, not the ECO",
  "trigger": "when hold slack degrades immediately after an ECO route step",
  "lesson": "Re-extract parasitics before re-running STA after any ECO route; the flow's default reuses the pre-ECO SPEF, producing phantom hold violations.",
  "context": {
    "project": "chip-alpha",               // scope key; enables project->global promotion
    "scope": "project",                    // project | team | global
    "domain": ["sta", "eco-flow", "primetime"],
    "tools": ["PrimeTime 2025.06", "Innovus"],
    "applies_when": "block-level ECO flows using the shared signoff scripts"
  },
  "evidence": [
    { "session_id": "oc_sess_8821", "turn_ids": [42, 57, 63],
      "kind": "debug_resolution", "observed_at": "2026-07-08T02:11:00Z" },
    { "session_id": "oc_sess_9004", "turn_ids": [12],
      "kind": "user_confirmation", "observed_at": "2026-07-15T09:40:00Z" }
  ],
  "confidence": 0.7,                        // starts 0.3-0.5; +evidence -> up; contradiction -> down
  "volatile": false,                        // decay applies only if true
  "temporal": {                             // Zep/Graphiti bi-temporal pattern
    "valid_at": "2026-07-08T02:11:00Z",     // when the fact became true
    "expired_at": null,                     // set when superseded
    "invalid_at": null                      // set when explicitly contradicted
  },
  "links": [
    { "rel": "refines", "target": "mem_2026-05-14_77b2e0" },
    { "rel": "contradicts", "target": null },
    { "rel": "see_also", "target": "mem_2026-06-02_1c4d55" }
  ],
  "lifecycle": { "status": "active",        // candidate | active | superseded | quarantined | archived
                 "superseded_by": null, "review": "auto" },  // auto | human_pending | human_approved
  "provenance": {
    "extractor": "distill-pipeline v0.3 / qwen3-32b@vllm",
    "prompt_hash": "sha256:...",            // reproduce/audit any entry
    "source_transcript": "logs/2026-07-08/oc_sess_8821.jsonl",
    "derivation": ["extracted", "merged:mem_..."],  // lineage through merges
    "created_at": "2026-07-09T03:00:12Z",
    "updated_at": "2026-07-16T03:00:41Z",
    "access_count": 4, "last_accessed": "2026-07-20T11:02:00Z"
  }
}
```

Field-selection rationale from the literature:
- **`trigger` separate from `lesson`** (ECC instincts): triggers are what the MCP retrieval matches against; lessons are what gets injected.
- **`evidence[]` with turn-level pointers** (Generative Agents citations; MemLineage "lineage-complete provenance tracing back to the originating write event through any intermediate summarization or merging steps"). Non-negotiable for trust and for debugging bad extractions.
- **Bi-temporal `valid_at/expired_at/invalid_at`** (Zep/Graphiti): distinguishes "when true in the world" from "when we learned it"; enables non-destructive supersession.
- **`confidence` as evidence-weighted, not LLM-vibes**: derive it deterministically — e.g., `0.4 + 0.15·(independent_sessions−1) + 0.1·human_confirmed − 0.2·contradicted`, capped [0.1, 0.95]. The ECC system's 0.3–0.9 band with promotion thresholds (auto-apply ≥0.7, suggest 0.5–0.7, log-only <0.5) is a sane default.
- **`access_count`/`last_accessed`**: fuels both MemoryBank-style reinforcement and retrieval ranking.

Markdown-wiki projection: store canonical entries as JSON (SQLite is the standard choice — memtrace uses a local SQLite DB with hybrid BM25+vector search), and *render* wiki pages per `type` × `domain`, with entry IDs as anchors and evidence links back to transcripts. Never hand-edit generated pages; if humans edit, treat the wiki as a second source feeding back through the reconciler.

---

## 4. Batch/scheduled pipeline design

### 4.1 Reference architecture (nightly cron)

```
opencode session logs (immutable, append-only)
   │
   ├─ 0. INGEST      enumerate sessions; skip if session_id in processed ledger
   │                 (idempotency key = session_id + content_hash; only sessions
   │                  idle > N hours are eligible — a session is the natural batch unit)
   ├─ 1. TRIAGE      cheap pass (small model or heuristics): does this session contain
   │                 any extraction-worthy events? (corrections, resolved errors,
   │                 decisions, repeated workflows) — most sessions yield nothing; skip.
   ├─ 2. EXTRACT     big model, guided_json → candidate memories with evidence pointers
   ├─ 3. VALIDATE    deterministic: schema per-field, evidence turn-IDs exist in the
   │                 transcript, no secrets (regex + entropy scan), length/atomicity caps
   ├─ 4. RECONCILE   per candidate: embed → retrieve top-s neighbors from store →
   │                 LLM tool-call chooses ADD / UPDATE / SUPERSEDE / NOOP (Mem0 loop)
   ├─ 5. COMMIT      transactional write; ledger row (session_id, watermark, op counts);
   │                 candidates below auto-threshold → human-review queue
   ├─ 6. REFLECT     (weekly) cluster active memories per domain; generate cross-session
   │                 insights citing member IDs (Generative-Agents level-2); propose
   │                 merges of near-duplicates; promote project→global (seen in 2+ projects)
   └─ 7. PUBLISH     regenerate embeddings index for MCP tool; render markdown wiki;
                     decay/prune sweep (volatile entries, quarantine expiries)
```

### 4.2 Idempotency and watermarks (standard data-engineering practice applied)
- **Checkpoint** = durable record of progress ("crash, restart, continue without guessing what already landed"); **watermark** = the boundary between processed/unprocessed, here best keyed on **session end-time + session_id**, not file mtime.
- Keep a `processed_sessions` ledger table: `(session_id, content_hash, processed_at, pipeline_version, extractor_model, n_candidates, n_committed)`. Re-running is safe: same session_id+hash → skip; changed hash (session resumed) → reprocess *delta turns only* if a per-session turn watermark is stored, or reprocess whole session and let the reconciler NOOP the already-known facts — **the Mem0 reconcile step is itself the idempotency backstop**, since re-extracted duplicates resolve to NOOP/UPDATE rather than duplicate ADDs.
- Record `pipeline_version`/`prompt_hash` in the ledger to deliberately re-run history after a prompt upgrade (bump version → watermark resets for reprocessing, reconciler prevents duplication).

### 4.3 Multi-session topics
- Don't force cross-session synthesis at extraction time. Extract per-session; let the **reconcile step** naturally accrete evidence onto the same memory (UPDATE appends a new evidence row → confidence rises), and let the **weekly reflect step** do explicit clustering (embedding-cluster active memories per domain, then LLM-synthesize a parent insight linking children — the reflection-tree/A-MEM evolution pattern). Session-resume in opencode (same session continued next day) is handled by the turn-level watermark above.

### 4.4 Conflict resolution when new experience contradicts old memory
Consensus across Zep/Graphiti, Hindsight, and the deterministic-freshness paper (arXiv 2606.01435):
- **Never delete — supersede.** Non-destructive supersession: mark old entry `expired_at` + `superseded_by`, keep it queryable for history ("full temporal reconstruction"). Git-trained instincts apply: memory store as append-mostly with tombstones.
- **Don't ask the LLM to judge freshness.** Use deterministic metadata rules: detect the conflict semantically (LLM or embedding similarity flags "these two claims address the same thing and disagree"), then resolve by **fixed policy**: recency-wins for state changes ("we migrated to PDK v2"), source-wins where a trust hierarchy exists (human-confirmed > human-authored wiki edit > LLM-extracted), confidence-wins otherwise.
- **Three-way resolution options** (Memanto): *supersede*, *retain*, or *annotate* — keep both with a conflict flag routed to human review. Use annotate whenever the two claims have comparable confidence and the domain is high-stakes (signoff flows, tapeout checklists) — MemoryAgentBench found all current systems still fail multi-hop conflict scenarios, so punting ties to humans is the honest design.

### 4.5 Human-review gates
Three-tier gate (matches ECC instinct thresholds and enterprise-memory governance):
1. **Auto-commit**: confidence ≥ 0.7, no conflict, passes validation → active immediately (still fully reversible via supersession).
2. **Review queue**: 0.4–0.7, or any conflict-annotate, or type = `convention`/`decision` (these encode team policy and deserve a human eye). Surface as a daily digest or PR against the wiki repo — **memory-as-PR is a strong pattern here**: reviewers see diffs, provenance links, and can approve/reject with normal git tooling; approval sets `review: human_approved` and bumps confidence.
3. **Quarantine**: failed validation, possible secret, or contradicts a human-approved memory → never served by MCP until a human acts.

---

## 5. Quality control — keeping LLM-extracted memories from polluting the store

The 2026 security/governance literature (MemGuard, MemLineage, SSGM, memory-lifecycle surveys) plus production systems converge on defense-in-depth:

1. **Gate at write time, not read time** (Hindsight's "importance lever"): salience threshold in the extraction prompt + deterministic validators. An entry that never enters the store can't pollute retrieval.
2. **Deterministic validation before commit**: JSON-schema per field (existing house rule); evidence pointers must resolve to real transcript turns (kills hallucinated memories — if the LLM can't cite where it learned it, reject); atomicity caps (one lesson, ≤ ~80 words of lesson text); secret/PII scan (critical in a fab/IP environment — API keys, netlist paths, customer names).
3. **Dedup thresholds, two-stage**: embedding cosine ≥ ~0.92 → near-certain duplicate, auto-NOOP/merge; 0.75–0.92 → give to the reconciler LLM to decide ADD vs UPDATE (the Mem0 zone); < 0.75 → distinct. Tune on a labeled sample from real logs; also run a periodic offline near-dup sweep (pairwise within clusters) because write-time dedup misses drift.
4. **Provenance on every entry** (MemLineage: "queryable, lineage-complete provenance tracing back to the originating write event through any intermediate summarization or merging steps"). Any bad memory found later can be traced to its source transcript and its merge lineage rolled back — plus taint-tracking: if one transcript is found bad (e.g., the agent hallucinated a "fix" that didn't work), everything derived from it can be bulk-quarantined.
5. **Evidence-weighted confidence + ExpeL-style voting**: single-session lessons stay tentative; contradiction from a later session downvotes; N independent confirmations promote. Serve the MCP tool only `status=active AND confidence >= 0.5` by default, with an opt-in flag for tentative memories.
6. **Decay and pruning as hygiene, not compression**: decay only `volatile` entries (Ebbinghaus-style, recall refreshes); memtrace-style **source-invalidation** — if a memory links files/scripts and those change, flag for re-verification; scheduled prune moves `confidence < 0.3 AND access_count = 0 AND age > 90d` to archive (never hard-delete except compliance).
7. **Closed-loop evaluation**: keep a small regression set of (query → expected memory) pairs from real engineer questions; run it after each pipeline change. The 2025–2026 empirical finding ("experience-following behavior", arXiv 2505.16067) is that agents *strongly follow* whatever memory is retrieved — including wrong memory — so store quality dominates retrieval quality; measure precision of what's served, not just recall.

---

## 6. Concrete recommendations for this stack (opencode + vLLM + MCP + wiki)

1. **Adopt the Mem0 loop as the pipeline spine** (extract → validate → reconcile via tool-call ADD/UPDATE/SUPERSEDE/NOOP), with Letta's asymmetry: this is the "sleep agent," so use the biggest vLLM model with `guided_json`. Add a cheap triage pass first — most coding sessions yield zero durable memories, and skipping them is where the cost savings live.
2. **Session = unit of work; ledger keyed on `(session_id, content_hash, pipeline_version)`** gives idempotency, watermarking, and safe prompt-upgrade reprocessing in one table. SQLite is sufficient and is what the coding-agent memory products (memtrace) ship.
3. **Use the 6-type engineering taxonomy** (`decision`, `root_cause`, `pitfall`, `know_how`, `convention`, `workflow`) layered on the episodic/semantic/procedural classes, with the schema in §3.2. The existing `DEV_HABITS_AND_PITFALLS.md` / `recurring-pitfalls` structure is essentially hand-built ExpeL — the pipeline should target producing entries of exactly that shape automatically.
4. **Project-scoped by default, promote to global on 2+ project sightings** (ECC v2.1 pattern) — IC teams have per-chip/per-PDK knowledge that must not leak across projects, plus genuinely universal flow knowledge that should.
5. **Bi-temporal supersession + deterministic freshness rules; never delete; annotate-and-review on ties.** Route `decision`/`convention` types and all conflicts through a wiki-PR human gate.
6. **Evidence pointers are the integrity backbone**: reject any extraction that can't cite transcript turns; keep raw transcripts immutable; render the wiki from the store, never as the source of truth.

## Sources
- [Letta — Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute/) · [Letta — Agent Memory](https://www.letta.com/blog/agent-memory/) · [Fast Company on sleep-time compute](https://www.fastcompany.com/91368307/why-sleep-time-compute-is-the-next-big-leap-in-ai)
- [Mem0 paper (arXiv 2504.19413)](https://arxiv.org/html/2504.19413v1) · [Mem0 custom update-memory prompt docs](https://docs.mem0.ai/open-source/features/custom-update-memory-prompt) · [Mem0 breakdown — Dwarves Memo](https://memo.d.foundation/breakdown/mem0)
- [A-MEM: Agentic Memory for LLM Agents (arXiv 2502.12110, NeurIPS 2025)](https://arxiv.org/abs/2502.12110) · [A-mem GitHub](https://github.com/WujiangXu/A-mem)
- [Generative Agents (arXiv 2304.03442)](https://ar5iv.labs.arxiv.org/html/2304.03442) · [Stanford architecture explainer](https://www.subodhjena.com/blog/generative-agents-memory-stanford)
- [MemoryBank (AAAI)](https://ojs.aaai.org/index.php/AAAI/article/view/29946) · [MemoryBank overview](https://www.emergentmind.com/papers/2305.10250) · [Ebbinghaus decay for agents (dev.to)](https://dev.to/sachit_mishra_686a94d1bb5/i-built-memory-decay-for-ai-agents-using-the-ebbinghaus-forgetting-curve-1b0e)
- [ExpeL: LLM Agents Are Experiential Learners (arXiv 2308.10144)](https://arxiv.org/abs/2308.10144) · [Voyager (arXiv 2305.16291)](https://arxiv.org/html/2305.16291)
- [Hindsight — The Consolidation Problem in Agent Memory](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation) · [Zep — Stop Using RAG for Agent Memory](https://blog.getzep.com/stop-using-rag-for-agent-memory/) · [Graphiti knowledge-graph memory (Neo4j blog)](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Deterministic memory conflict resolution (arXiv 2606.01435)](https://arxiv.org/pdf/2606.01435) · [Memanto typed semantic memory (arXiv 2604.22085)](https://arxiv.org/html/2604.22085v1)
- [MIRIX multi-agent memory (arXiv 2507.07957)](https://arxiv.org/abs/2507.07957) · [MIRIX memory components docs](https://docs.mirix.io/architecture/memory-components/)
- [Memory in the Age of AI Agents survey (arXiv 2512.13564)](https://arxiv.org/pdf/2512.13564) · [Experience-following behavior study (arXiv 2505.16067)](https://arxiv.org/pdf/2505.16067)
- [MemGuard (arXiv 2605.28009)](https://arxiv.org/html/2605.28009) · [MemLineage (arXiv 2605.14421)](https://arxiv.org/html/2605.14421) · [LLM memory security lifecycle survey (arXiv 2604.16548)](https://arxiv.org/pdf/2604.16548)
- [memtrace](https://github.com/memtrace-dev/memtrace) · [agentmemory](https://github.com/rohitg00/agentmemory) · [Graphlit fact-extraction glossary](https://www.graphlit.com/glossary/fact-extraction)
- [Idempotent data pipelines (Airbyte)](https://airbyte.com/data-engineering-resources/idempotency-in-data-pipelines) · [Checkpointing long-running agent tasks](https://www.agentcenter.cloud/blogs/how-to-checkpoint-ai-agent-progress)
- Local: ECC continuous-learning-v2 instinct schema at `~/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.9.0/skills/continuous-learning-v2/SKILL.md` and `agents/observer.md`
