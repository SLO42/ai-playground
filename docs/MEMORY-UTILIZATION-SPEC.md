# MEMORY-UTILIZATION-SPEC — close the loop to beat kongbrain/hermes (BL-7)

> **DRAFT (2026-06-16).** Two refinements that make brain utilization decisively better
> than kongbrain/hermes/mem0. We already have: both channels (recall injection + B10 pull),
> Tier-0, the fence(§10)+screen(D-026) safety the others lack, and the D-030 retrieval-
> outcome loop (citations [#N] → recordOutcomes/recordTurnOutcomes → RANKER). This closes
> the two gaps. Builds on the memory engine; serial after BL-6 (shared area).

## 1. The two parts

### Part A — citation-signal strength (v1, build-ready) — ✅ DONE (origin/v2 `140ebb6`)
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
schema. (Shipped: prompt-side lift measured; live model-behaviour citation-rate proof deferred.)

### Part B — see §5. (The original "outcome → keep/prune" framing was REJECTED on verification — it contradicted locked D-030; see §5.)

## 2. Invariants

- Recall stays fenced DATA (D-026) — citing is reporting, not obeying.
- Outcome is RANKING input ONLY (D-030 🔒 RESOLVED) — it does NOT drive pruning. Pruning is
  TIME-based (D-015). Conflict resolution (dedup/supersession/contradiction) is a separate
  deterministic/graph pass (D-028 🔒), never the LLM mutating in place.
- Any forgetting is archive-not-delete (D-015), reversible, audited (`memory_history`).
- B8 measures the lift — no unmeasured "it's better" claim (F-008).

## 3. Build decomposition

1. **Part A (v1):** ✅ done — the strengthened use-and-cite directive + B8 measurement.
2. **Part B:** see §5 — the corrected, verified scope (activate the dead D-027 fast tier;
   park the slow curator).

## 4. Open decisions — superseded by §5 (the original D1–D3 prune-threshold questions are moot; the prune model was rejected against D-030).

---

## 5. Part B — CORRECTED on verification (2026-06-16)

> **The original §5 (prune CANDIDATES from "low-utilization + age") was REJECTED** after a
> file:line verification pass: it contradicted locked **D-030** (outcome→ranking ONLY, NOT
> pruning) and **D-015** (pruning is time-based), and it wasn't the real gap. The verified
> finding below replaces it. (Marked, not deleted — the rejected approach is recorded so it
> isn't re-proposed.)

### 5.1 Verified build-state of the memory curator (file:line, 2026-06-16)
- ✅ **BUILT & correct:** ADD-only extraction; recall + WMR ranking; **D-030 outcome→ranking**
  (recall.ts:12-15 states outcome feeds ranking only, curator does NOT read it); the query-time
  novelty gate (`NOVELTY_COSINE_CUT` 0.90); **session-END whole-session extract** rides every
  orchestrator spawn (TASK 8.3, orchestrator.ts:380-382).
- ❌ **UNBUILT — the D-027 FAST in-use writer fork is DEAD ON BOTH ENDS:**
  - *enqueue side:* `bumpCounters`/`dueReview`/`enqueueReview` (loop.ts:49/66/101) have **zero
    non-test callers** — nothing hooks a live turn to count cadence + enqueue a `memory_review`.
  - *drain side:* the orchestrator `#runItem` (orchestrator.ts:363-371) reads only
    `payload.taskId/projectId` and `return`s otherwise → a `memory_review` work_item is **never
    executed**; `runReviewFork` (loop.ts:426) has **zero non-test callers**.
- ❌ **UNBUILT — the SLOW curator tier (parked, see 5.3):** the D-028 deterministic conflict
  pass (no dedup/supersession/contradiction detector; `references.contradicts` defined
  schema.ts:303 but **never written at runtime** — only by v1 import); the D-031 periodic
  consolidator's member-selection (`consolidate()` loop.ts:523 is a *manual executor* with no
  caller that picks members); D-015 **time-based memory GC** (schema supports soft-archive;
  nothing runs an age pass).

### 5.2 Part B = activate the D-027 fast in-use writer fork (operator chose: B)
Wire the already-built fork at BOTH ends so per-turn learning actually runs. This is
**additive (ADD-only, D-028) — it forgets nothing** (forgetting is the parked slow tier). It
completes a locked design (D-027) whose guardrails already exist.
1. **Enqueue hook (live session):** on each turn/tool-iter, `bumpCounters` → `dueReview` →
   `enqueueReview(turnText)` from the live-session path (ride the existing per-turn seam —
   e.g. the `eventToMessage` chokepoint used by live-session-transcript). The raw turn text is
   **screened (D-026) before it is queued/mined**. The interview-exclusion already in
   `enqueueReview` (loop.ts:112) stands — gauntlet transcripts are never mined.
2. **Drain dispatch:** `#runItem` handles `work_type === 'memory_review'` → run `runReviewFork`
   with the bounded `extract`/`proposeSkills` seam (the review LLM), writing ADDITIVELY via the
   tool-whitelisted `MemoryWriteSurface`. Bounded by the existing **D-021 daily-spawn cap +
   claim tokens + stale-GC** (loop.ts:96 — the caps double as the poisoned-self-reinjection
   circuit breaker). Idempotent on re-claim.
3. **MATERIAL CONSEQUENCE (operator-flagged):** activating this fires a review-LLM fork every
   Nth turn (cadence `DEFAULT_CADENCE` = 5 turns / 10 tools) → **recurring spend**, bounded by
   the D-021 cap. Cadence + cap are the spend control; tune conservatively at first.

### 5.2a Build decomposition (Part B / activate fast tier)
1. The enqueue hook on the live per-turn seam (screen turnText, interview-excluded, cadence
   from persisted counters); unit + integration vs real SurrealDB.
2. The `#runItem` `memory_review` dispatch → `runReviewFork` + the bounded extract seam; caps
   respected; a `memory_review` item with no taskId no longer early-returns.
3. Tests: a live turn bumps counters and enqueues at cadence; the drain executes the fork and
   writes ADD-only memory; an interview session is NEVER enqueued; the D-021 cap throttles;
   re-claim is idempotent (no double-write).
4. **Red-team (security-relevant — the fork mines turn text + is the self-reinjection seam):**
   prove the mined turn is screened/fenced (a planted secret in a turn is NOT written to memory
   raw); prove the interview-exclusion can't be bypassed; prove the cap/circuit-breaker bounds
   hold (no unbounded review-spawn storm); prove ADD-only (the fork cannot delete/mutate).

### 5.3 PARKED (operator chose: C) — the SLOW curator tier
Deferred, NOT built now (recall + ranking carry the brain meanwhile; it accumulates honestly):
- **D-028 deterministic conflict pass** — a dedup (cosine) / supersession / contradiction
  detector that writes typed `references` edges and selects members for `consolidate()`.
- **D-031 periodic consolidator** — the inactivity-triggered batch merge into umbrellas (wire a
  trigger to the existing `consolidate()` executor once a member-selector exists).
- **D-015 time-based memory GC** — an age-based soft-archive pass (NOT utilization-based — D-030).
- The **operator-confirm + reversible soft-delete** layer (G2) sits on top of these when built —
  the only piece of the rejected §5 that survives, but it has nothing to confirm until the
  detector/consolidator exist. Spec these as their own item when C is un-parked.
