# Atelier Devlog

A durable, cloud-followable log of what shipped each working session — a second
source of truth alongside git history + `docs/` specs, so future revisions
(far beyond any one session) can follow the "why" and the sequence, not just diffs.

**Convention:** one file per session, `YYYY-MM-DD[-slug].md`, newest first below.
Each entry records: what shipped (with commit hashes), migrations, decisions made,
bugs caught / fails logged, and what's parked/next. Written at session close;
committed to `v2-main` (docs branch). Code lands on `v2`.

## Sessions

- [2026-07-11 — The hardening chain: waves 5–9, paused mid-9](2026-07-11-hardening-chain.md) — cost-governance-1b/cc-config/projects/adapter-framework GREEN + periphery 2/3 (operator pause); D-036 stale-catalog spawn hole closed, budget-gate race bounded, one brief dispatcher, dryRun required; F-051 ×3 recovered zero-loss; deferral waves cost-governance-2 + cc-config-2 queued.
- [2026-07-08 — The "spec everything" campaign: 10/10 specs](2026-07-08-spec-everything-campaign.md) — ORCHESTRATOR/PROJECTS/CC-HARNESS/ADAPTER-FRAMEWORK/DB-RUNTIME/COST-GOVERNANCE/CC-CONFIG/SECURITY-MODEL/SCANNER/SYNC/SERVICES specs, all opus-scout-grounded; coverage 15→27 FULL; 9 hardening waves queued gate:operator; headline finds: root-runs-runtime DB gap, null cost_usd, boot re-drain hole, slot-keyed run registry.
- [2026-07-07 — Operating manual + recovery-repo-harden](2026-07-07-operating-manual-recovery-harden.md) — rewrote CLAUDE.md as the Atelier v2 operating manual + 3 skills; recovery-repo-harden wave 4/4 (F-050 main-everywhere, F-048 concurrent-clobber, BL-R4 operator re-run path), pushed origin/v2.
- [2026-07-01 — Cognitive architecture + Concierge + model-switch/benchmark](2026-07-01-cognitive-concierge-model-switch.md) — S0–S4 complete, Concierge Stages 1–3 + consultation (chat + autonomous), local-vs-cloud model switch & benchmark, `/brain` view, 15 features shipped.
