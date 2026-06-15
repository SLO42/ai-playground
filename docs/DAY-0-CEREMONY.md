# Day-0 bootstrap ceremony — operator checklist (gate:operator)

> **Status (2026-06-13):** mechanism built + hardened, BUT the operator-clickable DRIVER UI was missing (decomposition gap — found live: `seedLaunchPool` had no caller, the `/agents` "Run interview" CTA pointed at a dead `/?ceremony=bootstrap`). **`wave-ceremony-ui` is building the driver now** (entry → seed → review cores → author keys → reference-runs → bootstrap interviews → flip). Once it lands, the entry is a **"Begin day-0 ceremony" button on `/agents`** (NOT the old `/?ceremony=bootstrap` link). Steps below are unchanged; only the entry point is being wired. Source of truth: `WORKFORCE-SPEC.md §8`.

## Why this is yours (not automatable)
- Answer **keys** are operator-authored — the PM has no read path to keys (§4.4 independence). An agent authoring its own test answers defeats the gauntlet.
- Steps 3–4 cost **real tokens** (reference-runs + interviews). Budget cap ships `null` = nothing auto-runs (F-008); only your explicit `operatorConfirmed` trigger spends.

## Entry points (what's live now)
- `/agents` workforce panel → 5 launch role cards, each showing **"v1 · not yet interviewed" + NOT DEPLOYABLE + "Run interview" CTA** (honest empty — no interview data exists yet).
- The CTA opens the bootstrap ceremony at **`/?ceremony=bootstrap`** (built in 16.7b → 16.7a's `ceremony.ts` write-paths).

## The five steps (WORKFORCE-SPEC §8)
1. **Review the 5 launch prompt cores** — for each of `security-officer`, `code-reviewer`, `qa-lead`, `design-reviewer`, `investigator`: read the prompt-core **diff vs its harvested source** (`promptCoreDiffStep`, read-only). Approve once. *(These cores were authored by 16.7a's `seedLaunchPool` as DRAFT, harvested-derived — that's why you review, not just rubber-stamp.)*
2. **Author / confirm each fixture's answer key** — diff+confirm per fixture (`confirmLaunchKey`): the diff shows `work + key + fp_tolerance + justification`. The fixture WORK already exists (5 pools, F-entry-seeded planted defects + an A8 injection bait each); you supply the KEY (what counts as a correct find).
   - ⚠️ **For the A8 `hallucination_bait`/injection fixtures: set the key to `mode:'noncompliance'` + a `compliance_pattern`** — otherwise the embedded-instruction bait is never scored (red-team-flagged).
   - ⚠️ A `planted_defect` key with **zero plants is rejected** (teethless) unless you pass `allowEmptyPlants:true` + a justification. `clean_control`/`scorer_control` legitimately have no plants.
   - A corrected re-confirm returns `changed:true` + "correction NOT applied; needs a NEW fixture" (keys are content-immutable) — heed it.
3. **Admission reference-runs** (`triggerAdmissionReferenceRun`, **real spend**) — run at each role's actual default tier/model. Proves every plant is findable + every clean section clean → this is what *justifies* the armed recall-1.0 / FP-0 bar. Recorded per-tier in `gauntlet_key.reference_runs`; a brand-new role's own draft proves provisionally (`provisional:true`).
   - ⚠️ **Before spending:** confirm each launch role's default tier resolves to a LIVE model (opus/sonnet/haiku). *(Fable-5 was only the PM identity — retired, deferred correction — not the launch roles; verify anyway.)*
4. **Bootstrap interviews** (`triggerBootstrapInterview`, **real spend**) — run each role through its sampled active fixtures at those (tier, model_id) pairs. Confined/sterile/deterministically scored (engine = 16.6 W-D7b).
5. **Five passes → panel flips** — on five passing bootstrap interviews, panel composition flips **inline-validators → catalog roles** (`validator_kind: inline → catalog_role`, a `role_event` per role). Until then, inline validation is the honest degraded mode. `ceremonyReadiness` reports the precondition; it never flips on its own.

## Adjudication (if a run needs you)
If the deterministic scorer hits an ambiguous match, the run finalizes `status:'adjudicating'` and lands in the **PM-tab adjudication queue** (`/agents`). You resolve → it appends to `results` and flips `passed`/`failed` against the snapshot pass bar. No judge agent.

## After the ceremony
- v2.1 is then fully live (certified workforce). Next auto wave: `wave-v2.2b` (memory system — being built in parallel; independent of this ceremony).
- `wave-v2.2b` also lands the folded v2.1-harden residual (ULID-shape sentinel invariant + LOW cosmetics).
