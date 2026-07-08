# PROJECTS-SPEC — the project/task data-plane (plan hierarchy · task lifecycle · PM adjacency · operator gates)

**Status:** DRAFT (2026-07-08) · implements D-039 (task authority) · carries F-013/F-050/F-055 · queued `projects-hardening` (gate:operator)
**One-liner:** the biggest subsystem (~18k loc across `projects/` + `tasks/repo.ts`) is fully built and real-surreal-tested — plan hierarchy, the nine-state task machine, the D-039 proposed→ready promotion (panel + brief), repo-creation and release gates, the autonomous loop. What was never written down is the CONTRACT: who may mint which status, the two promotion paths, the two normalizer families, and the one deliberately-asymmetric arm gate. This spec states it, and scopes the one real unbuilt seam (non-task decision briefs).

Grounding: opus scout pass 2026-07-08 (file:line verified). Code on branch `v2`, worktree `F:\code\ai-playground-v2`.

## 0. Scope & boundary (the first thing to know)

- **The `task` table CRUD + status state machine does NOT live in `projects/` — it lives in `src/lib/server/tasks/repo.ts`.** `projects/` owns the project-plan hierarchy (project/release/phase/feature/sprint) and the entire PM subsystem.
- **In scope:** `src/lib/server/projects/` (19 source files + index), `src/lib/server/tasks/repo.ts`, `src/lib/server/loops/arm-gate.ts` (the F-055 gate), the command-center route `src/routes/projects/[id]/+page.server.ts`, tables project/task/sprint/task_sync + the pm cluster (schema.ts).
- **Out of scope (owned elsewhere):** work_item queue + drain (ORCHESTRATOR-SPEC); PM behavior/cadence internals (PM-SPEC/WORKFORCE-SPEC); workforce tables (panel_verdict/role/role_event/project_staff); release adapter internals (RELEASE-SPEC); Create-with-AI scaffolding internals (CREATE-SPEC).

## 1. What's already BUILT (the substrate)

### 1.1 File inventory (grouped)
- **Plan hierarchy + normalizers:** `repo.ts` (734 ln) — `createProject`:467, `getProject`:487, `listProjects`:492, `updateProject`:511, `updateProjectPlan`:536, `createSprint`, `parseGameVerifyConfig`:153; `PROJECT_STATUSES`:31.
- **Task CRUD/state machine:** `tasks/repo.ts` — `TASK_STATUSES`:31 = `[proposed, backlog, ready, in_progress, review, blocked, done, failed, withdrawn]`; `ALLOWED_TRANSITIONS`:60; `canTransition`:79; `createTask`:216; `setStatus`:332 (ONE guarded txn, throw-rollback ⇒ no db_change on an illegal move); `normTask`:184.
- **PM cluster:** `pm-repo.ts` (823) identity/memory/decisions + arm setters (`setPmAutonomous`:616, `setPmAutoPublishPreauthorized`:639, `setPmRepoCreatePreauthorized`:663); `pm-proposals.ts` (400) — `proposeTask`:187 the ONLY minter of `proposed`, `proposalFingerprint`:95; `pm-panel.ts` (899) — `runValidationPanel`:404, `applyBriefDecision`:~775; `pm-autonomous.ts` (853) — `AutonomousPmLoop`:167 (event-driven, bus-is-clock:44, re-tick cap 24:114); `pm-triggers.ts` (703); `pm-review.ts` (430); `pm-triage.ts` (432, triage-only per D-039); `pm-lifecycle.ts` (389) + `pm-lifecycle-lock.ts` (158, 15-min stale lock:32); `pm-hire.ts` (303); `pm-session.ts` (190); `pm-concierge.ts` (412) + `concierge-advisories.ts` (217, advisory/non-steering).
- **Operator controls & gates:** `project-controls.ts` (337) — `continueReadyTasks`:123, `restartSessionTask`:245; `release-gate.ts` (354) — `runReleaseReadinessGate`:126; `repo-creation-gate.ts` (537) — `runRepoCreationGate`:153 staged `consent→token→auth→private→create→remote→url`; `repo-create-proposal.ts` (355); `briefs.ts` (350) — `decision_brief` repo.

### 1.2 Tables (schema.ts; head m0080)
- **project** m0001:26 — slug UNIQUE:78, root_path, repo_url?:36, status DEFAULT "active":37, plan{purpose,long_term_vision,role,definition_of_done}:42–46, `game_verify` FLEXIBLE m0068, `create_status` m0049 ('incomplete' = mid-scaffold Create-with-AI resume affordance — a project row may exist half-wired).
- **task** m0002:84 — status DEFAULT "backlog":91, priority "normal":93, origin "manual":95 (+'pm'), parent?:97; idx by_project/by_status/by_project_status:101–103. **§4.1 Act-with-Purpose fields m0032:1225–1260** — objective, purpose, acceptance_criteria, provenance, proposed_by, revision_of, superseded_by, proposal_fingerprint (+idx:1260). **No status ASSERT (enum enforced in TS) and no dedup_key VALUE — task dedup is structural** (fingerprint idx + open-proposal absorb), not a D-008 VALUE key.
- **sprint** m0001:72 + status ASSERT/completed_at m0023:739.
- **task_sync** m0024:757 — dual VALUE keys:778/781, UNIQUE `task_sync_task`:785 (one task ↔ ≤1 provider-repo).
- **pm cluster:** pm:989 (cadence:997/offset:998; `autonomous` m0057:2097; `auto_publish_preauthorized` m0058:2128; `repo_create_preauthorized` m0062:2272 — both NONE-backfilled), pm_memory:707, pm_review:814, pm_lifecycle_lock:2070, decision_brief:1267.

### 1.3 Normalizers — TWO families, DIFFERENT absent-handling (F-013)
- `projects/repo.ts` `isoOrUndef`:383 — datetime→ISO, **omit when absent**: `normProject`:340, `normSprint`:388, `normRelease`:359, `normPhase`:362, `normFeature`:372.
- `tasks/repo.ts` `normTask`:184 — **`str()`-coerces** created_at/updated_at, safe ONLY because task datetimes carry non-NONE DEFAULTs. **Rule: a new OPTIONAL datetime on task must use the isoOrUndef pattern, never `str()`** (`str(undefined)` renders fake UI text — the F-015 lesson).
- The command-center load has a third local `isoOrNull` (`[id]/+page.server.ts`:~228) — candidate for consolidation, not a defect.

## 2. The task lifecycle contract (normative)

### 2.1 Birth — exactly three paths
1. **Manual** `createTask` (tasks/repo.ts:216) → born `backlog` (schema DEFAULT), origin `manual`.
2. **PM-proposed** `proposeTask` (pm-proposals.ts:187) → born `proposed`, origin `pm`, §4.1 contract enforced (`ProposalContractError`:47); same-fingerprint open proposal absorbed as `duplicate_open` (:206–215). **`proposeTask` is the ONLY minter of `proposed`** — nothing transitions INTO `proposed` (ALLOWED_TRANSITIONS:60).
3. **Create-with-AI founding tasks** (create/execute.ts:1394): `wantPm||existingPm ? 'proposed' : 'ready'`. The old "founding tasks land un-promotable" gotcha is **FIXED** — born `proposed` WITH objective+purpose set (execute.test.ts:173–177), panel-promotable; born `ready` when no PM.

### 2.2 Promotion `proposed→ready` — exactly two authority paths (D-039)
- **act-authority:** `runValidationPanel` (pm-panel.ts:404) all-approve + `authority==='act'` → `setStatus(…,'ready')` (:604–605).
- **propose-authority:** panel raises a `decision_brief`; operator `applyBriefDecision` approve → `setStatus(…,'ready')` (:831). **Effect-first / ceremony-last ordering is load-bearing** (crash convergence). reject→`withdrawn`; defer→stays `proposed` with fingerprint suppression.
- Both paths flow through `setStatus` — there is no third write path, and none may be added.

### 2.3 Hand-off to execution (decoupled)
Promotion only flips the task to `ready`. The orchestrator observes the db_change and enqueues (ORCHESTRATOR-SPEC §1.3); `continueReadyTasks` (project-controls.ts:123) is the operator path. `pm-panel`/`pm-proposals` never touch the workqueue directly.

### 2.4 Terminality
`done`/`failed`/`withdrawn` are terminal in ALLOWED_TRANSITIONS. Rework = a NEW follow-up task, never a resurrection — with ONE exception: the operator-authority `reopenFailedTaskToReady` (`failed→ready`, login-gated, manual-only — RRH-4/BL-R4; the auto/reaper path must stay `failed` or it re-drains forever).

## 3. Operator gates (all deterministic-token, all staged, stop at first red)

- **Repo creation** (`repo-creation-gate.ts` `runRepoCreationGate`:153): consent (re-asserts `repo_create_preauthorized`:168) → token (`repoCreateConfirmToken`:92) → auth → private (re-asserted:206) → create → remote → url (writes `project.repo_url`:326). **F-050 FIXED at :308: branch defaults to `'main'`**; public repos unrepresentable in the input AND re-refused at the gate. Private-first, never unilateral (D-037 class).
- **Release readiness** (`release-gate.ts`:126): consent → target → token (D-026 presence-only) → build (execFile) → pack → validate → publish (existing D-037 driver); all-green-only; injected into the autonomous loop (pm-autonomous.ts:238); auto-disarms at v1 (:72).
- **Autonomous arm — the F-055 gate is deliberately asymmetric.** UI arm routes through `armAutonomousLoop` (loops/arm-gate.ts:49: no-PM refusal → readiness evaluation → override declaration → `setPmAutonomous(true)`); the command-center imports it (:129). **Programmatic arming (autonomous-to-v1) calls `setPmAutonomous` directly and is UNGATED by design** (arm-gate.ts:10–12). Rule going forward: any NEW arm caller routes through `armAutonomousLoop` or carries its own recorded consent check — never a bare `setPmAutonomous` "because the context is trusted" (that is exactly the F-055 class).

## 4. Command-center (the ONE operator surface — `src/routes/projects/[id]/`)

- `+page.server.ts` `load` → `ProjectDetailData`, all live (F-008 honest-degrade: 404 on bad id; `connected:false` + empties on DB-down). Aggregates: plan hierarchy · tasks as `TaskSummary[]` (with `moves` = nextStatuses) · fleet sessions · PM block (memory/stats/decisions/reviews/soul/graduations) · proposal queue · autonomous state + spend caps + QueueStats · findings · memories+graph · concierge advisories · role events.
- Actions cover: task create/setStatus, PM charter/schedule/authority, the three preauth setters, panel run, brief decisions, repo-creation gate, loop checklist/arm.
- **SSE, no polling (D-005):** `+page.svelte`:636–656 — `stream.onDbChange('<table>') → invalidate('app:<dep>')` for 15 tables.

## 5. Events / analytics

Only two scene-event emitters in the subsystem, both wrap-and-swallow (never change the primary outcome): `pm_tick` (pm-autonomous.ts:340) and `continue` (project-controls.ts:160). PM review writes `pm_review` + typed `pm_memory`. routing_event/agent_event are orchestrator/harness-side, not emitted here.

## 6. Normative invariants

1. Task CRUD lives in `tasks/repo.ts`; `projects/` never writes task status except through `setStatus`.
2. `proposeTask` is the ONLY minter of `proposed`; nothing transitions into it.
3. `setStatus` is the ONLY status write path — one guarded txn, illegal moves throw-rollback (no phantom db_change).
4. `proposed→ready` has exactly the two D-039 paths (§2.2); effect-first/ceremony-last holds on the brief path.
5. Two normalizer families with different absent-handling (§1.3); new optional datetimes take the isoOrUndef pattern.
6. Every gated state change routes through its existing gate (repo-create/release/UI-arm); confirm tokens are deterministic derivations, never stored secrets.
7. `main` is the default branch everywhere (F-050; scaffolder births it, gate normalizes to it).
8. Scene-event appends are best-effort-swallowed; they never fail the primary write.
9. Live sources + honest degrade on every surface (F-008); no fabricated values.
10. All projects tests are real-surreal (19/19 suites use `startTestDb`; zero stubDb) — keep it that way for any new query (F-020).

## 7. Gaps → the hardening wave (`projects-hardening`, gate:operator)

| id | gap (verified) | required behavior | shape |
|---|---|---|---|
| **PJH-1** | **`applyBriefDecision` handles only `artifact_kind:'task'`** — review_proposal / fixture_proposal / cert_hire / repo_create briefs throw an honest "gap" error. Non-task briefs are an unbuilt seam even though `briefs.ts` mints them. | Implement approve/reject/defer handling per artifact_kind, each routing through that kind's EXISTING gate/action (cert_hire → workforce hire path; repo_create → `runRepoCreationGate` proposal path; review/fixture → their proposal repos). Effect-first/ceremony-last preserved per kind. Unknown kind stays an honest throw. | build (red-team — this touches operator-authority promotion; real-surreal tests per kind) |
| **PJH-2** | Arm-path asymmetry (§3) is intentional but unasserted — nothing stops a future caller from bare-arming. | Add a test-level assertion: grep/static test that the only production callers of `setPmAutonomous(…, true)` are `armAutonomousLoop` + the autonomous-to-v1 loop path; new callers fail the test until justified. | build (small; test-only) |
| **PJH-3** | Three datetime-coercion idioms (`isoOrUndef` / `str()` / local `isoOrNull`) — the `str()` family is one optional-datetime away from an F-013. | Consolidate on `isoOrUndef` export; `normTask` keeps `str()` for the DEFAULT-backed pair but the rule lands as a comment at :184; command-center `isoOrNull` imports the shared helper. Byte-identical output for existing fields. | build (mechanical, haiku-tier) |
| **PJH-4** | `create_status:'incomplete'` projects are half-wired by design (resume affordance) — but nothing in this spec's surfaces asserts they render honestly. | Documented: any aggregator listing projects must tolerate a mid-scaffold row (missing repo_url/plan) — render honest empty states, never throw. Covered today by F-008 discipline; add one render-smoke with an incomplete row to lock it. | build (small test) |

## 8. DoD (D-038) for the hardening wave

- [ ] PJH-1 per-kind handlers each have a real-surreal test (approve + reject + defer + unknown-kind throw); red-team pass (operator-authority surface).
- [ ] PJH-2 caller-assertion test red on a synthetic bare-arm caller.
- [ ] PJH-3 byte-identical normalizer output proven (snapshot on existing fixtures); EOL churn checked (F-054).
- [ ] No new migration; `npm run db:up` clean live; gates green token-unset (F-029); devlog row.
