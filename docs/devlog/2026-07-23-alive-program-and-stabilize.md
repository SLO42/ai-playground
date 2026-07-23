# 2026-07-23 — The "Atelier Alive" program: full design suite + the stabilize chain completed

**Theme:** the operator lifted the 2026-07-11 pause, consented to spend, and set the north star — drive Atelier to a stable, 100%-complete, fully-navigable base, then WAKE the brain (observe → propose → the operator watches it think). Fable-5 orchestration session on an Opus main loop; every build/review/red-team on Opus via `v2-wave.js`; every planning artifact authored by a spawned Fable planner through the plan-refine loop. Two tracks ran in parallel: **design** (six specs) and **build** (the released hardening chain, completed).

## Shipped — BUILD (code on v2, all pushed; hardening chain COMPLETE)
| wave | verdict | commits (origin/v2) | headline |
|---|---|---|---|
| periphery-svc | ✅ 3/3 GREEN | `1468b99..aea9da4` | Production scheduler for the services auto-restart engine (bounded/unref'd/single-flight ticker, `services.tickMs` 0=off) + first-class `supervision` `agent_event` (migration **m0081**, live db:up 81/81); phantom `engine` dropped from SERVICE_NAMES. Fresh wave over the paused dirty worktree (verify-don't-redo). |
| security-floor-2 | ✅ 4/4 GREEN (redTeamAll) | `51d0ad2..b3a92e7` | Least-priv runtime DB user seam (authLevel:'database', additive opt-in, byte-identical unset) · authz-vs-expiry narrow · **loopback spoof-resistance** (red-team fix: fail closed when a proxy fronts the app / ADDRESS_HEADER set) · atomic guardrails write + root_path re-confine + `git -C` push-deny. |
| cost-governance-2 | ✅ 4/4 GREEN (redTeamAll) | `c574ad5..2253197` | Concierge Stage-2 turn METERED (feeds the budget; cloud=real cost, local=honest $0; fix-loop corrected 2 false "un-metered" docstrings with a code-coupled honesty guard) · scope-aware 402 label · COALESCE project attribution · honest publish cost line. |
| cc-config-2 | ✅ 2/2 GREEN (redTeamAll) | `facd9bf..5f39927` | Stale-allow-list hole closed (a skill deleted on disk leaves the D-036 catalog + fails closed; honest freshen) · per-spawn immutable catalog snapshot (no torn id-set under concurrent drains). |

**Released 2026-07-08 hardening chain is now fully GREEN + PUSHED.** origin/v2 tip `5f39927`.

## Migrations
`m0081_agent_event_supervision` (widens `agent_event.type` ASSERT for the `supervision` event) — live db:up 81/81 clean. CLAUDE.md migration-head note updated m0080→m0081.

## Shipped — DESIGN (docs on v2-main; the full "alive + self-improving" architecture)
- `GOAL.md` — north star + 3-gate DONE-WHEN; two phases (100% floor → 200% self-improving mode); stabilize-first discipline.
- `COMPLETION-LEDGER.md` — 6-cluster read-only audit of ~43 subsystems (verdict: mature/hardened, not a rebuild). 4th cross-cutting reviewer check added (reachability).
- `BRAIN-OBSERVER-LOOP-SPEC.md` — the passive→active wake: budgeted tick, two-tier (local sense / cloud propose), council readers, authority-split routing, rejection ledger + two-phase curation gate, 15 safety invariants, v1(eye)/v2(voice)/v3(depth).
- `BRAIN-ALIVE-UI-SPEC.md` — the "alive and watching" layer: `brain_activity` SSE narration, resting vitals, council theater, Think-Now/focus/cadence-raise; "alive is a presentation layer, not a hotter brain."
- `SELF-IMPROVEMENT-LOOP-SPEC.md` — one spine (measure→propose→validate→adopt) for skill/workflow/tool/rejection/model-role improvement; conversation mining behind the D-026 fence; the anti-"wrong ideas" validation gate.
- `VERSIONING-AUDIT-SPEC.md` → **DECISION D-042 LOCKED** — every capability artifact versions with a server-stamped, unforgeable audit trail (source/reason/when/supersedes); generalizes existing `role_version` prior art; `session.artifact_versions` gives effectiveness attribution + regression tracing.
- `NAV-IA-MAP.md` — every specced feature mapped to a UI home + nav path; no orphan routes.

## Decisions
**D-042 LOCKED** (versioned capability artifacts + server-stamped audit trails). Plus the plan-refine loop shipped as a session skill (`.claude/skills/plan-refine/SKILL.md`) with its Atelier twin queued.

## Bugs / fails
- No new F-entries. Red-team catches fixed in-wave (never reached main): SF2-3 loopback spoof (proxy-fronted fail-open) fixed in-loop; CG2-1 two false "un-metered" docstrings corrected by the fix-loop with a regression-guarded honesty test.
- **4 pre-existing full-suite failures** surfaced by periphery-svc on clean v2 HEAD (NOT introduced): brain `onDbChange` census, memory/soul.ts FROM-memory census, 2 pm/loops teardown flakes → logged to `finish-small-polish`.

## Deferral ledger (chained, per the 2026-06-13 red-team policy)
`security-floor-3` (db-up.ts stale operator handoff, MEDIUM) · `cost-governance-3` (concierge turn un-metered on the timeout/error path, MEDIUM) · cc-config-2 deferral was all-LOW (no chain).

## Docs / trackers
BUILD-QUEUE: released chain flipped done; program waves queued (safety-defaults, analytics-visibility, finish-small-polish, v1-retirement, brain-observer-loop + deps, self-improvement-loop, versioning-audit, plan-refine, skillopt-pilot, n8n-spec). Statusline rewritten honest (exact model + live chain state + v2 worktree dirty flag). Standing rule added: avoid inline edits / always spawn agents.

## End-gate
PASS for all four hardening waves (each independently D-038-reviewed, red-teamed, gates green inside the wave, pushed). Released chain end-to-end green.

## Parked / next (operator's signal)
1. **`safety-defaults`** — the pre-wake MUST: set NON-ZERO default token budgets (currently `dailyTokenBudget:0`/`perProjectTokenBudget:0` = uncapped). The BUDGET NUMBERS are an operator spend-policy decision — surfaced, not guessed.
2. Then the small deferrals (security-floor-3, cost-governance-3) + the completion-ledger waves (analytics-visibility, finish-small-polish, v1-retirement) → the verified 100% floor.
3. Then P3 substrate → P4 WAKE (observer v1, the eye). Operator-gated: brain arm, D-042 build release, publish.
