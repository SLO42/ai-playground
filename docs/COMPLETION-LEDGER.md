# COMPLETION LEDGER — Atelier "100% + Alive" program

Source: 6 read-only Opus audit scouts over ~43 subsystems, 2026-07-23 (session on Opus; audits Opus). Every gap traces to a `file:line` in the v2 worktree. This is the finish-or-spec ledger for the [[project_atelier-program-alive]] program: each gap is **FINISH-NOW** (batched into a wave) or **SPEC-NEEDED** (grounded spec → queue). Operator rule: **build everything before wake** — so multi-wave gaps get BUILT, not just specced.

**Headline:** the codebase is mature and hardened (F-007/F-014/F-046/F-048 structural fixes + real-surreal tests; tokens-only accessible UI; honest states; gates clean — D-037/D-039/F-055/F-050 all real). No rebuild. The work is (1) analytics/failure VISIBILITY, (2) safety DEFAULTS, (3) ACTIVATION for wake, (4) a handful of polish + v1 cleanup, (5) two deferred live-capstones.

Cluster verdicts: DATA-CORE, EXECUTION, PRODUCT/PM, FRONTEND/UX = production-complete (polish-grade gaps). INTELLIGENCE = safe but PASSIVE (activation gaps). CROSS-CUTTING = wired but safety-defaults-off.

---

## Wave A — `analytics-visibility` (P2, FINISH-NOW) — the biggest cross-cluster theme
Enforces "analytics first-class + faces of failure visible." Touches many files; red-team not required (additive telemetry), but each add needs a happy-path test asserting the row/event is emitted.
- **HR/workforce emits ZERO scene_events** — `workforce/*` grep 0 hits. Emit screened `hire_*`/`cert_*` scene_event at adjudication (`workforce/auto-adjudicate.ts:25`) + brief-raise (`projects/recruiter-hire.ts`), mirroring `pm-autonomous.ts:340` `pm_tick`. **Hiring is currently invisible on the live stream.**
- **Concierge Stage-2 turn writes no `agent_event`** (`concierge/wire.ts:153`; `cg2b-…honesty.test.ts:7`). Add a concierge-turn event (intent, provider, grounded y/n, latency) — copy `routing/resolve.ts:456-482` (`writeRoutingEvent`) as the model.
- **Orchestrator drain-side faults are console-only** — `orchestrator.ts:498,561,718,744,823,848,902,1019,1097` + silent `complete().catch(()=>{})` (`:827,937,1149`). Emit a named `error` agent_event on each drain-side swallow so the queue/agents page surfaces them.
- **Enqueue/park/gate-block not first-class** — `workqueue.ts` 0 event writes; a task deduped (`enqueued:false`) or parked by per-project/token gate produces no row. Emit a `queue` event on enqueue-dedup + park + cap/budget block (with the cap snapshot).
- **Boot-skip invisible** — "orchestrator/PM loop NOT started" is `console.warn` only (`hooks.server.ts:322,~360`). Persist a boot-status row the `/atelier` or `/services` page renders honestly.
- **pm-review decisions not verifiably on the scene stream** (`pm-review.ts:66,103,211,286`) — add a review scene_event so the command-center reflects each review.
- **Test guard:** add happy-path tests asserting a hire adjudication + a pm-review + a concierge turn each emit their expected event (today a regression dropping them passes green).

## Wave B — `safety-defaults` (P0/pre-wake, FINISH-NOW) — HIGH priority, pull early
The "safe autonomous" holes. MUST be closed before P4 wake (arm-immediate plan makes these load-bearing).
- **Token spend ships UNCAPPED** — `config/orchestration.yaml` `spend.dailyTokenBudget: 0` + `perProjectTokenBudget: 0`. Enforcement is correct + single-chokepoint (`sessions/launch.ts:475` `enforceTokenBudget`) but OFF. Ship conservative non-zero defaults; while armed-and-uncapped, a loud UI banner.
- **Config-unreadable silently disarms the brain** — malformed `orchestration.yaml`/`workforce.yaml` → `mode='manual'` = all engines OFF, only `console.warn`. Surface a persistent "autonomy OFF: config unreadable" state in UI (+ boot-status row from Wave A).
- **PM distress trigger unarmed** — `config/workforce.yaml` `failure_threshold: null` → PM never auto-reviews on session-failed/task-blocked. Arm from real history (until then distress is silent to the loop).

## Wave C — `finish-small-polish` (P2, FINISH-NOW)
- **F-048 residue on `memory_review` enqueue** — `schema.ts:635`/`:2883` dedup_key still folds mutable `status`; route `loop.ts enqueueReview` through the deterministic-id enqueue (task_run path already fixed).
- **`/memory` uses deprecated `$app/stores`** (`memory/+page.svelte:12`) — migrate to SvelteKit 2 `$app/state` (only page not on it).
- **Stale Sidebar comment** ("Placeholder content… task 1.5") `Sidebar.svelte:5` — delete (nav is fully wired).
- **Raw session-hash ids** in home/agents (`+page.svelte:194-261`, `agents:692`) — add `title={full}` everywhere + prefer name when available.
- **Test-depth:** `merge-back` real-git integration test (F-007 "never lose commits" verified only vs fake runner); `explorer.ts` real-surreal happy-path (F-020/F-008 read surface untested directly); verify `benchmark/judge.ts:206,244` bare catch emits honest "unjudged", not a fabricated pass.

## Wave D — `v1-retirement` (P2, FINISH-NOW) — "modernized and clean"
Already clean: no `dashboard/`, no `src/lib/server/heartbeat/`, no live OpenClaw/gateway, no `gateway.yaml`, no stale fable ids in `agent-pool.yaml`.
- Delete/STALE-banner `ai-playground-v2/docs/DECISIONS.md` (35 entries, missing D-035..D-040, D-012 unresolved) → point to authoritative `ai-playground/docs/DECISIONS.md`.
- Remove `.playground/` from the v2 worktree after confirming no v2 reader (v2 state lives in SurrealDB, D-001).
- Rename `runtime/index.ts:5` "OpenClaw replacement seam" → neutral "provider seam" (only OpenClaw string outside tests).
- **Operator housekeeping (out of repo):** the user `MEMORY.md` still has an "OpenClaw Gateway Integration" section + v1 `dashboard/`/`heartbeat/` paths that re-seed v1 assumptions each session — worth a cleanup pass.

## Wave E — WAKE substrate specs (P3, SPEC-NEEDED → then build before wake)
- **brain-observer-loop** — the concierge is PASSIVE (`concierge.ts:9-11`; only wakes on inbound `to_kind:'atelier'` or PM-review consult). Net-new bounded observer loop: fleet/heartbeat event → concierge notices → proposes advisory unprompted, reusing `handleAtelierMessages` + advisory-write plumbing.
- **atelier-identity-compose (D-040)** — `peer/resolve.ts:131-170` `resolveAtelier` is a placeholder; compose a durable atelier brain session so consults reach a real identity, not an inbox stub. (Overlaps queued `concierge-broker`.)
- **per-role-model-config** — unify the 3 fragmented mechanisms (routing tier-by-complexity `resolve.ts:335-391`; lone `pm.model_id` `config/load.ts:520`; concierge `defaultProvider` `concierge.ts:800-828`) into one "brain vs hire vs task → model" role map. **Operator requirement: pick Claude vs local per role.**
- **model-role-effectiveness-analytics** — today effectiveness is provider-only (`analytics/provider-usage.ts:70-149`, `benchmark/store.ts:117-168`), never keyed by role. Add a role dimension (session→role→model join) so the operator sees "which model did which role, how well." **Operator requirement: reporting for growth.**
- **brain-observability / thinking-stream** — operator's arm-immediate plan REQUIRES the brain's live thinkings/comms/actions logged + surfaced (the safety net replacing a dry-run gate). Hard pre-wake dependency.

## Wave F — `pre-wake-gate-proof` (P3, FINISH-NOW) — prove every gate before P4 arm
A verification wave: tests + live checks that each gate the active brain presses is proven. Spend caps live (Wave B) + kill switch; F-055 arm/hire/publish/spawn/config routing (already census-tested — extend); D-039 born-proposed hires; D-026 fence on brain inputs + D-035a advisory-only output; D-015/D-028 propose-not-mutate. DONE WHEN every gate has a file:line + passing test.

## P4 — WAKE
`brain-loop` spec (the one genuinely new build on the critical path) → arm-immediate with Wave-E observability as the trail. Auto-hire stays OUT (D-039 per-hire approval) unless operator opts in.

## P5 — Close the ring + deferred live-capstones
- **release-pipeline** (queued RL-1..5) — the generic npm/tag real publish transcript is a **deferred live-capstone** (`release/pipeline.ts:24-26`; Thunderstore driver branch DOES execute for real). Prove one live gated publish.
- **autonomous 0→v1.0.0** — COMPLETE + tested via injected seams but **never run live** (`pm-autonomous.test.ts:410` stub gate). A gated live-capstone run on one real project.
- **maintain-phase** (queued) + **brain-authored n8n** (spec first, per operator: build later) — n8n = external-integration capability the awake brain authors via the proven proposal path.

---

## Already-queued waves that stay in the program
`periphery-hardening` (P0, SVC-1/2/3 resume — the auto-restart engine has NO production scheduler, `SVC-1` adds a bounded `services.tickMs` tick) → `security-floor-2` → `cost-governance-2` → `cc-config-2` (released chain, P0). Then `plan-refine` (PR-1..4, m0081, P2), `per-hire-soul`, `concierge-broker`, `memory-curator`, `game-verify-in-loop` (P3), `release-pipeline`, `maintain-phase` (P5). SkillOpt: **pilot spike first** (verify m0076/m0077 harness can inject an arbitrary skill vs frozen model w/ train/val/test splits) → full spec only if it discriminates.

## Cross-cutting enforcement (all waves)
Add 4 permanent checklist lines to the v2-wave reviewer `commonExtra` so EVERY wave's independent D-038 reviewer checks: (1) analytics first-class on every new decision path, (2) honest failure states + no silent catch without a happy-path test, (3) human-readable + accessible + design-tokens, (4) **REACHABLE — any user-facing surface is linked from nav or a nav-parent page (≤2 clicks), plain-language label, no orphan route (`NAV-IA-MAP.md`).** Pass/fail per feature, adjective-free.
