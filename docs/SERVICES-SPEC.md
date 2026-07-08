# SERVICES-SPEC — process supervision (ollama · surrealdb · dashboard) with honest, asymmetric control

**Status:** DRAFT (2026-07-08) · implements D-004/D-025 + F-001/F-002/F-008 · queued in `periphery-hardening` (gate:operator)
**One-liner:** the supervision engine (pid+health liveness, bounded auto-restart, incident/notification on every crash, honest per-service controllability) is built and tested — but **`tick()` has no production scheduler**: auto-restart runs only in tests; production gets page-load observed-status correction + manual operator actions. The spec's one real decision: wire the tick or lock the manual contract.

Grounding: opus scout pass 2026-07-08 over `src/lib/server/services/` (file:line verified).

## 1. Substrate
- **proc.ts** — the Windows-safe primitives: `isPidAlive` (tasklist F-001), `killPid` (taskkill /F /T), `safePid` range-check before argv, execFile array args (D-008); spawn failure ⇒ "not alive" (fail-safe toward re-spawn).
- **manager.ts** — `ServicesManager` (:142): `tick`→`reconcile` (:234/:243) — liveness = pid-alive AND `adapter.health()`; unhealthy ⇒ `crashed` + incident + notification + bounded auto-restart (`maxRestarts` default 3, give-up = critical incident, counter resets on healthy); `stop` flips desired state so the next tick won't resurrect (:182); observed-status corrector (:311, F-008 — a live probe beats a stale self-report). Rows `service:<name>` UPSERT, $param-bound.
- **Adapters:** `ollama-adapter.ts` (bounded `/api/version` probe at 127.0.0.1:11434 no-/v1; adopts an externally-started ollama via OS pid discovery; spawn shell:true-for-PATH F-002), `surreal-adapter.ts` (wraps db/provision SurrealServer).
- **Controllability is HONEST and asymmetric** (runtime.ts header): ollama fully controllable; **surrealdb observe-only** (the dashboard reads THROUGH it — a stop severs the control plane; db:up owns its lifecycle); dashboard status-only self-report. No dead/dangerous buttons (D-038 #5/#6).
- **Surfaces:** `+layout.server.ts:90` `readServices` (statusbar), home rollup, `/services` page read + `operateService` manual action (name+action boundary-validated). `incidents.ts` records every crash/restart/give-up (analytics-first).
- **Tests:** manager (143, drives tick incl. crash+restart), ollama-adapter (123), runtime (257). proc/incidents/surreal-adapter indirect only.

## 2. Normative invariants
1. NEVER `process.kill(pid,0)` on Windows — all liveness/kill via proc.ts; pid range-checked before any command line.
2. Liveness = pid-alive AND health probe; either failing = down; restart bounded with a give-up critical incident — never thrash.
3. Controllability stays honest and asymmetric (§1): surrealdb is never operator-stoppable from the dashboard; never ship a control without real authority.
4. Every crash/restart/give-up writes an incident + notification — no silent failure; the observed-status corrector always wins over a stale self-report (F-008).
5. All probes loopback-bounded (D-025); an externally-started service is adopted, not duplicated.

## 3. Gaps → items (in `periphery-hardening`)
| id | gap (verified) | required behavior | shape |
|---|---|---|---|
| **SVC-1** | **`tick()` unscheduled** — `.tick()` called only from manager.test.ts; no boot/cron/loop caller. Auto-restart never runs autonomously; a crashed ollama stays down until a page load notices or the operator acts. | DECISION then build. Recommend: a bounded unref'd periodic tick (the orchestrator `startMaintenance` ~5min backstop pattern — precedented, D-004-compatible as an opt-in maintenance timer), config `services.tickMs` (0=off default preserves today's contract). At-boot one-shot tick after the singleton builds. Alternative: lock the manual-only contract and say so on /services. | decision → build (small) |
| **SVC-2** | `engine` is in SERVICE_NAMES but no engine adapter is registered (scout: not found) — reserved name renders from stale rows if any exist. | Verify /services renders `engine` honestly (unknown, no controls); either register a real adapter later or drop the name from SERVICE_NAMES. Small honesty fix. | build (small) |
| **SVC-3** | proc.ts / incidents.ts / surreal-adapter.ts lack dedicated tests. | Add unit suites (safePid bounds, incident row shapes, adapter wrap). | build (small) |
| **SVC-4** | No boot orphan sweep — lazy singleton + OS pid adoption only. | Adoption is the deliberate mechanism (an orphan is adopted, not leaked); documented. A dedicated sweep only if adoption proves insufficient. | documented |
