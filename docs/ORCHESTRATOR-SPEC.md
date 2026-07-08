# ORCHESTRATOR-SPEC — the drain/claim/enqueue engine (work-queue)

**Status:** DRAFT (2026-07-08) · implements D-004/D-021 · carries F-014/F-020/F-026/F-048 · queued `orchestrator-hardening` (gate:operator)
**One-liner:** the event-driven orchestrator + durable `work_item` queue are BUILT and battle-hardened (deterministic-id dedup, CAS claim, triple-gated drain, guarded heartbeat transitions) — but boot-time recovery has a verified hole (no initial drain + reap-before-subscribe ordering), released work has no self-trigger, and the D-021 handoff-replay primitives sit unwired. This spec states the invariants that already hold and scopes the hardening wave that closes the boot gap.

Grounding: opus scout pass 2026-07-08 over `src/lib/server/orchestrator/` (all file:line cites verified against source at that pass). Code lives on branch `v2`, worktree `F:\code\ai-playground-v2`.

## 0. Scope & boundary

- **In scope:** `src/lib/server/orchestrator/` — `workqueue.ts` (644 ln), `orchestrator.ts` (1164 ln), `post-task.ts` (513 ln), `boot.ts` (463 ln), `reaper.ts` (128 ln), `semaphore.ts` (92 ln), `review.ts` (156 ln), `queue-monitor.ts` (275 ln), `game-verify-step.ts` (238 ln), `index.ts`; the `work_item` table (schema.ts m0012/m0018/m0019/m0020, :442–:684); the concurrency keys of `config/orchestration.yaml`.
- **Out of scope (owned elsewhere):** the task table + its state machine (`tasks/repo.ts` — PROJECTS-SPEC); session launch/worktree/merge-back internals (CLAUDE-CODE-HARNESS-SPEC); routing/`resolveRoute` (routing); PM triggers (PM-SPEC).
- **The seam:** the orchestrator OBSERVES task changes on the events bus, ENQUEUES `work_item` rows, CLAIMS them under three gates, SPAWNS sessions, and DRIVES the task heartbeat transitions via `tasks/repo.ts setStatus`. One task change ⇒ ≤1 enqueue ⇒ ≤1 spawn.

## 1. What's already BUILT (the substrate)

### 1.1 The durable queue (`workqueue.ts`)
- `WorkStatus` = `pending|processing|done|failed` (:27). Cwd-spawning work types = `['task_run','review']` (`CWD_SPAWNING_WORK_TYPES` :44) — the ONE source both the per-project bump-set and the claim park-set read.
- **Dedup is the deterministic primary id, NOT the UNIQUE index (F-026).** `activeWorkItemId(workType, session, dedupScope)` (:134) = `work_item:<sha256(work_type\0session\0dedup_scope)>` (NUL separator :124). Same work unit → same record id → the second concurrent CREATE collides atomically on the primary key. The id is **stable across pending→processing** — that is the F-048 status-transition fix. The `work_item_dedup` UNIQUE index over the computed `dedup_key` VALUE (m0019 :633) remains as belt-and-suspenders but is NOT the live guarantee (a secondary UNIQUE over a VALUE does not enforce under concurrent inserts on this SurrealDB build — workqueue.ts:99–118).
- `enqueue` (:179) disposition loop (:205–249): active twin ⇒ `{enqueued:false}` dedup; terminal twin ⇒ guarded reuse-reset `WHERE status IN [done,failed]` → pending (:221–229); absent ⇒ CREATE (:236) with `isWorkItemIdCollision` (:148) absorb → re-read.
- `claimNext` (:294) CAS (:338–352): `SELECT id, priority … WHERE status="pending" AND claim_token IS NONE ORDER BY priority ASC LIMIT 1` (priority projected — F-020), then record-targeted `UPDATE $cand SET claim_token=$t, status="processing", attempts+=1, claimed_at=time::now() WHERE claim_token IS NONE RETURN AFTER` — single-winner. Never `UPDATE … ORDER BY`.
- `complete` (:424) lease-guarded `WHERE claim_token = $t`.
- Daily-cap counter `spawnsSince` (:478) anchored on `claimed_at` — survives restarts, not fooled by old backlog.
- Recovery primitives: `gcStale` (:517) — processing stuck >1h → pending; terminal >7d → delete. `releaseSessionWork` (:576) — frees a dead session's processing twins → pending. `writeHandoff`/`recoverHandoffs` (:604/:632) — D-021 crash-handoff pair, **currently caller-less on the recover side** (§5 G3).

### 1.2 Conflict absorption on the drain path (F-014/F-048 — never crash the server)
- `isWorkItemIdCollision` (:148–155): `/record …already exists/i` ‖ `/failed transaction|read or write conflict|can be retried/i` ‖ `/work_item_dedup|already contains/i` — narrow, wraps ONLY the deterministic-id CREATE; anything else re-raises named (F-008).
- `claimNext` retry catch (:357): `/conflict|can be retried|retry|failed transaction|work_item_dedup|already (contains|exists)/i` → backoff `2*(attempt+1)`ms + continue. Lost-CAS re-check (:363–382) recounts under the same gate; 0 remaining → null.
- `#onTrigger` (orchestrator.ts:462–469) is fire-and-forget with a catch-all log+swallow — an unhandled rejection here would kill the Node process; a later trigger re-checks.

### 1.3 The drain loop (`orchestrator.ts`)
- Modes (D-004): `event` (default) / `periodic` / `manual`. `start()` (:395) subscribes to the bus filtered `db_change` + topic `task` (:404) — the ONLY observation path (never its own live query; no double-fire). Periodic timer armed only when `mode==='periodic' && intervalMs>0` (:408). Manual subscribes to nothing.
- `drain()` (:563–624): re-entrancy collapsed via `#draining`/`#redrain` (:565–568). Three gates per iteration, in order: **① daily cap** (:582, `concurrency.dailySpawnCap` default 200, 0=uncapped) → **② semaphore** `#sem.tryAcquire` (:585, `concurrency.maxAgents` default 8, in-process) → **③ per-project in-flight** via `claimNext({excludeProjectIds})` (:592) — only cwd-spawning types are park-gated, filtered inside the claim SELECT (workqueue.ts:336); `concurrency.perProject` default 3 (WI-1..3 worktree isolation retired the F-046 perProject=1 stopgap). `#bumpProject` at claim (:612); `#dropProject` in `finally` (:990) on EVERY exit path.
- Drain trigger sites (exhaustive): bus trigger (:463–464), permit release after each `#runItem` (:679/:994), periodic timer (:411), operator `project-controls.ts:152/:334` (Continue / re-drain). **There is NO boot-time drain** (§5 G1).

### 1.4 The spawn + heartbeat chain (`#runItem` :637–996 → `post-task.ts`)
- Dispatch by work_type (:663): `memory_review` → fast-tier writer fork (:664); `hire_request` → PM→HR draft, propose-only (:692); `task_run` (:710+):
  1. task ready→in_progress via `setStatus` (:742) BEFORE spawn; `preStateEligible` captured (:746).
  2. `#route` (:755) writes `routing_event` before spawn; `launchSession({…, parentEventId: item.id})` (:756) threads the m0067 queue→session lifecycle-graph edge.
  3. **HB-H2 divergence gate** (:802): post-task enabled AND task moved out of eligible pre-state → refuse commit, `ok=false`, error event reason `post-task-divergence` (:809–822). Else `runPostTask` (:856).
  4. `runPostTask` (:283): guarded terminal txn FIRST (:302–313, `IF $cur IN ["in_progress","review"]` → done|failed); `!landed` ⇒ divergence — no commit/test/follow-up, error event `post-task-divergence-midrun` (:339). Then git commit via `execFileRunner` (:66 — arg arrays, no shell, never push/`--force`), `test_command` (:215), optional follow-up work_item (dedupScope: taskId) when test failed AND `followUpOnTestFail` (boot passes it OFF — §5 G4), completion event with commit sha + test outcome in a re-checked txn (:162–174).
  5. GAME-VERIFY (:885) only on clean-done + declared harness; a non-pass is a follow-up, NEVER a hard fail.
  6. Merge-back (:924, WI-3 FF-or-preserve).
  7. `finally` (:933): `complete(ok?done:failed)` (:934); failsafes `resetStuckTaskToFailed` (:950, BL-R2) / `resetStuckTaskToDone` (:973, BL-R3) — guarded + idempotent so no task strands; `#dropProject` (:990); permit release + `void drain()` (:993–994).

### 1.5 Crash recovery (`reaper.ts` + boot wiring)
- `reapStaleRuns` (:57): session+workflow_run `running` started before boot instant → failed + `REAPED_NOTE` + ended_at; per session (all per-session try/catch, F-014): error event (:90), `releaseSessionWork` (:106), `resetStuckTaskToReady` (:118).
- Boot order today (hooks.server.ts): `reapStaleRuns` (:243) **BEFORE** `startOrchestrator` subscribes (:278) — the reaper's ready-task db_changes are emitted before the subscription exists (§5 G1).
- `gcStale` wired as one-shot boot `gc().catch` + ~5min unref'd maintenance backstop (`startMaintenance` :501) — the backstop only un-sticks rows; it does NOT drain.

## 2. Normative invariants (the spec's contract — a change violating one is a defect)

1. **Bus-only observation.** The orchestrator never opens its own live query. One task change ⇒ ≤1 enqueue ⇒ ≤1 spawn.
2. **Dedup = deterministic primary id** (F-026), stable across pending→processing (F-048). The UNIQUE index is advisory. Any new work_type keys its id through `activeWorkItemId` with an explicit dedup_scope.
3. **Claim = SELECT-then-claim-by-id** under record-targeted `WHERE claim_token IS NONE` CAS. Never `UPDATE … ORDER BY`; every `ORDER BY` field is in the projection (F-020).
4. **Drain is trigger-driven + bounded** — three gates in fixed order (daily cap → semaphore → per-project); never a busy loop (D-004/D-017).
5. **A DB fault on the drain path never crashes the server** (F-014). Every claim/enqueue/complete absorbs UNIQUE/conflict as retry/no-op; non-conflict errors re-raise NAMED (F-008) — the absorb regexes stay narrow.
6. **One source for the cwd-spawning set** (`CWD_SPAWNING_WORK_TYPES`): bump-set and park-set never diverge; `#dropProject` runs on every `#runItem` exit path.
7. **The heartbeat owns task terminality**: ready→in_progress before spawn; →done|failed only from `in_progress|review` in a guarded txn; BL-R2/BL-R3 failsafes guarantee no stranded task.
8. **Divergence is observable, never silent** — a task moved out of eligible pre-state (claim-time or mid-run) refuses the commit/done and records an error event with a named reason.
9. **Best-effort side loops never change the spawn verdict** (post-task follow-up, game-verify, merge-back, skill-harvest, scene events).
10. **Daily cap anchors on `claimed_at`** — restart-proof, backlog-proof (D-021).

## 3. Config surface (`config/orchestration.yaml` via `config/load.ts loadOrchestration`)

`mode` (event|periodic|manual, default event) · `triggers: [task_created, task_unblocked]` · `intervalMs` (periodic only, 60000) · `defaultProvider: auto|local|cloud` (benchmark A/B; restart to apply) · `concurrency.{maxAgents: 8, perProject: 3, dailySpawnCap: 200}` · intent-adaptive `bundles` (D-020; capability ids must exist in a SYNCED catalog scope or spawn fails closed — F-045). Validated in `config/load.test.ts` (:163–194) incl. the WI-4 perProject>1 regression.

## 4. Events / analytics (first-class per the mandate)

- `routing_event` — every spawn, written by `resolveRoute` BEFORE the session, with rationale + intent.
- `completion` agent_event — post-task happy path (post-task.ts:451, commit sha + test outcome); game-verify pass (game-verify-step.ts:168).
- `error` agent_event — claim-time divergence (orchestrator.ts:809), mid-run divergence (post-task.ts:339 + post-commit re-check :205), reaper (reaper.ts:90), game-verify fail (game-verify-step.ts:224).
- Spawn parentage: `parentEventId: item.id` (orchestrator.ts:787) → the m0067 queue→session lifecycle-graph edge.

## 5. Gaps → the hardening wave (`orchestrator-hardening`, gate:operator)

| id | gap (verified) | required behavior | shape |
|---|---|---|---|
| **ORH-1** | **Boot re-drain hole.** `startOrchestrator` (boot.ts:310) never calls `drain()`; `reapStaleRuns` (hooks.server.ts:243) resets tasks→ready BEFORE the subscription exists (:278) — pre-existing ready tasks + reaper-reset tasks are never auto-drained at boot; recovery waits on a later event or the operator. | After subscribe (event/periodic modes only), run ONE bounded boot drain: enqueue all currently-ready tasks (reuse the `continueReadyTasks` enumeration shape) + drain pending work_items. Idempotent by construction (deterministic-id dedup absorbs re-enqueues). Manual mode: unchanged. Emits a named boot-drain analytics event with counts. | build (red-team; real-surreal test: seed ready task + pending item, boot, assert both drained with no event fired) |
| **ORH-2** | **Released work has no self-trigger.** `releaseSessionWork` resets twins→pending but nothing drains them; the 5-min backstop only un-sticks rows. | After a successful release with n>0 freed items, nudge the active orchestrator (`activeOrchestrator()?.drain()` fire-and-forget, F-014-swallowed). ORH-1's boot drain covers the boot-time reaper case; this covers runtime callers. | build (small; test: release → drain observed) |
| **ORH-3** | **Handoff replay unwired.** `writeHandoff`/`recoverHandoffs` (workqueue.ts:604/:632) tested but `recoverHandoffs` has no boot caller — boot recovery relies on reaper+gcStale only. | DECISION for operator: (a) wire `recoverHandoffs` into boot after reap (D-021's crash-safe-handoff intent), or (b) retire the pair as superseded by reaper+gcStale+deterministic-id dedup and delete dead code. Scout evidence: current recovery paths cover the known crash classes; (b) is defensible. Recommend (b) unless a handoff payload carries state the queue row doesn't. | decision → then build |
| **ORH-4** | `followUpOnTestFail` supported by `runPostTask` (default true) but boot passes OFF (boot.ts:153–156) — a failing test never auto-plans a fix follow-up. Deliberate (unbounded-loop fear). | Documented-off stays. Future (NOT this wave): bounded retry — follow-up carries an attempt count, cap 1, then `blocked` + PM notify. Park as backlog row. | documented; parked |
| **ORH-5** | Semaphore is in-process — `maxAgents` not shared across processes (daily cap + per-project gate ARE DB-backed). | Accepted constraint: single-process deployment (D-025 loopback, one server owns the DB). State it; assert single-orchestrator via the `setActiveOrchestrator` registry. No build. | documented |

## 6. Test coverage map

Real-surreal (spin actual SurrealDB): orchestrator.live, post-task.live, workqueue, reaper, queue-monitor, fast-tier-drain, hire-request-drain, game-verify-*, routing-wire, review. `orchestrator.test.ts` (1710 ln) mixes fakes for launch/runtime with a real DB for queue behavior. `semaphore.test.ts` pure unit. Covered classes: claim CAS, F-026 dedup collisions, daily-cap window, gcStale/releaseSessionWork, F-020 ORDER-BY-projection. **New tests required by the wave:** ORH-1 boot-drain (seed-before-boot), ORH-2 release-nudge — both real-surreal (a stubDb cannot parse the queue SurrealQL — F-020 rule).

## 7. DoD (D-038) for the hardening wave

- [ ] ORH-1/2 land with real-surreal tests incl. the seed-before-boot case; no new migration (no schema change).
- [ ] Boot drain is idempotent (dedup absorbs), bounded (respects all three gates), and emits an honest analytics event.
- [ ] No change to invariant §2.1 (bus-only; the boot drain is a one-shot, not a poller).
- [ ] ORH-3 decision recorded in DECISIONS.md (additive note on D-021) before its code lands.
- [ ] `npm run db:up` clean live; gates green token-unset (F-029); devlog row.
