# Atelier Devlog

A durable, cloud-followable log of what shipped each working session — a second
source of truth alongside git history + `docs/` specs, so future revisions
(far beyond any one session) can follow the "why" and the sequence, not just diffs.

**Convention:** one file per session, `YYYY-MM-DD[-slug].md`, newest first below.
Each entry records: what shipped (with commit hashes), migrations, decisions made,
bugs caught / fails logged, and what's parked/next. Written at session close;
committed to `v2-main` (docs branch). Code lands on `v2`.

## Sessions

- [2026-07-07 — Operating manual + recovery-repo-harden](2026-07-07-operating-manual-recovery-harden.md) — rewrote CLAUDE.md as the Atelier v2 operating manual + 3 skills; recovery-repo-harden wave 4/4 (F-050 main-everywhere, F-048 concurrent-clobber, BL-R4 operator re-run path), pushed origin/v2.
- [2026-07-01 — Cognitive architecture + Concierge + model-switch/benchmark](2026-07-01-cognitive-concierge-model-switch.md) — S0–S4 complete, Concierge Stages 1–3 + consultation (chat + autonomous), local-vs-cloud model switch & benchmark, `/brain` view, 15 features shipped.
