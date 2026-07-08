# PER-HIRE-SOUL-SPEC — every hire has a soul

**Status:** DRAFT (2026-07-07) · gates D-041 · queued `per-hire-soul` (gate:operator)
**Decision:** [[DECISIONS#D-041]] — per-hire soul + comms topology.

## 1. Purpose

Give every hired role a **soul**: a derived, honest, compute-on-read identity —
*who this hire is, what it's proven at, how far it's matured, where it has served* —
mirroring the S4 self-model Atelier already computes for `self:atelier`
(`src/lib/server/memory/soul.ts`). A soul makes the workforce **legible** (the org
can be read, not just listed), makes **hiring/matching** (BL-3) evidence-driven, and
feeds **aliveness** — hires with identity, not anonymous slots.

**A soul is a READ-MODEL, not a communication channel.** It changes nothing about
who can message whom (D-041 keeps the cross-project wall; the peer resolver is
untouched). It adds identity, not reach — so it cannot become an injection vector.

### Non-goals
- **No new comms topology.** project↔project stays forbidden; `atelier` stays the
  sole cross-project broker (D-035a, PEER-MESSAGE-SPEC D3). This spec does not touch
  `peer/resolve.ts` or `peer/affordance.ts`.
- **No LLM in the compute path.** The soul is DERIVED from live rows deterministically
  (mirrors `soul.ts` + D-029 — no summary-LLM in the identity projection).
- **No fabricated identity (F-008).** A hire with no track record has a `nascent`
  soul that says so — never invented competence.

## 2. What a hire-soul IS

A pure projection over rows that ALREADY exist — no new source of truth. The
per-role analog of `soul.ts`'s `SoulModel`:

```
HireSoul {
  role:          record<role>        // subject
  maturityStage: MaturityStage       // nascent → developing → established → …  (role-scoped ladder)
  provenNow:     string[]            // defect classes / capabilities it is CERTIFIED on (gauntlet provenance)
  provenAtTier:  { model, sha }[]    // tier proofs (strict §7: certified at prompt_sha × tier)
  trust:         Calibration         // confidence-vs-outcome (the §5/A1 calibration) — honest, may be "insufficient data"
  servedIn:      record<project>[]   // where it is / has been staffed (project_staff)
  experience:    { versions, interviews, sessions, commits }  // volume the maturity gates read
  summary:       string              // one honest paragraph, screened (formatSoulBlock analog)
  coldStart:     boolean             // no accumulated identity yet (stage === nascent)
}
```

## 3. Data sources (grounded — all live rows today)

Verified seams (no new tables for the base soul):

| dimension | source |
|---|---|
| certified capabilities / proven-on | gauntlet fixture **provenance** on `role` / `role_version` (§3.8), `interview_run` status='passed' (`workforce/activation.ts`, `capability-match.ts`) |
| tier proofs (strict, no-waiver §7) | passing `interview_run` at `prompt_sha × tier` (`workforce/ceremony.ts`, tier-hiring) |
| trust / calibration | `track-record.ts` calibration (confidence × closed-outcome), `panel_verdict.confidence` (§5/A1) |
| where served | `project_staff` (D-6 §6) |
| version history / maturity | `role_version` lifecycle rows |
| experience volume | `role_version` count, `interview_run` count, `session`/`message`/commit counts for the role |

## 4. The maturity ladder (per hire)

Reuse the ordinal shape from `soul.ts` (`MaturityStage`, per-gate measurable
thresholds, `isColdBrain`), re-tuned for a role rather than the whole brain:

- **`nascent`** — drafted/seeded, no passing certification yet. Honest cold-start.
- **`certified`** — ≥1 `passed` role_version (proven on its launch fixtures).
- **`proven`** — certified on ≥N distinct defect classes AND ≥1 real staffing AND a
  calibration signal that isn't "insufficient data" (a rounded, load-bearing identity).
- **`veteran`** — proven + a track record across ≥M sessions/projects with in-band
  calibration (trustworthy under load).

Gates are **measurable thresholds on live counts** (like `soul.ts`), deterministic,
and a stage requires cross-dimensional evidence (not richness in one axis alone).
Exact N/M are config defaults, operator-tunable (no invented numbers baked in).

## 5. Compute-on-read design

- One pure function `computeHireSoul(role, deps) → HireSoul`, mirroring
  `soul.ts` (`deriveMaturity` + the metrics struct). Pure + deterministic; unit-
  testable against seeded rows; **no migration** for the base soul (it is a
  projection, justified exactly as `soul.ts` is).
- `formatHireSoulBlock(soul) → string | null` — a CONCISE, **screened** (D-026)
  identity block, `null` on cold-start (mirrors `formatSoulBlock` + `isColdBrain`).
  This block is what a hire carries into its own sessions and what surfaces as its
  peer identity label.

## 6. Surfaces

- **`/agents`** — each role shows its soul: maturity badge, proven-on chips (from
  provenance), tier proofs, calibration (honest "insufficient data" when thin),
  served-in projects, experience counts. Design-system tokens (D-034), honest empty
  states (F-008).
- **Session self-identity** — a hire's screened soul block is available to its own
  driven session (grounds "who am I / what am I trusted for") — DATA, never steering.
- **Peer identity** — where a peer/transcript turn shows an agent, label it with its
  maturity + one-line soul (read-only; does not change addressing).
- **Scene node** (optional, fork below) — role souls as nodes in the living scene,
  alongside `self:atelier`.

## 7. Safety invariants (load-bearing)

1. **Read-model only** — computing/showing a soul grants no new reach. `peer/resolve.ts`
   topology is untouched; cross-project stays walled (D-041/D-035a).
2. **Non-steering** — a soul block injected into a session/peer view is fenced DATA
   (MEMORY-SPEC §10); only `origin=operator` steers.
3. **Screened** — every rendered/injected soul string passes the D-026 screen
   (a provenance/charter note could carry pasted secrets).
4. **Honest** — cold-start says "nascent, no track record"; calibration says
   "insufficient data" when thin. No fabricated competence (F-008). No `str(undefined)`
   dates (F-013) — coerce in the norm.
5. **Deterministic** — no LLM in the compute path (D-029).

## 8. Optional persisted history (deferred fork)

The base soul needs no table. IF graduation provenance + a scene timeline is wanted
(the deferred graduation-history item from the cognitive arc), add an append-only
`hire_soul_event` (role, from_stage→to_stage, evidence snapshot, at) written when a
maturity gate flips — idempotent (F-015), additive. **Fork for the operator:** ship
the compute-on-read base first; add history only if the timeline earns its keep.

## 9. Build tasks

- **SL-1** `computeHireSoul` + `HireSoul`/`MaturityStage` (role-scoped) + the gate
  thresholds (config defaults), pure, unit-tested against seeded workforce rows
  incl. cold-start + each stage boundary + a real-surreal test that the source
  queries parse (F-020).
- **SL-2** `formatHireSoulBlock` (screened, cold-null) + a norm coercing every
  datetime (F-013).
- **SL-3** `/agents` soul surface (maturity badge, proven-on chips, tier proofs,
  calibration, served-in) — tokens, honest empties, live via watched-tables.
- **SL-4** wire the screened soul block into the hire's session self-identity + the
  peer/transcript identity label (DATA/non-steering asserted by test).
- **SL-5 (deferred fork)** `hire_soul_event` history + scene nodes.

**Verify:** `npm test` (incl. real-surreal), `svelte-check` 0, `npm run db:up` live
if SL-5 ships a migration, render-smoke `/agents`. redTeam SL-4 (prove the soul block
cannot steer and cannot leak an unscreened secret; prove topology unchanged).

## 10. Open questions (operator forks)

1. **Ladder thresholds** — the N distinct classes / M sessions for `proven`/`veteran`.
   Recommend: start conservative, tune from real cert data.
2. **History table now or later** — ship compute-on-read first (recommend), add
   `hire_soul_event` only if the graduation timeline is wanted.
3. **In-project mesh richening** — D-041 says aliveness lives in the in-project mesh;
   whether to *also* loosen in-project role↔role conversation (still non-steering) is
   a separate, smaller follow-up — not in this spec's scope.
