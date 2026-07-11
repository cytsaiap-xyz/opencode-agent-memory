---
session_id: ses_0b46ff7bfffe11gFC1EsTOEGBF
project_dir: "/private/tmp"
title: "ppa-timing-closure"
model: "opencode/big-pickle"
time_start: 2026-07-10T10:25:58.336Z
time_end: 2026-07-10T10:27:21.221Z
turns: 7
tokens: { input: 21468, output: 2570 }
content_hash: sha256:959adb4702884fcc
exported_at: 2026-07-10T10:27:24.359Z
---
## T1 [10:25] User {#msg_f4b900948001TNzGUzJBMXWvYk}

"My block fails timing after place-and-route: WNS is -45ps on setup paths going through a 64-bit multiplier, but synthesis reported positive slack. I need to close timing without redoing the floorplan. What are my options and their PPA trade-offs?"

## T2 [10:25] Assistant {#msg_f4b900983001He4lDG3YEm5ijO}

This is a classic synthesis-vs-PnR timing gap. Here are your options, ordered roughly by effort/impact:

---

## 1. Register Slicing (Pipelining) the Multiplier

Cut the critical path with pipeline registers inside the multiplier's adder tree.

- **PPA**: +1 cycle latency, ~0% area, +small power (few flops). WNS swing can be **100–300 ps** depending on multiplier depth.
- **When**: Your synthesis clock constraint is right but the tool's post-place wire delays blew up the path. This is usually the **first fix**.
- **Caveat**: Functional change — verify no combinational dependency from output in same cycle.

## 2. Multiplier Architecture Switch

Synthesis may have chosen a single-cycle multiplier; PnR couldn't close it.

| Architecture | Latency | Area | Fmax |
|---|---|---|---|
| Single-cycle (Booth) | 1 | 1× | Worst |
| 2-stage pipelined | 2 | ~1.1× | Much better |
| Wallace/Dadda tree | 2–3 | ~1.2× | Best for wide |

- **PPA**: Trade latency for Fmax. A 64×64 Booth is ~30 FO4 delays — very hard to close in one cycle at high freq.
- **When**: Architecturally acceptable to add 1–2 cycles of latency.

## 3. Floorplan-Level Tweaks (Without Redoing)

You said "no redo," but targeted edits are different:

- **Pin placement**: Move inputs/outputs of the multiplier closer in the I/O plan. **Zero area cost.**
- **Cell grouping / Pblock**: Constrain the multiplier to a tight region near its data sources. Reduces wire length by 20–40%.
- **Buffer insertion**: Let the tool insert repeaters on long nets. Auto-fixes slew/degradation.
- **PPA**: Minimal area/power, no logic change. Often recovers **30–80 ps**.

## 4. High-Vt / Multi-Vt Optimization

If your library has HVT/SVT/LVT cells:

- **Move non-critical cells to HVT** → frees timing budget on critical path for LVT.
- **Force LVT on the critical path** cells only.
- **PPA**: ~5–15% leakage reduction overall, 0 area change. WNS recovery **10–30 ps**.

## 5. Clock Tree / Clock Uncertainty

- **Check**: Is your post-CTS clock uncertainty tighter than what synthesis assumed? PnR often adds skew pessimism.
- **Action**: Run `report_clock_timing` — if skew is eating 20+ ps, a better CTS or useful-clock-skew (UCT) could recover it.
- **PPA**: Zero cost.

## 6. Logic Restructuring

- **Rebalance the multiplier's adder tree** manually (if RTL-editable) — e.g., cut the longest carry chain, retiming across registers.
- **Constraint-driven**: Add `set_max_delay` or `set_multicycle_path` if the timing path has false/multicycle potential you didn't annotate.
- **PPA**: Depends on case. Multicycle paths are **free** if functionally valid.

---

## Decision Matrix

| Option | WNS Recovery | Latency | Area | Effort |
|---|---|---|---|---|
| Pipelining | ★★★★★ | +1–2 cyc | +1% | Low |
| Arch switch | ★★★★★ | +1–2 cyc | +10% | Medium |
| Pblock/pins | ★★★ | 0 | 0 | Low–Med |
| Multi-Vt | ★★ | 0 | 0 | Low |
| CTS tuning | ★★ | 0 | 0 | Low |
| Multicycle paths | ★★★★ | 0 | 0 | Low (if valid) |

**My recommendation for -45 ps WNS**: Start with **pipelining** (1 stage) + **multi-Vt swap** + **tighter pblock**. This trio typically closes 50+ ps with minimal disruption. If you're already pipelined, switch the multiplier architecture to a 2-stage Booth and re-floor the block placement.

## T3 [10:26] User {#msg_f4b9090b3001koqfdkfVsXINRp}

"We can't add a pipeline stage — we tried that last quarter and it broke the accumulator loop protocol (the MAC feedback path can't tolerate an extra cycle). Go with retiming plus upsizing the critical cells instead. Also note: useful skew is FORBIDDEN in our methodology — the signoff team banned it because it complicates hold fixing across our slow corners. That's a hard rule in our flow."

## T4 [10:26] Assistant {#msg_f4b90919e001neUk1zGhP9Z0tF}

Got it — hard constraints: no extra pipeline stages, no useful skew. Here's the retiming + upsizing plan with the MAC accumulator constraint in mind.

---

## Retiming the Multiplier (Without Adding Latency)

Retiming **moves** existing registers through combinational logic — same total latency, rebalanced critical paths.

### What to do:

**1. Retime across the multiplier's adder tree**

A 64-bit multiplier has ~6 levels of carry-save/adder logic. If there are already registers at the multiplier input and output, retiming can slide the input register *deeper* into the multiplier, splitting a 6-level path into 3+3.

- **Constraint**: The multiplier must have balanced register depth at both ends. Check your MAC — if the accumulator feedback register is on the output side, retiming *into* the multiplier is fine as long as the feedback loop's functional semantics are preserved.
- **Accumulator trap**: Retiming **cannot** push a register through the feedback adder back into the accumulator register. That changes the accumulate-before-store behavior. You can only retime *within* the multiplier's combinational cone, not across the accumulator boundary.

**2. Retime the MAC's input-side logic**

If there's register-to-register combinational logic *before* the multiplier (operand prep, alignment), retime can pull the input register forward, giving the multiplier a "free" extra register stage without changing the overall pipeline depth.

```
BEFORE: [REG] → 3-cycle combo (prep) → 3-cycle multiplier → [REG]  // critical path = 6
AFTER:  [REG] → 2-cycle combo (prep) → [retimed REG] → 4-cycle multiplier → [REG]  // critical path = 4
         ↑                                              ↑
    original register position              register slid through prep logic
```

**3. Retime the output-side accumulator path**

If the output of the multiplier feeds into an accumulator adder before the feedback register, retime the accumulator adder's register *back into* the multiplier output — splitting the multiplier+adder critical path.

---

## Cell Upsizing the Critical Path

Upsizing trades power and area for delay reduction. Be surgical — upsizing everything is wasteful.

### Strategy:

**Step 1 — Identify the critical cells**

Run `report_timing -to [get_pins ...]` and extract the cell instances on the worst path. Typically for a 64-bit multiplier, you'll see:
- 4–8 cells on the critical path (carry chain or CSA stages)
- Driver cells on nets with high fanout or long wire

**Step 2 — Upsize in tiers**

| Cell type | Upsize target | Expected gain | Power cost |
|---|---|---|---|
| Carry-chain buffers/inverters | Vt swap to LVT + size up 1 step | 15–25 ps/cell | +3–5% per cell |
| CSA/compressor cells | Size up 1–2 steps | 10–20 ps/cell | +5–8% per cell |
| Net drivers (high fanout) | Size up + add buffer | 5–15 ps | +2–3% |
| Clock gating / mux cells on path | Vt swap only | 10–15 ps | +1–2% |

**Step 3 — Bound the damage**

Set a **power budget** for upsizing:
```
# Example: limit total upsized cells to <5% of multiplier cell count
report_cell_usage -hierarchical [get_cells mult_*] -compare
```

Typical rule of thumb: upsizing **8–12 cells** on the critical path should recover **40–60 ps** without blowing power by more than ~8–12%.

---

## Combining Both: Expected Recovery

| Technique | WNS recovery (est.) | Area | Power | Latency |
|---|---|---|---|---|
| Retime (input side) | 20–40 ps | 0 | 0 | 0 |
| Retime (output accumulator split) | 15–30 ps | 0 | 0 | 0 |
| Cell upsizing (8–12 cells) | 40–60 ps | +2–5% | +8–12% | 0 |
| Vt swap on critical cells | 10–20 ps | 0 | −2% leakage | 0 |
| **Combined** | **~50–100 ps** | **+2–5%** | **+6–10%** | **0** |

Your -45 ps deficit should be comfortably closed with retiming + selective upsizing alone.

---

## Execution Checklist

1. **Verify retiming legality** — confirm no combinational loop through the accumulator register. The MAC feedback register is a hard boundary.
2. **Run retimer** in your synthesis/PnR tool (Genus: `retiming`, Innovus: `set_retiming_options`, DC: `compile_ultra -retiming`) targeting the multiplier hierarchical level only.
3. **Post-retiming QoR check** — confirm functional equivalence with a formal check or gate sim. Retiming changes internal register positions.
4. **Upsize the residual critical path** — after retiming, re-run `report_timing` and upsize only the remaining violating cells.
5. **Check hold** — upsizing can worsen hold on adjacent paths. Run hold analysis before committing. Given your signoff team's sensitivity to hold, verify the **fast corner** explicitly.
6. **Signoff timing closure** — re-run with the same derates/margin your signoff uses.

The key risk is hold degradation from upsizing. If hold margins are already tight, favor **Vt swap to LVT** on the critical path over raw upsizing — LVT gives similar delay improvement with less output slew impact on neighboring paths.

## T5 [10:27] User {#msg_f4b912944001ihETUskBWfmYCm}

"Update: retiming plus selective LVT swap worked. WNS is now +12ps, area up 2.1%, leakage up about 4% — acceptable for this block. Lesson for the team: in our node the synthesis-to-PnR timing correlation gap on big multipliers is huge (~60ps), so next time we enable physical-aware synthesis from the start instead of trusting post-synth slack."

## T6 [10:27] Assistant {#msg_f4b912a3e00171YUf2aBXy6yCH}

Good closure. Let me record this for the team.

> 🔧 buddy_add_memory {"title":"MAC multiplier timing closure: retiming + LVT swap","content":"64-bit MAC multiplier failed timing after PnR (WNS -45ps) despite positive slack at syn… → completed

## T7 [10:27] Assistant {#msg_f4b914bfd001fyormbA7v96oiF}

Recorded as a team lesson. Key takeaway captured:

- **~60ps synthesis-to-PnR gap** on wide multipliers at your node
- **Fix worked**: retiming + LVT swap (no latency change, +2.1% area, +4% leakage)
- **Next time**: enable physical-aware synthesis from the start

The accumulator-loop retiming boundary constraint is a useful pattern to remember — retiming within the multiplier's combinational cone is safe, but the feedback register is a hard wall.
