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
| done | lane-A-code | HARVEST A4/A7 ✅ red-team pass + verdict artifact gate (3cd2755; reviewer caught F-016 host-load brick via real-loader extraction) | auto |
| done | lane-C-specs | Lane C ✅ 4/4 (80ed54c): decision classification w/ Operator-Challenge supremacy, scope challenge (null tunables), ONE canonical brief format, anti-sycophancy in-rail | auto |
| done | wave-v2.2a | ✅ 3/3 (pushed, tip `fa69d4a`): 15.1 scope-lock gate (`dde4f1c`+fix `231f411` — red-team's FIRST outing caught 3 fail-open bypasses incl. `..`-in-rm-exception + `>|` clobber; re-review ran 15 novel probes) · 15.2 browser daemon `464b815` · 15.3 verify-flows `6031bbe`+fix `fa69d4a` | auto |
| running | wave-v2.1 | THE PM + WORKFORCE (run wf_3750eae5-068, 7 tasks): 16.1 pm identity/hire/charter (Fable 5) · 16.2 trigger engine · 16.3 W-D7a data plane · 16.4 proposed-task pipeline + panel (redTeam) · 16.5 GitHub triage · 16.6 W-D7b gauntlet engine (redTeam) · 16.7 W-D7c roles/fixtures/ceremony-prep/UI. Day-0 ceremony itself = gate:operator after the wave | auto |
| queued | wave-v2.2b | B2 review memory · B4 §3.1b verify + leak harness · B5 recall budget · B6 quarantine · B7 capability-gated guidance · B8 baselines · B10 memory pull-tool | auto |
| queued | wave-v2.3 | WORKFORCE-SPEC §5 performance loop · §6 project_staff · §7 tier hiring · **§7b researcher role + research rails** (+ missed-defect ledger after B2) | auto |
| queued | self-hosting | D-040: ingest the docs suite into Atelier's own memory for project atelier_self + hire its PM (fable-5) — Atelier maintains itself | operator |
| queued | wave-create-ai | Build Create-with-AI per CREATE-SPEC (post-v2.1; PM-hire hand-off needs D-039). First customer locked (operator 2026-06-10): a NEW ROUNDS mod based on SWIP — exercises the §2.1 reference-repo hint (read SWIP as prior art, generate fresh scaffold; greenfield-with-reference, NOT adoption). Resolves fork 3 in practice: PM hire ON for the test | auto |
| queued | new-mod-test | THE graduation test (operator): create the new ROUNDS mod VIA Create-with-AI → its PM proposes founding work → Atelier develops it → its 1.0.0 becomes the platform's FIRST REAL PUBLISH (supersedes re-shipping SWIP 2.3.3 as the inaugural release; SWIP's staged publish stays parked). Full lifecycle: create → develop → release | operator |
| blocked | first-publish | SWIP first real Thunderstore publish — **STAGED AT GATE 2026-06-10, deferred by operator until swip-develop ships real changes.** Prepared state: project registered (`project:thunderstore`, "SWIP (ROUNDS mod)", root F:\code\mods\rounds-mod\thunderstore), target `project_target:szn709rvw27ypyotpv0d` (BasicallyCoding/rounds/custom-cards, default), token present, manifest bumped 2.3.2→2.3.3 (SWIP-repo-local commit `9b470f6`, NOT pushed), dll staged at thunderstore\plugins\SWIP.dll (untracked, includes uncommitted src/Cards changes — REBUILD from committed code before shipping), dry-run green 0-blockers. Re-bump version if SWIP develops further before publishing. Old GitHub CI diverges (stale tracked SWIP.dll) — retire or update before any v-tag push. | operator |

Standing rails for every autonomous stretch: v2-wave template only (fix-loops + auto-push), F-014 server discipline, no real external publishes without the operator's gate confirm, docs commits to v2-main / code to v2, memory + this file updated at every wave boundary.

## Backlog (unscheduled, in operator-set order — spec before build, none scheduled)

| # | item | notes |
|---|---|---|
| BL-1 | **Image-generation addition** | Operator-referenced as already backlogged (2026-06-11) but no prior written record found in queue/docs/memory — recorded here so it exists. Scope unspec'd: likely a capability/adapter for generating images (mod icons, store assets, UI art?) consumable by projects + Create-with-AI. Needs a spec when promoted. |
| BL-2 | **Marketing features** | Operator (2026-06-11): hook in marketing features for maintained projects that need them — "a massive lift to even consider." Ordered explicitly AFTER BL-1. Natural shape when its time comes: a D-037-style adapter/capability family (channels as adapters, content as artifacts, PM proposes campaigns through D-039 validation) + likely new roles (copywriter?) via WORKFORCE-SPEC. Needs a full spec + deliberation when promoted; do NOT scope-creep it into earlier waves. |
