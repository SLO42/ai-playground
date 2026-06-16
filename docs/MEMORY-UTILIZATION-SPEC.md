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

---

## 5. Part B — full spec (build-READY, but BUILD is operator-gated)

> Specced 2026-06-16 (operator: "BL-7 can be specced"). This is the keep/prune safety model
> in build-ready detail. It does NOT auto-chain — building it **changes what the brain
> forgets**, so the BUILD step stays `gate:operator`. BL-8 (brain-observability) shipped the
> history + utilization surfaces this depends on; Part B adds the *candidate* + *retire*
> layer on top, never a delete.

### 5.1 The one-sentence shape
Surface **prune CANDIDATES** (sustained low-utilization + age) as a reviewable list with the
full utilization evidence; an operator (or a D-039-validated PM proposal the operator
confirms) **soft-deletes** a candidate; soft-delete is **reversible**; nothing is ever hard-
deleted by a signal.

### 5.2 Locked safety invariants (load-bearing — these ARE the feature)
1. **No auto-delete, ever.** The signal only *nominates*. Removal is an explicit human (or
   operator-confirmed PM) act — agents PROPOSE, the operator RETIRES (G2). A noisy/low-volume
   utilization signal must never, by itself, remove a memory.
2. **Soft-delete + reversible.** "Retiring" sets a state (e.g. `archived`/`retired`) — the row
   and its content persist; an `unretire` restores it. A retired memory is excluded from
   recall but recoverable. (Reuse the existing supersede/archive path + `memory_history` audit
   — D-015; this is NOT a new deletion mechanism.)
3. **Evidence shown before any retire.** The candidate view must render the utilization
   history (recalled vs cited vs utilized, age, last-used) — the BL-8 outcomes lens — so the
   operator decides on data, not a bare score. No retire affordance without the evidence in view.
4. **Load-bearing protection.** Tier-0 / pinned / directive memories and anything recently
   cited are NEVER candidates regardless of age. A "low-utilization" memory may still be
   load-bearing (rarely-recalled but critical) — the candidate set is conservative by
   construction and the operator is the backstop.
5. **Ranking stays separate.** D-030 outcome→ranking (already shipped) is unchanged; Part B is
   an ADDITIONAL, gated consumer of the same signal for *candidacy*, not a change to ranking.
6. **Audited.** Every retire/unretire writes `memory_history` (who/what/when/why + the
   evidence snapshot at decision time) — visible in the BL-8 history lens.

### 5.3 Candidacy signal (surface-only; thresholds operator-set)
A memory becomes a CANDIDATE when ALL hold (conservative AND):
- **age** ≥ an operator-set floor (default: surface only, operator sets the bar — never a
  baked number that silently acts);
- **utilization** sustained-low: recalled ≥ N times but cited/utilized ≈ 0 over the window
  (a memory that's *never even recalled* is a different, weaker signal — flag separately, do
  not conflate); derive from `retrieval_outcome` via the BL-8 reader.
- **NOT protected** per §5.2.4 (not Tier-0/pinned/directive/recently-cited).
The candidate list is honest (F-008): it shows *why* each row qualified (the actual counts +
age), never a fabricated urgency.

### 5.4 The retire ceremony (mirrors the gauntlet/D-039 propose→confirm shape)
- **Propose:** the curator (`loop.ts`) — or a PM via a D-039-validated proposal — marks a
  candidate `retire-proposed` with a rationale + evidence snapshot. (Reuse the existing
  curator/`consolidate` plumbing; this is a new proposal *kind*, not a new engine.)
- **Confirm:** an operator reviews the candidate + its evidence in the UI and confirms or
  rejects. A PM proposal is itself only a proposal — the operator (or D-039 board) is the
  retire authority (G2). Confirm → soft-delete (state flip + audit). Reject → cleared, with
  the rejection recorded (so it isn't re-proposed immediately — a cool-down).
- **Unretire:** any retired memory is restorable from the history/retired view (reversible).

### 5.5 Reuse map
| Need | Reuse |
|---|---|
| Utilization evidence | BL-8 `observability.ts` `listRetrievalOutcomes` + the outcomes lens |
| Audit before/after | `memory_history` + the BL-8 history lens (D-015) |
| Soft-delete state | the existing supersede/archive path on `memory` (no new delete mechanism) |
| Propose engine | `memory/loop.ts` (`consolidate`/`dueReview`/`runReviewFork`) — add a retire-candidate proposal kind |
| Confirm authority | the operator gate + D-039 PM-proposal validation (same shape as gauntlet adjudication) |
| Candidate/retire UI | a lens alongside the BL-8 Memory surfaces (the retire affordance lives HERE, gated — BL-8 itself stays read-only) |

### 5.6 Build decomposition (when the operator un-gates)
1. Candidacy reader: `listPruneCandidates(...)` over `memory`×`retrieval_outcome` applying the
   §5.3 AND with operator-set thresholds (config, not baked); excludes protected rows. Read-only.
2. Soft-delete + unretire on the existing archive path; every transition writes `memory_history`;
   recall excludes retired rows; idempotent/reversible.
3. The retire-candidate proposal kind in `loop.ts` (propose-only) + the operator/D-039 confirm seam.
4. The UI: a candidate-review lens (evidence-in-view §5.2.3) with gated retire/unretire +
   a retired-memories view; honest states; tokens/a11y. (Distinct from BL-8's read-only lenses.)
5. Tests vs real SurrealDB: a low-util+old non-protected memory becomes a candidate; a Tier-0/
   recently-cited memory NEVER does; retire is reversible + audited; recall excludes retired;
   a PM proposal cannot retire without operator confirm (G2); no signal path hard-deletes.
6. Red-team: prove there is NO code path where a signal alone removes a memory; prove unretire
   fully restores (content + recall eligibility); prove protected classes are unreachable as
   candidates; prove the evidence shown matches the decision-time snapshot (no drift/forgery).

### 5.7 Open decisions (operator — settle before build)
- **D4 thresholds:** the age floor + the recalled-but-uncited window/counts that make a
  candidate. *default: NONE baked — operator sets; the surface ships showing candidates only.*
- **D5 retired-recall:** hard-exclude retired from recall · or down-rank heavily? *default:
  hard-exclude (retired = not recalled), reversible via unretire.*
- **D6 PM autonomy:** may a D-039 PM proposal auto-apply after board validation, or always
  operator-confirm? *default: always operator-confirm for memory retire (G2) — the brain's
  forgetting is operator-authority, even with a validated board.*
- **D7 cool-down:** how long is a rejected candidate suppressed before re-proposal? *default:
  operator-set; a rejection is remembered so the same row isn't re-nagged.*
