# Review Loop + CJK Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `distill approve/reject` commands, SUPERSEDE interception for decision/convention memories (via a new `supersedes` field), and trigram FTS so CJK queries work.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-10-review-loop-cjk-design.md`. New module `distiller/reviewops.ts` (approve/reject); shared `distiller/quarantine.ts` (uniquified quarantine writes, extracted from pipeline); `supersedes` field threads through store/types; trigram migration lives in `MemoryIndex` with auto-rebuild at every storeDir-owning entry point.

**Tech Stack:** unchanged (TS + Bun, bun:test; no new dependencies).

## Global Constraints

- `supersedes` is the ONLY parse-optional frontmatter field (missing → `null`); everything else stays strict. Serializer always writes it.
- Never delete: reject = `status: archived` + dated note; approve of a superseding entry tombstones the target exactly like an automatic SUPERSEDE would.
- decision/convention SUPERSEDE never auto-applies; the other four types keep automatic supersession (regression tests required).
- index.db migration must be safe on a LIVE store: `PRAGMA user_version` gate; fresh DBs start at version 2; v<2 DBs get FTS dropped/recreated + `ftsRebuildNeeded=true`; every storeDir-owning entry point (cli dispatch, mcp main, probe) auto-runs `rebuildFrom` when flagged, notice on stderr.
- Trigram query rules: tokens ≥3 code points → MATCH; queries with NO ≥3-char token → LIKE fallback (per-token, per-column, OR-joined, `ORDER BY confidence DESC`, score 0). Mixed queries ignore the short tokens.
- Tests: per-test tmp dirs; poll, never sleep. All existing 109 tests must stay green (fixtures gain `supersedes: null` mechanically).
- Commits: conventional + the standard trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01ALAk5sCENNGXZyy6mSg8tF`

---

### Task 1: `supersedes` field through types + store

**Files:**
- Modify: `distiller/types.ts`, `distiller/store.ts`, `distiller/store.test.ts`
- Modify (mechanical fixture updates): `distiller/ledger.test.ts`, `distiller/reconcile.test.ts`, `mcp-server/query.test.ts`, `mcp-server/server.test.ts`, and `distiller/reconcile.ts` (`entryFromCandidate`), `distiller/pipeline.ts` (`quarantineEntry`) — anywhere a `MemoryEntry` literal is built, add `supersedes: null`.

**Interfaces:**
- `MemoryEntry` gains required `supersedes: string | null` (placed after `superseded_by`).
- `serializeEntry` always writes `supersedes: <enc>`; `parseEntry` reads it with a MISSING-line default of `null` (the one exemption from strict missing-field errors; wrong TYPE still throws).

- [ ] **Step 1: Write the failing tests** — in `distiller/store.test.ts`:
  - extend the round-trip entry list with `entry({ supersedes: "mem_target" })`;
  - new test "parseEntry defaults missing supersedes to null (legacy files)": take `serializeEntry(entry())`, delete the `supersedes: …` line with a regex, parse → `supersedes === null`, everything else intact;
  - new test "parseEntry rejects wrong-typed supersedes": replace the line with `supersedes: 42` → throws `/supersedes/`.
- [ ] **Step 2: Run** `bun test distiller/store.test.ts` → new tests FAIL (field unknown / strict parse).
- [ ] **Step 3: Implement** — `types.ts` field; `store.ts`: serializer line `supersedes: ${enc(e.supersedes)}` after `superseded_by`; parser: `const supersedes = fields.has("supersedes") ? fields.get("supersedes") : null` then validate `null | string`. Then chase compile errors across the repo adding `supersedes: null` to every `MemoryEntry` literal (production constructors AND test fixtures).
- [ ] **Step 4: Run** `bun test && bun run typecheck` → ALL green (109 + new).
- [ ] **Step 5: Commit** `feat(distiller): supersedes field with legacy-tolerant parsing`

---

### Task 2: trigram FTS migration + LIKE fallback in MemoryIndex

**Files:**
- Modify: `distiller/ledger.ts`, `distiller/ledger.test.ts`

**Interfaces:**
- `memories_fts` DDL gains `tokenize = 'trigram'`.
- Constructor migration: read `PRAGMA user_version`; if `< 2`: `DROP TABLE IF EXISTS memories_fts`, run DDL, `PRAGMA user_version = 2`, set `this.ftsRebuildNeeded = <memories row count > 0>`. Fresh DB: DDL then version 2, `ftsRebuildNeeded = false`.
- `readonly ftsRebuildNeeded: boolean` public field.
- `search()` gains the LIKE fallback: split tokens as today; partition into `long` (≥3 code points, use `[...t].length`) and `short`; if `long.length > 0` → MATCH path with `long` only (existing behavior otherwise unchanged); else if `short.length > 0` → LIKE path:
  ```sql
  SELECT m.path AS path, 0 AS score
  FROM memories_fts f JOIN memories m ON m.id = f.id
  WHERE (<per short token: (f.title LIKE ? OR f.trigger LIKE ? OR f.lesson LIKE ? OR f.domain LIKE ?)> OR-joined)
    AND <same metadata filter conds as MATCH path>
  ORDER BY m.confidence DESC LIMIT ?
  ```
  (params `%tok%` ×4 per token); else return [].

- [ ] **Step 1: Write the failing tests** — in `distiller/ledger.test.ts`:
  - "CJK content is searchable after trigram" — upsert an entry with `title: "時序收斂技巧"`, `lesson: "在慢角優先修 hold，時序收斂前先跑 retiming。"`; `idx.search("時序收斂")` → 1 hit; `idx.search("收斂技巧")` → 1 hit.
  - "two-char CJK query matches via LIKE fallback" — `idx.search("時序")` → 1 hit (score 0 acceptable); `idx.search("首都")` → 0 hits.
  - "migration from v1 schema flags rebuild" — build a db by hand: `new Database(path)`, run the OLD DDL (copy the previous `memories_fts` definition without trigram + the `memories`/`processed_sessions` DDL), insert one row into `memories` (any shape matching columns), set `PRAGMA user_version = 1`? (old dbs actually have version 0 — use 0: just don't set it), close. Then `new MemoryIndex(path)` → `ftsRebuildNeeded === true`; after `rebuildFrom(storeDir)` (seed the storeDir with one written entry first) → `search` works and a second `new MemoryIndex(path)` has `ftsRebuildNeeded === false`.
  - "fresh db needs no rebuild" — `new MemoryIndex(freshPath).ftsRebuildNeeded === false`.
- [ ] **Step 2: Run** → new tests FAIL (CJK query returns 0 today; no flag).
- [ ] **Step 3: Implement** per interfaces above.
- [ ] **Step 4: Run** `bun test && bun run typecheck` → all green (existing English search tests are the regression net).
- [ ] **Step 5: Commit** `feat(distiller): trigram fts with versioned migration and short-token like fallback`

---

### Task 3: auto-rebuild wiring at entry points

**Files:**
- Modify: `distiller/cli.ts`, `mcp-server/main.ts`, `mcp-server/probe.ts`
- Test: `distiller/cli.test.ts`

**Interfaces:**
- Shared pattern (3 call sites, keep it inline — it's 3 lines):
  ```ts
  const index = new MemoryIndex(join(cfg.storeDir, "index.db"))
  if (index.ftsRebuildNeeded) {
    console.error(`agent-memory: fts schema upgraded — rebuilding index from ${cfg.storeDir}`)
    await index.rebuildFrom(cfg.storeDir)
  }
  ```
  In `cli.ts` do it once where the index is created per command (extract a small `openIndex(cfg): Promise<MemoryIndex>` helper inside cli.ts to avoid repeating in all four commands).
- [ ] **Step 1: Write the failing test** — in `distiller/cli.test.ts`: build a v1-schema index.db (as in Task 2's migration test) inside a scratch `AGENT_MEMORY_HOME` whose store contains one valid written entry; run `runCli(["stats"], env, deps)` → exit 0, stats show the entry (byStatus counts 1), and err output contains "rebuilding index".
- [ ] **Step 2: Run** → FAIL (stats sees 0 / no rebuild notice).
- [ ] **Step 3: Implement** (cli helper + main.ts + probe.ts).
- [ ] **Step 4: Run** `bun test && bun run typecheck` → green. Also smoke: `AGENT_MEMORY_HOME=$(mktemp -d) bun run mcp:probe --stats` still exits 0.
- [ ] **Step 5: Commit** `feat(distiller): auto-rebuild fts index at entry points after schema upgrade`

---

### Task 4: quarantine helper + SUPERSEDE interception

**Files:**
- Create: `distiller/quarantine.ts`
- Modify: `distiller/pipeline.ts` (use the helper), `distiller/reconcile.ts`
- Test: `distiller/quarantine.test.ts`, `distiller/reconcile.test.ts` (extend), `distiller/pipeline.test.ts` (regression only — should stay green)

**Interfaces:**
- `distiller/quarantine.ts`:
  ```ts
  import type { MemoryIndex } from "./ledger"
  import type { MemoryEntry } from "./types"
  /** Writes e under quarantine/ with id uniquified against BOTH the filesystem
   *  and the index (-2/-3… suffix convention); upserts the index; returns the
   *  final entry (id may differ from input). */
  export async function writeQuarantineEntry(storeDir: string, index: MemoryIndex, e: MemoryEntry): Promise<MemoryEntry>
  ```
  Extracted from the inline logic in `pipeline.ts` (which then calls it — behavior identical; existing pipeline quarantine tests are the regression net).
- `distiller/reconcile.ts`:
  - `ReconcileDeps` unchanged (has index/storeDir/now already).
  - SUPERSEDE branch: `if (target.entry.type === "decision" || target.entry.type === "convention")` → build the pending entry from the candidate (`entryFromCandidate` + overrides `status: "quarantined"`, `review: "human_pending"`, `supersedes: decision.target_id`, note `<date>: pending review — proposes to supersede <target_id>: <reason>`), `writeQuarantineEntry`, return `{ op: "SUPERSEDE_PENDING", entry }`. Target untouched.
  - Return type: `Promise<{ op: ReconcileOp["op"] | "SUPERSEDE_PENDING"; entry?: MemoryEntry }>`.
- `distiller/pipeline.ts`: reconcile result switch gains `SUPERSEDE_PENDING` → `summary.quarantined++` (NOT counted in `n_committed`).

- [ ] **Step 1: Write the failing tests**
  - `distiller/quarantine.test.ts`: uniquify against existing quarantine file AND against an index-known id (mirrors the two collision classes already covered in pipeline tests — plus assert returned entry id reflects the suffix).
  - `distiller/reconcile.test.ts` additions:
    - "SUPERSEDE against decision-type target is intercepted": seed active decision entry; fake LLM returns SUPERSEDE targeting it → result op `SUPERSEDE_PENDING`; target still `status: "active"`, `superseded_by: null`, file unchanged; a quarantine file exists whose parsed entry has `supersedes: <target id>`, `status: "quarantined"`, `review: "human_pending"`, and a note containing "pending review".
    - "SUPERSEDE against convention-type target is intercepted" (same shape, minimal).
    - regression: the existing pitfall-type SUPERSEDE test stays exactly as-is (auto-supersession).
  - `distiller/pipeline.test.ts`: no new tests required; suite must stay green after the helper extraction.
- [ ] **Step 2: Run** → new tests FAIL.
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Run** `bun test && bun run typecheck` → all green.
- [ ] **Step 5: Commit** `feat(distiller): intercept decision/convention supersession into review queue`

---

### Task 5: reviewops (approve / reject) + CLI + review listing

**Files:**
- Create: `distiller/reviewops.ts`
- Modify: `distiller/cli.ts`
- Test: `distiller/reviewops.test.ts`, `distiller/cli.test.ts` (extend)

**Interfaces:**
- `distiller/reviewops.ts`:
  ```ts
  export interface ApproveResult { entry: MemoryEntry; movedTo: string | null; supersededTarget: string | null; warning?: string }
  export async function approveEntry(storeDir: string, index: MemoryIndex, id: string, now?: Date): Promise<ApproveResult>
  export async function rejectEntry(storeDir: string, index: MemoryIndex, id: string, reason?: string, now?: Date): Promise<MemoryEntry>
  ```
  - Both throw descriptive errors when: id unknown (`getById` miss) or entry not pending (`review !== "human_pending"` or `status === "archived"`).
  - `approveEntry`:
    1. `status: "active"`, `review: "human_approved"`, confidence = `computeConfidence({ sessions: new Set(evidence.map(e=>e.session)).size, humanApproved: true, contradicted: false })`, note `<date>: approved by human`.
    2. If `entry.supersedes`: look up target via `getById`; found → tombstone (`status: "superseded"`, `superseded_by: <entry.id — the FINAL id after any move-rename>`, note, `updated_at`, write + upsert); missing → `warning: "supersede target <id> not found — approved without tombstoning"` (stderr at CLI layer).
    3. If current path is under `<storeDir>/quarantine/`: move to `entryPath(storeDir, entry)`; on collision (file exists OR `getById(entry.id)` finds a DIFFERENT path) uniquify id with `-2/-3…`, set `entry.id`, recompute destination. Write destination, `unlink` the quarantine file, `index.removeEntry(<old id>)` if the id changed, upsert new. `movedTo` = destination (null when it already lived in memories/).
    4. Order note: perform the move/rename BEFORE tombstoning so `superseded_by` records the final id.
  - `rejectEntry`: `status: "archived"`, note `<date>: rejected by human — <reason ?? "not specified">`, `updated_at`; file stays in place; upsert.
- `distiller/cli.ts`:
  - `approve <id>` / `reject <id> [--reason <text>]` commands wired to reviewops via the existing `openIndex` helper; success prints one line (`approved <id> → <path>` / `rejected <id>`); reviewops throws → existing catch prints friendly error, exit 1.
  - `review` listing updated: an entry is PENDING iff `review === "human_pending" && status !== "archived"`; both scan loops apply this filter (archived rejects disappear; SUPERSEDE_PENDING entries show). Keep per-file corrupt tolerance.
  - Usage line gains the new commands.

- [ ] **Step 1: Write the failing tests**
  - `distiller/reviewops.test.ts`:
    - approve of a quarantined entry (no supersedes): file moved into `memories/<project>/`, quarantine file gone, `status active`, `review human_approved`, confidence `0.7` (single session 0.5 + 0.2), searchable via `index.search`.
    - approve with `supersedes` pointing at a seeded active decision entry: target becomes `superseded` with `superseded_by` = approved id; approved entry active.
    - approve with `supersedes` pointing at a missing id: approves, `warning` set, no throw.
    - approve id collision: pre-seed an ACTIVE entry at the destination id; approve → approved entry gets `-2` suffix, both exist, original untouched.
    - reject: `status archived`, note contains the reason, file still under quarantine/, `search` (status active) does not return it.
    - guards: unknown id throws /not found/; approving an already-active entry throws /not pending/; rejecting twice throws /not pending/.
  - `distiller/cli.test.ts` additions:
    - seed a quarantined pending entry (write file + upsert); `runCli(["review"], …)` output contains its id; `runCli(["approve", id], …)` exit 0 + output contains "approved"; second `review` prints "quarantine empty"; `runCli(["approve", id], …)` again → exit 1 (not pending).
    - `runCli(["reject", "mem_nope"], …)` → exit 1, err contains "not found".
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Run** `bun test && bun run typecheck` → all green.
- [ ] **Step 5: Commit** `feat(distiller): approve and reject commands close the human review loop`

---

### Task 6: docs + VERIFY

**Files:**
- Modify: `README.md`, `LLM_WIKI.md`
- Create: `docs/superpowers/VERIFY-review-cjk.md`

- [ ] **Step 1: README** — Review workflow section (`distill review/approve/reject` with a worked example incl. the decision-supersede flow), trigram note (CJK queries; 2-char LIKE fallback; index auto-rebuild on first run after upgrade; English substring side effect).
- [ ] **Step 2: LLM_WIKI（繁中）** — 審查流程章節（三個斷頭路如何被關閉、supersedes 欄位語義、decision/convention 攔截規則）、CJK 檢索章節（trigram 規則、2 字 LIKE fallback、混合查詢忽略短 token、索引自動重建）；把先前「CJK 無法檢索」的陷阱條目改為「已解決（trigram），剩混合查詢短 token 忽略」。
- [ ] **Step 3: VERIFY-review-cjk.md** —
  ```markdown
  # VERIFY — review loop + CJK (enhancement 2+6)

  Status: PENDING

  Headless (executor MUST run):
  1. bun test — all green.  2. bun run typecheck — clean.
  3. Real store: first `bun run distill stats` after upgrade prints the fts
     rebuild notice once; second run does not; counts match pre-upgrade.
  4. Real store CJK: add nothing — `bun run mcp:probe "時序"` returns [] without
     error (store content is English; the point is no crash + LIKE path).
  5. Real review flow: craft a session proposing to reverse the useful-skew ban
     (decision type), distill → `distill review` shows a SUPERSEDE_PENDING entry
     with supersedes: mem_20260710_8cd55e; `distill reject <id> --reason "still
     banned"` → old rule stays active; agent query still answers "forbidden".

  Interactive (user):
  6. Approve path on a real quarantined entry when one appears naturally.
  ```
- [ ] **Step 4: Gates** — `bun test && bun run typecheck` green.
- [ ] **Step 5: Commit** `docs: review workflow, cjk search notes, and verification checklist`
