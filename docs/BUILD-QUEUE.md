# BUILD-QUEUE — the machine-readable wave chain (orchestrated looping, operator-authorized)

> Standing directive (operator, 2026-06-10): **the build factory runs autonomously** — when a wave lands green (all DoD reviews passed, pushed), the next QUEUED wave launches WITHOUT a per-wave ask. Stops are deviation-driven only: a review failure that exhausts its fix-loop, a CONFLICT/BLOCK deviation, or an item marked `gate:operator`. Cross-session continuation via scheduled wakeup; every autonomous stretch ends with a digest of verdicts/commits/deviations.
>
> Maintained by the orchestrating session. One line per item: `status | id | what | gate`.
> status: done / running / queued / blocked. gate: auto (chain through) / operator (stop and ask).
>
> **Why a doc and not the database (operator-discussed 2026-06-10):** the build factory must not store its control state inside the thing it is building — waves migrate/reset/wedge the dev SurrealDB (F-015 wedged `db:up` itself), and D-001's boundary cuts both ways (product never parses harness files; harness doesn't write product tables). Git-tracked markdown needs zero infrastructure and versions with the decisions behind each item. **End state = D-040 self-hosting:** this queue becomes `task`/`sprint` rows in `atelier_self`, owned by the PM inside the product; this doc then retires to a read-only cold-boot projection.

| status | id | what | gate |
|---|---|---|---|
| done | wave-14.x | v2.0 audit remediation + full-viewport ✅ 6/6 (d7f0506, 4995d58+edf4ff4, 3a48c7c, 487b5a6, 16e8283, eab1961 — pushed) | auto |
| done | lane-A-docs | HARVEST Lane A-docs ✅ 14/14 applied, review PASS (dc7239b pushed) | auto |
| running | lane-A-code | HARVEST A4/A7: wave-script escalation tier + verdict self-check — reviewed as code | auto |
| queued | lane-CD-specs | Lane C+D spec amendments: PM-SPEC decision-classification/scope-challenge/brief-format; CREATE-SPEC anti-sycophancy list | auto |
| queued | wave-v2.2a | B1 scope-lock gate · B3 browser live-verify daemon · B9 verify-flow codification | auto |
| queued | wave-v2.1 | PM build (PM-SPEC §8): pm table+hire+charter · trigger engine · proposed-task pipeline+panel · GitHub triage · W-D7a/W-D7b/W-D7c workforce (WORKFORCE-SPEC) | auto |
| queued | wave-v2.2b | B2 review memory · B4 §3.1b verify + leak harness · B5 recall budget · B6 quarantine · B7 capability-gated guidance · B8 baselines · B10 memory pull-tool | auto |
| queued | wave-v2.3 | WORKFORCE-SPEC §5 performance loop · §6 project_staff · §7 tier hiring (+ missed-defect ledger after B2) | auto |
| queued | self-hosting | D-040: ingest the docs suite into Atelier's own memory for project atelier_self + hire its PM (fable-5) — Atelier maintains itself | operator |
| queued | swip-develop | Atelier makes REAL progress on SWIP (or a new ROUNDS mod) through the product's own develop loop — PM hired for SWIP proposes the work (post-v2.1; the outermost "real usage" loop) | operator |
| blocked | first-publish | SWIP first real Thunderstore publish — **STAGED AT GATE 2026-06-10, deferred by operator until swip-develop ships real changes.** Prepared state: project registered (`project:thunderstore`, "SWIP (ROUNDS mod)", root F:\code\mods\rounds-mod\thunderstore), target `project_target:szn709rvw27ypyotpv0d` (BasicallyCoding/rounds/custom-cards, default), token present, manifest bumped 2.3.2→2.3.3 (SWIP-repo-local commit `9b470f6`, NOT pushed), dll staged at thunderstore\plugins\SWIP.dll (untracked, includes uncommitted src/Cards changes — REBUILD from committed code before shipping), dry-run green 0-blockers. Re-bump version if SWIP develops further before publishing. Old GitHub CI diverges (stale tracked SWIP.dll) — retire or update before any v-tag push. | operator |

Standing rails for every autonomous stretch: v2-wave template only (fix-loops + auto-push), F-014 server discipline, no real external publishes without the operator's gate confirm, docs commits to v2-main / code to v2, memory + this file updated at every wave boundary.
