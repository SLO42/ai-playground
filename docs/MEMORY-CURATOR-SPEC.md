# MEMORY-CURATOR-SPEC — the slow curator tier (BL-7C)

**Status:** DRAFT (2026-07-07) · completes MEMORY-UTILIZATION-SPEC §5.3 · gates D-015 / D-028 / D-030 / D-031 · queued `memory-curator` (gate:operator)
**One-liner:** the D-027 two-tier learning loop has its FAST tier live but its SLOW curator tier parked. The executor exists; the trigger, the detector, and the time-archive runner do not. Wire them — with the hard split of **detect/propose (safe) from apply (live, gated)**.

## 1. Context — two tiers, one live

- **FAST tier — BUILT** (D-027): per-turn ADD-only writer fork. `memory/loop.ts` (`runReviewFork:456`, `consolidate:571`), enqueue at `sessions/launch.ts:967`, drain dispatch `orchestrator.ts:664`. (NB: MEMORY-UTILIZATION-SPEC §5.1's "dead on both ends" is STALE — pre-activation history.)
- **SLOW tier — PARKED** (this spec). Operator chose "B now, C parked" (§5.3); recall + ranking carry the brain meanwhile.

## 2. What EXISTS vs MISSING

| piece | status |
|---|---|
| Store write path (ADD-only, screen-before-embed, `memory_history` audit) | BUILT — `memory/store.ts:292` |
| Recall active-set filter (EXCLUDES quarantined + archived + superseded) | BUILT — `memory/recall.ts` §5.3 — the read-guard the curator's soft-archive relies on |
| Schema for archival | BUILT — `memory.status ∈ {active,archived,superseded}` + `archived_at` + `superseded_by` (`schema.ts:233-236`) |
| Consolidation **executor** `consolidate(db,input)` (rewire edges → soft-archive member + audit; REFUSES tier-0/protected sources) | BUILT — `loop.ts:571` but **ZERO non-test callers** |
| Concept-graph supersession (`supersedes`/`contradicts` edges) | BUILT — `memory/concepts.ts:188` (separate table from memory-table edges) |
| **Member-selector / trigger** for consolidate() | **MISSING** |
| **D-028 conflict/contradiction/supersession DETECTOR** for the memory table (`references.contradicts` is schema-defined, runtime-unwritten except v1 importer) | **MISSING** |
| **D-015 time-based archive runner** | **MISSING** (schema-ready, nothing runs an age pass) |
| **Operator-confirm reversible soft-delete** (G2) | **MISSING** (nothing to confirm until the above exist) |
| Maintenance engine to host it | BUILT — `loops/maintenance.ts` (engine, gates, seeds) + `maintenance-actions.ts` (registry) |

## 3. THE load-bearing design split (do not get this wrong)

Every existing maintenance action runs **report-only against a THROWAWAY DB** *because touching live memory during a measurement would pollute memory and poison the reranker's live labels* (`maintenance-actions.ts:7`, F-008/D-030). But the curator's job is to **mutate LIVE memory** (soft-archive, rewire edges). So:

- **DETECT / PROPOSE (L1, safe):** the conflict/consolidation/age detectors run **read-only over live memory** (or against a snapshot) and emit **proposals** — never a live write. Report-only, like the eval actions.
- **APPLY (L2+, gated):** the actual soft-archive / edge-rewire / supersede runs **on live memory**, but ONLY through an **operator-confirmed apply** (G2) or an explicitly armed higher ladder rung. This is where `consolidate()` and the archive writes fire.

The throwaway-DB rule governs **measurement**, not the curator's purpose. Conflating them (running the curator's writes on a throwaway) would archive nothing real; running its writes unguarded on live would violate G2. Split them.

## 4. The three passes

### 4.1 Conflict / contradiction / supersession detector (D-028) — DETECT propose-only
- Deterministic/graph, **never LLM-mutate-in-place** (D-028). Candidates: high-cosine near-dups (dedup family), explicit `supersedes` signals, and contradiction pairs.
- Emits **proposals** (a `curator_proposal` notification / row): "archive B into A (dup, cosine 0.97)", "supersede X by Y", "A contradicts B — operator resolve". Writes the memory-table `references.contradicts` edge (its intended first runtime writer) **only on apply**, not detect.
- Reuses `consolidate()`'s REFUSE guard (tier-0 / PROTECTED_SOURCES can't be buried — a poisoned model can't archive a finding).

### 4.2 Periodic consolidation (D-031) — the MISSING trigger for `consolidate()`
- A **member-selector** picks near-dup families (cosine cluster over the active set, inactivity-triggered per D-031). Feeds the existing `consolidate(db,input)` executor. Diversity: pair with the query-time novelty gate already live.
- Apply is gated (§3). On apply, `consolidate()` already soft-archives + audits correctly.

### 4.3 Time-based archive (D-015) — DETECT + gated APPLY
- **TIME-based, NOT utilization-based** (D-030 🔒 — never prune on low usage). Age + status heuristic → propose soft-archive (`status='archived'`, `archived_at`, `archive_reason`) with a `memory_history op:'archive'` audit. Reversible (D-015). Recall already excludes archived rows — no read change needed.
- Knowledge-bearing tables stay append-only; this is soft-archive, never `DELETE`.

### 4.4 Operator-confirm soft-delete (G2)
- The human gate on top of 4.1–4.3: proposals surface in an operator queue; the operator confirms/rejects; only confirmed proposals apply. **Never auto-delete on a noisy signal** (G2). Reversible.

## 5. Hosting — a maintenance loop action
Register `MAINT_MEMORY_CURATOR = 'maint:memory-curator'` in `defaultMaintenanceRegistry` (`maintenance-actions.ts:221`) + a `DEFAULT_MAINTENANCE_SEEDS` row (nightly cadence, checklist EMPTY so honestly inert until the operator arms it, phase `L1`=propose-only). The **detect pass** runs as the L1 action (read-only/snapshot → proposals). The **apply** is the operator-confirm step (§4.4), NOT the tick — the tick proposes, the operator disposes. Engine already: sequential (F-052), fail-absorbed (F-048), arm-gated (readiness).

## 6. Locked constraints (must hold)
- **D-030** 🔒 outcome → ranking ONLY, never pruning. The rejected "prune low-util+age" model stays rejected.
- **D-015** 🔒 forgetting is TIME-based + archive-not-delete, reversible, audited.
- **D-028** 🔒 extraction ADD-only; conflict resolution a separate deterministic/graph pass.
- **D-031** 🔒 periodic inactivity-triggered consolidation into umbrellas.
- **G2** 🔒 operator retires; never auto-delete on a noisy signal.

## 7. Build tasks
- **CUR-1** Member-selector + consolidation trigger (near-dup cluster over the active set) → feeds `consolidate()`; DETECT emits proposals, no live write. Real-surreal test.
- **CUR-2** D-028 conflict/supersession detector (deterministic/graph) → proposals; writes `references.contradicts` only on apply.
- **CUR-3** D-015 time-based archive detector → archive proposals; apply soft-archives + audits (reversible).
- **CUR-4** Operator-confirm apply queue (G2) — surface proposals, confirm/reject, reversible apply; the ONLY path that mutates live memory.
- **CUR-5** Register `MAINT_MEMORY_CURATOR` (L1 propose-only) + seed row + `/loops` surface.

**Verify:** real-surreal tests (detect over seeded near-dup/contradiction/aged rows → correct proposals; apply archives + recall then excludes; REFUSE guard blocks tier-0); `npm run db:up` if a proposal table ships; redTeam CUR-4 (prove no unconfirmed live delete, no tier-0 burial, reversibility, D-030 not violated).

## 8. Open forks
1. **Proposal store**: a dedicated `curator_proposal` table vs reuse `notification`. Recommend a small table (queryable queue + reversible apply record).
2. **Snapshot vs read-only-live for detect**: read-only-live is simplest and safe (no writes); snapshot only if detect gets expensive. Recommend read-only-live first.
3. **Auto-apply the safest class?** e.g. exact-duplicate (cosine ≈1.0) auto-consolidate without operator confirm. Recommend NO initially (G2) — earn trust via the confirm queue first, then consider a narrow auto-class.
