# VERIFY — parallel distiller

Status: HEADLESS 1-4 EXECUTED AND PASSING (2026-07-16). 5 PENDING USER.
Headless (executor MUST run):
1. bun test — green (incl. equivalence test).  2. typecheck clean.
3. Real A/B (opencode backend, scratch HOME, same 2 real transcripts):
   AGENT_MEMORY_CONCURRENCY=1 vs =2, fresh store each — record wall-clock
   for both and confirm summary counters match; spot-diff the two stores'
   memories/ trees (titles/types should match; exact text may vary with
   backend nondeterminism — this is the LLM, not the pipeline; note it).
4. AGENT_MEMORY_CONCURRENCY=banana → friendly error exit 1.
Interactive: 5. company vLLM: measure the real speedup at 8.

---

## Execution record (Task 4 executor, 2026-07-16)

1. `bun test` — **EXECUTED: PASS** (twice). 393 pass, 0 fail, 1427 expect()
   calls across 31 files, including the concurrency-equivalence test
   (`pipeline.test.ts: "EQUIVALENCE: concurrency 1 vs 4 produce
   byte-identical store trees…"`) and the new `AGENT_MEMORY_CONCURRENCY`
   CLI tests (bad-env friendly error on run AND reflect; `=2` smoke;
   other commands unaffected by a bogus value).
2. `bun run typecheck` — **EXECUTED: PASS** — `tsc --noEmit` produced no
   output.
3. Real A/B — **EXECUTED: PASS** (with the honesty caveat below).

   Setup: scratch `AGENT_MEMORY_HOME` per run, `AGENT_MEMORY_IDLE_HOURS=0`,
   default `opencode-run` backend (opencode 1.17.17, model
   `opencode/big-pickle`), same 2 real transcripts copied from
   `~/.agent-memory/transcripts/tmp/`:
   `ses_0b3d6dbf9ffezTmP2sFiMWgf4B.md` (2.8 KB, useful-skew-policy-reversal)
   and `ses_0b46ff7bfffe11gFC1EsTOEGBF.md` (10.8 KB, ppa-timing-closure).
   Fresh store each run. Command (per run):
   `time bun distiller/cli.ts run` with `AGENT_MEMORY_CONCURRENCY=1` / `=2`.
   Runs executed back-to-back, never overlapping, on the same idle machine.

   **Wall-clocks:**

   | Run | `AGENT_MEMORY_CONCURRENCY` | real | user | sys |
   |---|---|---|---|---|
   | A | 1 | **25m13.360s** | 11m16.942s | 2m26.279s |
   | B | 2 | **14m12.578s** | 9m49.596s | 1m55.090s |

   ≈ **1.78x speedup at concurrency 2** — real parallelism from the
   two-phase pipeline (both transcripts' Phase A ran side by side), even on
   the process-spawning dev backend.

   **Summary counters:**

   | Counter | A (=1) | B (=2) | Match? |
   |---|---|---|---|
   | scanned / eligible / already-done / triaged | 2 / 2 / 0 / 0 | 2 / 2 / 0 / 0 | yes |
   | errors | 0 | 0 | yes |
   | added / updated / superseded / nooped | 8 / 2 / 0 / 2 | 6 / 2 / 0 / 4 | no (LLM) |
   | quarantined / rejected | 4 / 2 | 3 / 1 | no (LLM) |
   | pool raw→deduped | 17→16 | 16→15 | no (LLM) |

   The pipeline-structural counters (scanned, eligible, already-done,
   triaged, errors) match exactly. The extraction-dependent counters do
   NOT match, and honestly cannot on this backend: `opencode-run` spawns a
   fresh nondeterministic agent per `complete()` call (no temperature
   control), so the two runs extracted overlapping-but-different candidate
   sets — this is the LLM varying between invocations, not the pipeline
   reordering anything. Pipeline-level determinism (1 vs N byte-identical
   store trees under a deterministic LLM) is what the mandatory
   equivalence test in `distiller/pipeline.test.ts` pins with a
   content-keyed FakeLlm, and it passes.

   **Store spot-diff (memories/ titles+types):** both stores converge on
   the same knowledge, modulo wording:

   | Theme | A (=1) | B (=2) |
   |---|---|---|
   | useful skew forbidden (convention) | "Useful skew is forbidden in signoff methodology" | "Useful skew forbidden when hold fixing is signoff-critical" |
   | MAC retiming pitfall | "Retiming across MAC accumulator boundary breaks functional semantics" | "Retiming through accumulator feedback boundary breaks semantics" |
   | synthesis-vs-PnR gap (root_cause) | "Synthesis-to-PnR timing correlation gap on wide multipliers (~60ps at advanced node)" | "Synthesis-to-PnR timing correlation gap on wide multipliers" |
   | LVT swap over upsizing (know_how) | "Prefer LVT cell swap over raw upsizing when hold margins are tight" | "Prefer LVT swap over upsizing when hold margins are tight" |
   | methodology-ban workflow | "Procedure for re-evaluating a timing methodology ban after tool qualification" | "Multi-technique timing closure workflow for MAC multiplier blocks" |
   | MAC pipeline decision | "No pipeline stages on MAC due to accumulator feedback path constraint" | "Retiming + LVT swap over pipeline for MAC multiplier timing closure" |
   | quarantine (decision, useful-skew ban reversal) | "Reversal of useful clock skew ban after CTS tool qualification" | "Reversed useful-clock-skew ban in timing methodology" |

   A additionally kept 2 entries B did not ("Enable physical-aware
   synthesis from the start for wide multipliers", "Retiming + selective
   LVT swap closes multiplier timing without latency or area penalty") —
   again extraction variance, both runs 8 vs 6 files under `memories/tmp/`
   plus 1 quarantine file each. Types line up theme-for-theme
   (convention / pitfall / root_cause / know_how / workflow / decision).
4. `AGENT_MEMORY_CONCURRENCY=banana` — **EXECUTED: PASS.**
   `AGENT_MEMORY_CONCURRENCY=banana bun distiller/cli.ts run` (scratch
   `AGENT_MEMORY_HOME`) printed
   `distiller: AGENT_MEMORY_CONCURRENCY must be a valid number (got "banana")`
   and exited **1**. Same message and exit code for `distill reflect`.
5. Interactive (company vLLM at concurrency 8) — **PENDING USER.**

**Observation for follow-up (not fixed in this task):** neither LLM client
in `distiller/llm.ts` has a per-call timeout — `createOpencodeRunClient`
awaits `proc.exited` unboundedly and `createVllmClient`'s `fetch` has no
AbortController. A single hung backend call therefore stalls the whole
pipeline (at any concurrency; with the limiter it also pins a permit
forever). Worth a small follow-up: per-call timeout + abort.
