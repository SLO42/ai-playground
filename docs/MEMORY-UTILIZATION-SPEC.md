# MEMORY-UTILIZATION-SPEC — close the loop to beat kongbrain/hermes (BL-7)

> **DRAFT (2026-06-16).** Two refinements that make brain utilization decisively better
> than kongbrain/hermes/mem0. We already have: both channels (recall injection + B10 pull),
> Tier-0, the fence(§10)+screen(D-026) safety the others lack, and the D-030 retrieval-
> outcome loop (citations [#N] → recordOutcomes/recordTurnOutcomes → RANKER). This closes
> the two gaps. Builds on the memory engine; serial after BL-6 (shared area).

## 1. The two parts

### Part A — citation-signal strength (v1, build-ready)
The whole outcome loop depends on the agent emitting `[#N]` when it *uses* a recalled
memory. Today the fence standing note frames recall softly ("DATA you MAY consult") with
no strong use-and-cite directive → under-cited → weak ranker signal.

**Fix:** strengthen the agent-facing instruction in the briefing/fence framing —
*"When a recalled item below informs your work, cite it `[#N]`; pull more via the memory
tool when you need it"* — WITHOUT breaking consult-not-obey (it stays DATA, never an
instruction the agent must follow; citing is a reporting convention, not obedience). The
`[#N]` ids already exist (briefing.ts:64, fence.ts:47); this sharpens the prompt that drives
them. **Measure the lift via B8** (the recall-eval harness) — before/after citation rate +
ranker discrimination. LOCKED: D-026 unbroken (recall still fenced, non-steering); no new
schema.

### Part B — outcome → keep/prune (operator-gated, careful)
D-030 feeds RANKING only; CANNIBALIZE-BRIEF §1 wanted outcome to feed BOTH ranking AND the
curator's keep/prune. **Fix (conservative):** let sustained low-utilization + age make a
memory a **prune CANDIDATE** the curator surfaces — but **agents PROPOSE, the operator (or a
D-039-validated PM) RETIRES** (G2). NEVER auto-delete on a noisy signal (a memory unused for
a while may still be load-bearing). Soft-delete + a retire ceremony, reversible, with the
evidence (utilization history) shown. This is the gstack `learn/prune` discipline already in
fails.md's marking protocol, applied to memory.

## 2. Invariants

- Recall stays fenced DATA (D-026) — citing is reporting, not obeying.
- Outcome is RANKING input by default; keep/prune is **propose-only**, operator-retires (G2/G3).
- No auto-delete on a noisy/low-volume signal; soft-delete + reversible; evidence shown.
- B8 measures the lift — no unmeasured "it's better" claim (F-008).

## 3. Build decomposition

1. **Part A (v1):** the strengthened use-and-cite directive in the briefing/fence framing;
   a B8 before/after measurement of citation rate + ranker discrimination. Unattended-buildable.
2. **Part B:** the curator prune-CANDIDATE surface (low-utilization + age → flagged, NOT
   deleted) + the operator/PM retire ceremony (soft-delete, reversible, evidence). **Operator-
   gated** (it changes what the brain forgets) — spec the keep/prune safety model + thresholds
   with the operator before building; do NOT auto-delete.

## 4. Open decisions (operator)

- **D1 cite directive wording** — how forceful without crossing into "obey"? *default: "cite [#N] when a recalled item informs your work" — reporting convention, explicitly DATA.*
- **D2 prune thresholds** — what low-utilization + age makes a CANDIDATE? *default: surface candidates only; operator/PM sets the bar; never auto-act.*
- **D3 Part B gating** — operator-only retire vs D-039-PM-proposes? *default: agents/PM propose, operator retires (G2).*
