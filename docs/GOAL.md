# GOAL — Atelier Alive v1 (the north star, so we don't lose focus)

Set 2026-07-23 (operator: "set a goal so you don't lose focus"). Re-read at the top of every autonomous stretch; measure each checkpoint against the DONE-WHEN.

## North star (one sentence)
**Drive Atelier to a stable, 100%-complete, fully-navigable base — then WAKE the brain: it observes itself, the PMs, and projects on a budgeted tick, proposes safely through the operator's gates, and the operator can watch it think live at `/brain`.**

## DONE-WHEN (the three gates — all must hold)
1. **Stable + complete base.** The released hardening chain is green (periphery-svc ✅ → security-floor-2 → cost-governance-2 → cc-config-2), `safety-defaults` closed the uncapped-token hole, and the `COMPLETION-LEDGER` is burned down — every gap finished-or-specced, v1 retired, the 4 pre-existing test failures fixed. The four-check green bar holds zero-tolerance on a full run.
2. **Every feature reachable + honest.** Every user-facing feature is linked from clear navigation or a parent page — no orphan routes (`NAV-IA-MAP.md` is the tracker) — and every failure state is visible (F-008), every change versioned + auditable (D-042).
3. **The brain wakes (the eye).** Brain-Observer v1 ships: a real budgeted tick lands in the journal, `/brain` shows resting / thinking / sensor-offline honestly, cloud spend $0, and the operator can watch it. (Voice + council theater follow in v2/v3.)

## Two phases: 100% is a floor, 200% is a mode
- **100% = the floor (a hard, verifiable checkpoint).** The three DONE-WHEN gates above. We drive here FIRST, undisrupted. New ideas that arrive meanwhile are CAPTURED + SEQUENCED (grounded spec → BUILD-QUEUE/roadmap), never allowed to displace the floor. Capture-and-sequence IS the focus mechanism.
- **Beyond 100% → "200%" = the self-improving era (not a number — a mode).** Once the brain is alive + the self-improvement loop runs, Atelier proposes its OWN expansions (skills/tools/workflows/capabilities), each mined → validated → versioned → operator-adopted. The goal becomes self-extending: Atelier improves Atelier, under the operator's gates. "Toward 200%" is principled because it has an engine (observer + self-improvement-loop) and a gate (operator adopt, D-039).
- **The intake machinery (nothing lost, nothing skips the floor):** operator ideas → plan-refine; awake-brain ideas → self-improvement loop; the living backlog → BUILD-QUEUE + roadmap; traceability → versioning/audit (D-042).

## The sequence (stabilize → wake; do not skip)
P0 stabilize chain → P1 completion ledger → P2 build-everything burn-down + nav/accessibility/failure sweep → P3 substrate (safety-defaults, identity-compose, local-runtime-lifecycle, per-role-model, brain-observability) → P4 WAKE (observer v1 → arm) → P5 close the ring (release, maintain, n8n). Full detail: `COMPLETION-LEDGER.md` + the roadmap.

## Standing discipline (so focus holds)
- **Stabilize first.** Design specs are cheap (Fable) and may run parallel to builds, but the BUILD track is the released stabilize chain until the base is solid. Don't let spec-authoring displace shipping.
- Every planning-shaped prompt → the plan-refine loop (refiner → planner-with-questions). Every build → a v2-wave (BUILD → D-038 review → red-team where flagged → commit-on-green → push). Digest after every stretch.
- Autonomous changes stay propose-only through the operator's gates; publish + arm are operator-gated; spend stays capped + consented.

## The six design artifacts this ladders up to (all committed, v2-main)
`COMPLETION-LEDGER` · `BRAIN-OBSERVER-LOOP-SPEC` · `BRAIN-ALIVE-UI-SPEC` · `SELF-IMPROVEMENT-LOOP-SPEC` · `VERSIONING-AUDIT-SPEC` (D-042) · `NAV-IA-MAP`.
