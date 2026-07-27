// SvelteKit server hooks — process startup wiring (TASK 1.5; ARCHITECTURE §2.11, D-019).
//
// Runs ONCE when the Node server module is first imported. It:
//   1. Opens the least-priv runtime DB connection from env (D-026c), degrading
//      gracefully if SurrealDB is unreachable (D-019) — the dashboard still boots
//      and renders honest "disconnected" states; it NEVER crashes the boot.
//   2. If connected, opens the canonical live queries (project/task/session) via
//      the events module's watchTable — the SOLE sanctioned live-query owner
//      (§2.11) — so the one SSE fan-out actually carries row changes. NOTHING else
//      opens a live query; this is the single place they start.
//
// No `handle` hook is needed yet (no auth — single-operator, local-first). The
// side-effecting init below runs at module-eval time, awaited via a shared promise
// so the SSE route + loaders can observe the startup result without racing it.

import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { initDbFromEnv, tryGetDb, type DbInitResult } from '$lib/server/db/runtime-init';
import { readCredential } from '$lib/server/auth/credential';
import {
	AUTH_COOKIE,
	acceptsHtml,
	decideGate,
	isExemptPath,
	normalizeAddr,
	verifySessionToken
} from '$lib/server/auth/gate';
import { closeDb } from '$lib/server/db/client';
import { getEventBus, watchTable, WATCHED_TABLES, type DbSourceHandle } from '$lib/server/events';
import {
	bootstrapControlPlane,
	decideClientLoopback,
	hostnameFromHostHeader,
	isServerLoopbackBound,
	serverBindHost,
	type ListenerSpec
} from '$lib/server/config/loopback';
import {
	startOrchestrator,
	reapStaleRuns,
	setActiveOrchestrator,
	type Orchestrator
} from '$lib/server/orchestrator';
import { killAllClaudeChildren } from '$lib/server/claude-code/cli-backend';
import { reconcileProjectGuardrails } from '$lib/server/claude-code/guardrail-reconcile';
import { registerShutdown } from '$lib/server/shutdown';
import { loadWorkforce, loadOrchestration, type OrchMode } from '$lib/server/config/index';
import {
	PmTriggerEngine,
	setActivePmTriggerEngine
} from '$lib/server/projects/pm-triggers';
import {
	startAutonomousLoop,
	setActiveAutonomousLoop,
	type AutonomousPmLoop
} from '$lib/server/projects/pm-autonomous';
import { getRuntime, DEFAULT_MODEL, DEFAULT_BUDGETS, DEFAULT_AGENT } from '$lib/server/harness';
import { runSentinelSweep } from '$lib/server/workforce/index';
import { SceneProjector } from '$lib/server/scene/index';
import {
	MaintenanceLoopEngine,
	seedMaintenanceLoops,
	setActiveMaintenanceEngine
} from '$lib/server/loops/maintenance';
import { defaultMaintenanceRegistry } from '$lib/server/loops/maintenance-actions';
import { ServicesTicker, DEFAULT_SERVICES_TICK_MS } from '$lib/server/services';
import { recordIncident, recordNotification } from '$lib/server/services';
import {
	computeAutonomyStatus,
	persistAutonomyStatus,
	subsystemOk,
	subsystemOff,
	subsystemDegraded,
	type AutonomyAssessment,
	type SubsystemStatus
} from '$lib/server/autonomy';

// Runtime env source (TASK 6.8). SvelteKit's `$env/dynamic/private` loads `.env` in
// BOTH dev SSR (which Vite does NOT inject into `process.env`) and the prod Node
// adapter, falling through to `process.env`. Reading the boot config from here — not
// bare `process.env` — is what makes a plain `npm run dev` (no shell-exported env)
// boot CONNECTED instead of degrading on a missing SURREAL_WS. The test harness is
// unaffected: tests call the pure resolvers with explicit env objects, and
// runtime-init.ts keeps its `process.env` default for non-SSR callers.

// ── D-025 control-plane: loopback gate + per-boot token (TASK 6.1) ───────────────
//
// The whole control plane (this SvelteKit server + the loopback SurrealDB/Ollama
// endpoints) must bind loopback ONLY, asserted at boot — fail closed otherwise.
// We then mint a fresh per-boot token and surface it INTO this process's env as
// HOOK_TOKEN, so the hook ingest endpoint (api/hooks/[event]) can authorize the
// hook→agent_event pipeline against it (D-025), and HOOK_URL so a spawned
// hook-proxy (which inherits this env) knows where to POST. Minting at boot — never
// committing it to .env — is the D-025 contract. If the operator pre-set HOOK_TOKEN
// (e.g. to share one token across a manual proxy), we keep theirs.

/** The listeners the D-025 startup gate asserts are loopback. Hosts come from env
 *  (SvelteKit HOST + the loopback service urls), defaulting to 127.0.0.1. */
function bootListeners(): ListenerSpec[] {
	// serverBindHost is the SINGLE source of the 127.0.0.1 default — shared with the
	// runtime serverIsLoopbackBound() so the boot gate and the login-gate loopback
	// determination can never drift (SF2-3(b)).
	const svelteHost = serverBindHost(env.HOST);
	const sveltePort = Number((env.PORT || '5173').trim()) || 5173;
	const hostOf = (url: string | undefined, fallback: string): string => {
		if (!url) return fallback;
		try {
			return new URL(url.trim()).hostname;
		} catch {
			return fallback;
		}
	};
	return [
		{ name: 'sveltekit', host: svelteHost, port: sveltePort },
		{ name: 'surrealdb', host: hostOf(env.SURREAL_WS, '127.0.0.1'), port: 8000 },
		{ name: 'ollama', host: hostOf(env.OLLAMA_HOST, '127.0.0.1'), port: 11434 }
	];
}

/** Run the D-025 gate + mint/surface the per-boot control-plane token. Throws
 *  (fail-closed) if any listener is routable — the process must not boot. */
function bootstrapControlPlaneEnv(): void {
	const cp = bootstrapControlPlane(bootListeners());
	// Surface the token to THIS process's `process.env` so the hook ingest endpoint
	// authorizes against it AND a spawned hook-proxy (which inherits process env) sees
	// it (D-025). Reads consult `env` ($env/dynamic/private) so an operator value set
	// in `.env` — not just a shell export — is respected.
	if (!env.HOOK_TOKEN?.trim()) process.env.HOOK_TOKEN = cp.token;
	if (!env.HOOK_URL?.trim()) {
		const host = env.HOST?.trim() || '127.0.0.1';
		const port = env.PORT?.trim() || '5173';
		process.env.HOOK_URL = `http://${host}:${port}`;
	}
	// Surface the DRIVEN-session Claude Code credential (D-002/S1) from $env/dynamic/private
	// into process.env, so the harness wiring (getRuntime, plain server code reading
	// process.env) sees a `.env`-set token under `npm run dev` — where Vite does NOT inject
	// .env into process.env. Without this the live spawn path degrades to honest-unavailable
	// (F-008) on every dev boot even when the operator HAS configured the credential. We
	// never overwrite an existing shell-exported value, and the token is never logged.
	const ccToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	if (ccToken && !process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = ccToken;
	}
	console.log('[startup] control-plane: loopback gate passed; per-boot HOOK_TOKEN minted (D-025).');
}

// WATCHED_TABLES (13.1) lives in $lib/server/events/watched-tables.ts — the single
// audited list of every table any route subscribes to via onDbChange, each entry
// commented with the routes that need it. A static-scan test (watched-tables.test.ts)
// asserts the list is a superset of every onDbChange table in the routes source, so a
// future route subscribing to an unwatched table fails the suite instead of silently
// never live-updating (the 13.1 finding: workflow_run was unwatched → the release
// page's documented live step_state updates could never fire).

const watchers: DbSourceHandle[] = [];

/**
 * TASK 8.1 — the live orchestrator(s), started once at boot (event-driven, D-004/§2.11). Held in
 * a module-scope registry (mirrors `watchers`) so the instance is NOT garbage-collected for the
 * life of the server process — its bus subscription is what drives task→ready → spawn. Empty when
 * the DB is down or the Claude Code credential is absent (honest degraded boot — F-008): the
 * dashboard still serves. This array is the TEARDOWN list only; server-side introspection goes
 * through `activeOrchestrator` in `$lib/server/orchestrator` (see the note below).
 */

// NOTE — there is deliberately NO `activeOrchestrator` accessor exported from this module.
// It used to live here, and because this module also carries the top-level, EAGER
// `export const startup = bootstrap()` below, any consumer that merely wanted the accessor
// dragged the entire server boot in with it at import time: initDbFromEnv against the DEV
// database, the live table watchers, the boot reaper and the m0086 boot-ledger write. Under
// SvelteKit that is invisible (the boot happens regardless); under `vitest` it meant a test
// that imported a route module booted the real server, claimed the process-wide Db singleton,
// and then died at FILE level on its own `initDb(testDb)` with "Db singleton already
// initialised" — three suites, deterministically, in isolation.
// The canonical READ-ONLY registry is `setActiveOrchestrator`/`activeOrchestrator` in
// `$lib/server/orchestrator` (populated by boot.ts startOrchestrator, cleared in
// stopOrchestrators below). It is side-effect-free by construction — importing it starts
// nothing — which is exactly why it was created (see its header: "without importing
// hooks.server.ts (circularity)"). Consumers import it from there, never from here.

/**
 * TASK 16.2 — the PM trigger engine(s) (PM-SPEC §3), held like `orchestrators` so the
 * instance survives for the life of the process and shutdown can stop it. The engine
 * needs only the DB + bus (its review pass is deterministic — no Claude credential),
 * so it starts on every CONNECTED boot; in manual orchestration mode it subscribes to
 * nothing (D-004: no automatic fires) and the registry handle stays for route lookups.
 */
const pmTriggerEngines: PmTriggerEngine[] = [];

/** The live autonomous loops (PMA), held like the others so teardown can stop their bus subscriptions. */
const autonomousLoops: AutonomousPmLoop[] = [];

/** The live self-maintenance loop engine(s) (m0080), held like the others so teardown stops the tick. */
const maintenanceEngines: MaintenanceLoopEngine[] = [];

/** SVC-1 — the services supervision ticker(s), held like the others so shutdown tears down the
 *  unref'd tick timer (F-014). Empty when the DB is down or `services.tickMs` is 0 (OFF). */
const servicesTickers: ServicesTicker[] = [];

/**
 * MEMORY-SCENE-SPEC §5/§7.1 — the scene_event PROJECTOR, held like the others so the
 * instance (its bus subscription) survives for the life of the process and shutdown
 * can tear it down. It is bus-only (§2.11 — never its own live query) and best-effort
 * (a projection write never crashes the host flow), so it starts on every CONNECTED
 * boot regardless of the orchestration mode: it merely MIRRORS real row changes into a
 * derived, append-only, rolling activity feed — it triggers no automatic work (D-004).
 */
const sceneProjectors: SceneProjector[] = [];

/** The startup promise — loaders/routes can await it to know the DB state. */
export const startup: Promise<DbInitResult> = bootstrap();

async function bootstrap(): Promise<DbInitResult> {
	// D-025 FIRST: assert loopback + mint/surface the per-boot control-plane token
	// before anything opens a connection. Fail-closed on a routable bind (throws).
	bootstrapControlPlaneEnv();

	// TASK 13.5 finding 6 — process shutdown teardown. Until 13.5 NOTHING in src handled
	// SIGTERM/SIGINT: a stopped server leaked 14+ live-query watchers, the orchestrator,
	// the DB socket, and any live claude.exe children (the F-014 orphan-storm shape).
	// Registered ONCE (global-flag guarded — survives dev HMR re-eval), BEFORE the early
	// disconnected return so even a degraded boot tears down what it did open. The deps
	// read the module-scope registries LIVE at signal time, not at registration time.
	registerShutdown({
		stopOrchestrators: () => {
			for (const o of orchestrators) o.stop();
			// Clear the live-orchestrator registry so a READ-ONLY consumer (loops read model) never
			// reads a stale handle after shutdown (F-014).
			setActiveOrchestrator(null);
			// The PM trigger engine is orchestration machinery too (TASK 16.2): same
			// teardown step — its bus subscription + tick timer must not outlive the boot.
			for (const e of pmTriggerEngines) e.stop();
			// The autonomous loop is a bus consumer too (PMA): its subscription must not
			// outlive the boot (F-014). Clear the registry so a stale handle isn't read.
			for (const l of autonomousLoops) l.stop();
			setActiveAutonomousLoop(null);
			// The maintenance loop engine's tick timer must not outlive the boot (F-014); clear the
			// registry so the loops read model never reads a stale handle after shutdown.
			for (const m of maintenanceEngines) m.stop();
			setActiveMaintenanceEngine(null);
			// The scene projector is a bus consumer too (MEMORY-SCENE-SPEC §5): its
			// subscription must not outlive the boot (F-014).
			// SVC-1 — the services supervision ticker's unref'd tick timer must not outlive the
			// boot (F-014); stop() tears it down.
			for (const t of servicesTickers) t.stop();
			for (const s of sceneProjectors) s.stop();
		},
		killChildren: () => killAllClaudeChildren(),
		stopWatchers: () => Promise.all(watchers.map((w) => w.stop().catch(() => {}))),
		closeDb: () => closeDb(),
		exit: (code) => process.exit(code),
		log: (m) => console.log(m)
	});

	// Read the connection params from `$env/dynamic/private` (loaded from `.env` in dev
	// SSR + prod) — NOT bare `process.env`, which Vite dev SSR leaves empty (TASK 6.8).
	const result = await initDbFromEnv(env);
	if (!result.connected) {
		// Honest degraded boot (D-019): log once, keep serving disconnected states.
		console.warn(`[startup] DB not connected — ${result.reason ?? 'unknown'}. Serving disconnected.`);
		return result;
	}

	const db = tryGetDb();
	if (db) {
		const bus = getEventBus();
		for (const table of WATCHED_TABLES) {
			try {
				watchers.push(await watchTable(db, bus, table));
			} catch (err) {
				console.warn(`[startup] live query on "${table}" failed: ${(err as Error).message}`);
			}
		}

		// TASK 13.2 — the boot-time reaper: a hard server death writes no terminal status, so
		// session/workflow_run rows from a PREVIOUS boot can be wedged 'running' forever
		// (phantom running agents on every dashboard). Sweep them to 'failed' with the honest
		// note "reaped: server restarted mid-run" (F-008) BEFORE the orchestrator starts. Runs
		// on every connected boot — credentialed or not (the wedge predates this process).
		try {
			const reaped = await reapStaleRuns(db);
			if (reaped.sessions || reaped.workflowRuns || reaped.releasedWorkItems || reaped.resetTasks) {
				console.warn(
					`[startup] reaped ${reaped.sessions} session(s) + ${reaped.workflowRuns} workflow_run(s) left 'running' by a previous boot ` +
						`(recovered ${reaped.releasedWorkItems} work_item(s) + ${reaped.resetTasks} task(s) → ready, BL-R1).`
				);
			}
		} catch (err) {
			// A reaper failure must never crash the boot (D-019) — it retries next boot.
			console.warn(`[startup] boot reaper failed: ${(err as Error).message}`);
		}

		// CCH-2 (CLAUDE-CODE-HARNESS-SPEC section 5) — RECONCILE the D-024 PRIMARY guardrail boundary
		// for every REGISTERED project BEFORE the orchestrator can drive a spawn. writeProjectGuardrails
		// seeds <root>/.claude/settings.json permissions.deny — the boundary Claude Code enforces
		// LOCALLY (server-down); the runtime network PreToolUse/canUseTool gate is defense-in-depth ON
		// TOP of it. New projects get it at registration (scanProject); this boot pass covers a project
		// registered BEFORE that seam existed (and refreshes a stale ruleset). Idempotent + merge-
		// preserving (a hand-edited settings.json is never clobbered). Best-effort (F-014): a per-project
		// fault is a named warning; a whole-pass failure degrades honestly (the network gate still
		// applies) and NEVER crashes boot. CODE_ROOT resolves the same way the scan/create routes do.
		try {
			const guardrailCodeRoot = process.env.CODE_ROOT?.trim() || 'F:/code';
			// selfRoot = the platform's own worktree (process.cwd()) — EXEMPTED so the reconcile never
			// seeds a self-clamping .claude/settings.json into the control-plane repo (D-040/CCH-2).
			const rec = await reconcileProjectGuardrails(db, {
				codeRoot: guardrailCodeRoot,
				selfRoot: process.cwd()
			});
			if (rec.seeded || rec.skipped || rec.exempted) {
				console.log(
					`[startup] guardrail reconcile: seeded ${rec.seeded} project(s), skipped ${rec.skipped}, exempted ${rec.exempted} (self-host) — D-024 primary permissions.deny boundary (CCH-2/1.4a).`
				);
			}
			for (const w of rec.warnings) console.warn(w);
		} catch (err) {
			console.warn(
				`[startup] guardrail reconcile failed (runtime network gate still applies): ${(err as Error).message}`
			);
		}

		// MEMORY-SCENE-SPEC §5 — start the scene PROJECTOR AFTER the watchTable live queries
		// are open, so the bus already carries the source-table row changes it mirrors. It is
		// a pure bus consumer (§2.11 — no own live query) and best-effort (a projection write
		// never crashes the host flow), so it starts on every connected boot. A start failure
		// must never crash the boot (D-019) — the scene feed simply stays empty (F-008 honest).
		// Outcome captured here and appended to the boot ledger below — the projector starts BEFORE
		// the ledger is declared (it must run as early as the bus allows), so it cannot push directly.
		// `null` would mean this block never ran at all.
		let sceneProjectorStarted: { ok: boolean; reason?: string } | null = null;
		try {
			const projector = new SceneProjector({ db, bus });
			projector.start();
			sceneProjectors.push(projector);
			sceneProjectorStarted = { ok: true };
			console.log('[startup] scene projector started — scene_event derived from live row changes (MEMORY-SCENE-SPEC §5).');
		} catch (err) {
			console.warn(`[startup] scene projector boot failed: ${(err as Error).message}`);
			sceneProjectorStarted = { ok: false, reason: `boot threw: ${(err as Error).message}` };
		}

		// SD-2 (PRE-WAKE SAFETY) — persist the HONEST autonomy boot-status BEFORE the engines start,
			// so /services can render a persistent, plain-language surface instead of the console.warn no
			// one reads. computeAutonomyStatus reads the SAME config files the engines below read
			// (orchestration.yaml drives the mode → all engines; workforce.yaml drives PM triggers) and
			// NEVER throws — a parse fault becomes an honest 'config-error' (the silent-disarm hole made
			// VISIBLE, F-008). On a config-error we ALSO write a first-class incident + notification (the
			// analytics/audit trail + the live right-tray surface, which re-invalidates /services): the
			// degrade path is logged with HOW+WHY (which file, the raw message), not swallowed. A persist
			// fault must never crash boot (D-019/F-014) — worst case the surface stays 'unknown' honestly.
		// COMPLETION-LEDGER Wave A — the per-engine BOOT-SKIP ledger, collected across the engine
		// starts below and folded into the SAME autonomy_status row at the end of boot (m0086 /
		// F-055: ONE boot-status mechanism, EXTENDED, never a second one). A boot that dies before
		// the final seal simply leaves the PRE-engine row (state honest, ledger 'not reported')
		// — never a half-ledger implying engines started that did not.
		let bootAssessment: AutonomyAssessment | null = null;
		const bootLedger: SubsystemStatus[] = [];
			try {
				const status = computeAutonomyStatus(process.env.CONFIG_DIR?.trim() || 'config');
				bootAssessment = status;
				await persistAutonomyStatus(db, status);
				if (status.state === 'config-error') {
					console.warn(
						`[startup] AUTONOMY OFF — config unreadable (${status.configFile ?? 'orchestration.yaml'}): ${status.detail ?? 'parse error'}. Engines forced to manual; surfaced on /services (SD-2).`
					);
					// First-class analytics + operator-visible surface for the DEGRADE (not just a persisted
					// row): a durable incident (how+why) + an unread notification (the live right-tray).
					// Best-effort — a logging fault must not undo the (already-persisted) honest status.
					await recordIncident(db, {
						title: 'Autonomy OFF — orchestration config unreadable',
						detail: `${status.configFile ?? 'orchestration.yaml'}: ${status.detail ?? 'parse error'}. All engines are forced to manual until the config is fixed and the server restarts.`,
						severity: 'error'
					}).catch((e) => console.warn(`[startup] autonomy-status incident write failed: ${(e as Error).message}`));
					await recordNotification(
						db,
						`Autonomy is OFF: ${status.configFile ?? 'orchestration.yaml'} could not be read — engines are in manual until it is fixed and the server restarts.`
					).catch((e) => console.warn(`[startup] autonomy-status notification write failed: ${(e as Error).message}`));
				} else {
					console.log(
						`[startup] autonomy boot-status persisted (state=${status.state}, mode=${status.mode ?? '—'}${status.workforceOk ? '' : ', workforce degraded'}) — surfaced on /services (SD-2).`
					);
				}
			} catch (err) {
				console.warn(`[startup] autonomy boot-status persist failed (surface stays 'unknown'): ${(err as Error).message}`);
			}

			// TASK 8.1 — start the live orchestrator AFTER the watchTable live queries are open, so
			// the events bus already carries `task` row changes when the orchestrator subscribes. It
		// reacts to a task entering a spawn-ready status (task→ready) by enqueuing one work_item
		// and draining → spawning a real Claude Code session, with NO manual launch. It is
		// event-driven + idle-cheap (D-004/§2.11): subscriptions only, no poller, ~zero idle CPU,
		// and it consumes the SAME bus (never its own live query — the no-double-fire guard). It
		// skips honestly (started:false) when the Claude Code credential is absent (F-008) so the
		// dashboard still boots; the queue then waits for a credentialed boot.
		try {
			const boot = await startOrchestrator(db, bus);
			if (boot.started) {
				orchestrators.push(boot.orchestrator);
				console.log(
					`[startup] orchestrator started (mode=${boot.mode}, maxConcurrent=${boot.maxConcurrent}) — task→ready auto-drives a session (D-004).`
				);
				bootLedger.push(subsystemOk('orchestrator', 'Task orchestrator'));
				// The memory recall/extract loop rides ON the orchestrator, so it can be OFF while the
				// orchestrator is up — previously a terminal-only warning (every spawn ran without recall
				// and no surface said so). Record it as its OWN degraded entry.
				bootLedger.push(
					boot.memoryOffReason
						? subsystemDegraded(
								'memory-loop',
								'Memory recall + extraction',
								`${boot.memoryOffReason} — sessions run WITHOUT memory recall and nothing is extracted at session end until this is fixed and the server restarts.`
							)
						: subsystemOk('memory-loop', 'Memory recall + extraction')
				);
			} else {
				console.warn(`[startup] orchestrator NOT started — ${boot.reason}`);
				bootLedger.push(
					subsystemOff(
						'orchestrator',
						'Task orchestrator',
						`${boot.reason} — no task will auto-drive a session this boot; the queue waits.`
					)
				);
				bootLedger.push(
					subsystemOff(
						'memory-loop',
						'Memory recall + extraction',
						'The orchestrator did not start, so the memory loop it hosts never armed.'
					)
				);
			}
		} catch (err) {
			// A boot failure must never crash the server boot (D-019 honest degrade).
			console.warn(`[startup] orchestrator boot failed: ${(err as Error).message}`);
			bootLedger.push(
				subsystemOff(
					'orchestrator',
					'Task orchestrator',
					`boot threw: ${(err as Error).message} — no task will auto-drive a session this boot.`
				)
			);
		}

		// PMA — the CONTINUOUS AUTONOMOUS LOOP, AFTER the orchestrator so a re-tick's promoted task→ready
		// is drained by the live orchestrator. Bus-only (the SAME bus); it re-runs the one-click lifecycle
		// tick when an armed PM's promoted batch drains, looping toward the DoD and HALTING honestly at
		// blocked / cap-reached / awaiting-release-confirm. It NEVER bypasses an operator gate (no publish,
		// no hire) and bounds spend (PMA-2 cap). Needs the Claude credential (it drives real PM sessions)
		// — absent ⇒ skip cleanly (F-008). Manual mode ⇒ OFF (operator one-click only, D-004).
		try {
			let mode: OrchMode = 'manual';
			try {
				mode = loadOrchestration(`${process.env.CONFIG_DIR?.trim() || 'config'}/orchestration.yaml`).mode;
			} catch {
				mode = 'manual';
			}
			const loopBoot = await startAutonomousLoop(db, bus, {
				getRuntime,
				mode,
				fallbackModel: DEFAULT_MODEL,
				budgets: DEFAULT_BUDGETS,
				proposalModel: DEFAULT_MODEL,
				proposalAgentId: DEFAULT_AGENT,
				// The release-readiness gate reads the publish credential from $env/dynamic/private (D-026 —
				// presence only). Wiring it here is what lets a CONSENTED + green-gate drive auto-publish.
				env
			});
			if (loopBoot.started) {
				autonomousLoops.push(loopBoot.loop);
				bootLedger.push(subsystemOk('autonomous-loop', 'Autonomous PM loop'));
				console.log('[startup] autonomous PM loop started — an ARMED PM re-ticks toward the DoD; at DoD it auto-publishes ONLY with recorded consent + a GREEN release-readiness gate, else HALTS at the publish gate (PMA, D-037 consented override / D-039 untouched).');
			} else {
				console.warn(`[startup] autonomous PM loop NOT started — ${loopBoot.reason}`);
				bootLedger.push(
					subsystemOff(
						'autonomous-loop',
						'Autonomous PM loop',
						`${loopBoot.reason} — an armed PM will NOT re-tick toward its DoD on its own this boot.`
					)
				);
			}
		} catch (err) {
			console.warn(`[startup] autonomous PM loop boot failed: ${(err as Error).message}`);
			bootLedger.push(
				subsystemOff(
					'autonomous-loop',
					'Autonomous PM loop',
					`boot threw: ${(err as Error).message} — an armed PM will NOT re-tick on its own this boot.`
				)
			);
		}

		// TASK 16.2 — the PM trigger engine (PM-SPEC §3), AFTER the watchers so the bus
		// already carries session/task/security_finding/workflow_run row changes. It is
		// bus-only (§2.11 — never its own live query) and needs no Claude credential (the
		// review pass is deterministic), so it starts on every connected boot. D-004: the
		// orchestration mode gates it — manual mode subscribes to nothing / arms no timer.
		// The failure threshold ships UNARMED (null) and reads from workforce.yaml; an
		// unreadable config degrades honestly to unarmed (F-008), never an invented bound.
		try {
			const dir = process.env.CONFIG_DIR?.trim() || 'config';
			let mode: OrchMode = 'manual';
			try {
				mode = loadOrchestration(`${dir}/orchestration.yaml`).mode;
			} catch {
				mode = 'manual'; // most conservative gate on a bad config (11.5 pattern)
			}
			let failureThreshold: number | null = null;
			let distressCooldownMs: number | null = null;
			let driftConfig: import('$lib/server/config/index').WorkforceConfig | null = null;
			try {
				const wf = loadWorkforce(`${dir}/workforce.yaml`);
				failureThreshold = wf.pm.triggers.failure_threshold;
				// SD-3 — the anti-spam cooldown (minutes → ms). null stays null (no time cooldown).
				const cd = wf.pm.triggers.distress_cooldown_minutes;
				distressCooldownMs = cd !== null ? cd * 60_000 : null;
				// WORKFORCE-SPEC §5: pass the full config so the periodic tick can run the
				// bounded drift auto-raise pass (operator decision 4). null on a bad config
				// → drift never auto-raises (the count-and-surface posture).
				driftConfig = wf;
			} catch (err) {
				console.warn(
					`[startup] workforce.yaml unreadable — pm failure trigger + §5 drift stay UNARMED: ${(err as Error).message}`
				);
			}
			const engine = new PmTriggerEngine({ db, bus, mode, failureThreshold, distressCooldownMs, driftConfig });
			engine.start();
			pmTriggerEngines.push(engine);
			setActivePmTriggerEngine(engine);
			bootLedger.push(
				mode === 'manual'
					? subsystemDegraded(
							'pm-triggers',
							'PM trigger engine',
							'Orchestration mode is MANUAL, so the engine subscribes to nothing — a failing session will not raise a PM review by itself (as configured, D-004).'
						)
					: failureThreshold === null
						? subsystemDegraded(
								'pm-triggers',
								'PM trigger engine',
								'Started, but the failure trigger is UNARMED — workforce.yaml yielded no failure_threshold, so repeated failures raise no PM review.'
							)
							: subsystemOk('pm-triggers', 'PM trigger engine')
			);
			console.log(
				`[startup] pm trigger engine started (mode=${mode}, failure_threshold=${failureThreshold ?? 'unarmed'}, distress_cooldown=${distressCooldownMs !== null ? `${Math.round(distressCooldownMs / 60_000)}m` : 'none'}, drift=${driftConfig && mode !== 'manual' ? 'armed' : 'unarmed'}) — PM-SPEC §3 + WORKFORCE-SPEC §5 (D-004).`
			);
		} catch (err) {
			console.warn(`[startup] pm trigger engine boot failed: ${(err as Error).message}`);
			bootLedger.push(
				subsystemOff(
					'pm-triggers',
					'PM trigger engine',
					`boot threw: ${(err as Error).message} — failing sessions and drift will not raise a PM review this boot.`
				)
			);
		}

		// SELF-MAINTENANCE LOOPS (m0080; LOOP-ENGINEERING) — the manifest-driven MaintenanceLoopEngine,
		// AFTER the pm trigger engine (same D-004 mode read; no bus needed — it is cadence-only). Boot
		// SEEDS the two declared global loops CREATE-IF-ABSENT (idempotent; operator edits are never
		// clobbered): they ship with EMPTY checklists, so readiness is NOT green and the engine does not
		// fire them until the operator ticks the checklist (or records an override) on /loops — declared,
		// visible, honestly inert (F-008). Manual mode arms no timer (D-004). Actions are deterministic,
		// credential-free, deadline-bounded, and PROPOSE-ONLY (no default is ever flipped — D-004);
		// any maintenance fault is absorbed + logged, never a server crash (F-048).
		try {
			let mode: OrchMode = 'manual';
			try {
				mode = loadOrchestration(`${process.env.CONFIG_DIR?.trim() || 'config'}/orchestration.yaml`).mode;
			} catch {
				mode = 'manual'; // most conservative gate on a bad config (11.5 pattern)
			}
			const created = await seedMaintenanceLoops(db);
			const engine = new MaintenanceLoopEngine({ db, mode, registry: defaultMaintenanceRegistry() });
			engine.start();
			maintenanceEngines.push(engine);
			setActiveMaintenanceEngine(engine);
			bootLedger.push(
				mode === 'manual'
					? subsystemDegraded(
							'maintenance-loops',
							'Self-maintenance loops',
							'Orchestration mode is MANUAL, so no cadence timer is armed — declared loops stay inert until an operator runs them (as configured, D-004).'
						)
					: subsystemOk('maintenance-loops', 'Self-maintenance loops')
			);
			console.log(
				`[startup] maintenance loop engine started (mode=${mode}${created ? `, declared ${created} loop(s)` : ''}) — manifest-driven, readiness-gated, propose-only (m0080).`
			);
		} catch (err) {
			console.warn(`[startup] maintenance loop engine boot failed: ${(err as Error).message}`);
			bootLedger.push(
				subsystemOff(
					'maintenance-loops',
					'Self-maintenance loops',
					`boot threw: ${(err as Error).message} — no maintenance loop will fire this boot.`
				)
			);
		}

		// SVC-1 (SERVICES-SPEC §3 / D-004 additive note, DECISIONS.md 7ca9145) — arm the
		// PRODUCTION scheduler for the services supervision loop. The ServicesManager owns
		// pid+health liveness + bounded auto-restart, but tick() had NO production caller: a
		// crashed desired-up service (e.g. an operator-armed Ollama) stayed down until a page
		// load happened to observe it. This wires a BOUNDED, unref'd, single-flight periodic
		// tick that reconciles the managed services on `services.tickMs` (default 5min; 0 = OFF).
		// Every tick is fault-isolated (a DB/probe fault logs + never crashes the server, F-014)
		// and the timer is torn down on shutdown (stopOrchestrators, above). It is NOT mode-gated
		// (a crashed-service backstop is not automatic AGENT work — the D-004 off switch here is
		// tickMs=0). Read once per boot (restart to apply, F-029). A start failure must never
		// crash the boot (D-019) — supervision simply stays off.
		try {
			let tickMs = DEFAULT_SERVICES_TICK_MS;
			try {
				const orch = loadOrchestration(`${process.env.CONFIG_DIR?.trim() || 'config'}/orchestration.yaml`);
				tickMs = orch.services?.tickMs ?? DEFAULT_SERVICES_TICK_MS;
			} catch {
				tickMs = DEFAULT_SERVICES_TICK_MS; // unreadable config → the safe 5min backstop.
			}
			const ticker = new ServicesTicker({ db, tickMs });
			ticker.start();
			servicesTickers.push(ticker);
			bootLedger.push(
				ticker.periodicArmed
					? subsystemOk('services-ticker', 'Service supervision')
					: subsystemDegraded(
							'services-ticker',
							'Service supervision',
							'services.tickMs is 0, so the supervision backstop is OFF — a crashed desired-up service stays down until someone loads a page (as configured, D-004).'
						)
			);
			console.log(
				`[startup] services ticker ${ticker.periodicArmed ? `armed (tickMs=${tickMs})` : 'OFF (tickMs=0)'} — bounded unref'd supervision backstop (SVC-1/D-004).`
			);
		} catch (err) {
			console.warn(`[startup] services ticker boot failed: ${(err as Error).message}`);
			bootLedger.push(
				subsystemOff(
					'services-ticker',
					'Service supervision',
					`boot threw: ${(err as Error).message} — a crashed managed service will not be auto-restarted this boot.`
				)
			);
		}

		// TASK 16.6 — the §4.2 gauntlet SENTINEL SWEEP, once per connected boot (the
		// periodic vehicle: every boot leaves a completed work_item audit row; a hit
		// writes a notification — fixture retirement stays an OPERATOR act, never
		// auto-burn). Read-only + bounded; a sweep failure never blocks boot (D-019).
		try {
			const sweep = await runSentinelSweep(db);
			if (sweep.hits.length) {
				console.warn(
					`[startup] gauntlet sentinel sweep: ${sweep.hits.length} LEAK hit(s) across ${sweep.checked} sentinel(s) — notification written (operator decides retirement, §4.2).`
				);
			} else if (sweep.checked) {
				console.log(`[startup] gauntlet sentinel sweep clean (${sweep.checked} sentinel(s)).`);
			}
		} catch (err) {
			console.warn(`[startup] gauntlet sentinel sweep failed: ${(err as Error).message}`);
		}

		// COMPLETION-LEDGER Wave A — SEAL the boot-skip ledger onto the SAME autonomy_status row
		// (m0086). Every engine above recorded its outcome; this ONE write makes "what did not
		// start, and why" durable and visible on /services instead of terminal-only (F-008).
		//
		// It re-writes the singleton with UPSERT ... CONTENT using the SAME assessment the pre-engine
		// write used, so the row is never half-updated and a re-run of boot simply overwrites it
		// (idempotent — no observable half-state).
		//
		// Best-effort (D-019/F-014): a persist fault must never crash boot. Worst case the row keeps
		// its pre-engine content and the surface honestly reads 'not reported'.
		if (bootAssessment && bootLedger.length > 0) {
			try {
				if (sceneProjectorStarted) {
					bootLedger.unshift(
						sceneProjectorStarted.ok
							? subsystemOk('scene-projector', 'Live activity scene')
							: subsystemOff(
									'scene-projector',
									'Live activity scene',
									`${sceneProjectorStarted.reason ?? 'unknown fault'} — the living-brain scene feed stays empty this boot.`
								)
					);
				}
				await persistAutonomyStatus(db, bootAssessment, bootLedger);
				const notStarted = bootLedger.filter((sub) => !sub.started);
				console.log(
					`[startup] boot ledger persisted — ${bootLedger.length} subsystem(s), ${notStarted.length} did NOT start${notStarted.length ? ` (${notStarted.map((sub) => sub.key).join(', ')})` : ''}. Visible on /services (m0086).`
				);
			} catch (err) {
				console.warn(
					`[startup] boot ledger persist failed (autonomy state stays honest; the per-subsystem ledger reads 'not reported'): ${(err as Error).message}`
				);
			}
		}
	}
	return result;
}

// ── Login gate (non-loopback only) ───────────────────────────────────────────────
//
// The FIRST (and only) `handle` hook. Loopback requests pass UNTOUCHED — local use
// is login-free (D-025). A NON-loopback (LAN/remote) request must present a valid
// signed session cookie once a credential is set; before first-run it is steered to
// /setup. This is casual gating over plain HTTP (see auth/credential.ts for the
// honest scope caveat); it never touches the boot side-effects above.
//
// LOOPBACK DETECTION — WHY getClientAddress() first, Host header fallback FAIL-CLOSED (SEC-1):
// `event.getClientAddress()` reflects the real TCP peer (the adapter/Vite reads the
// socket's remote address), so it cannot be spoofed by a header the way a `Host`/
// `Origin` value can. We PREFER it. If it is empty/unavailable we may fall back to the
// `Host` header — which IS spoofable (a LAN client can send `Host: 127.0.0.1`). To stop
// that spoof from granting login-free control-plane access when an adapter change ever
// leaves getClientAddress() unpopulated, the fallback is gated on THIS server's own bind
// (`serverIsLoopbackBound`): on a LAN-bound server it DENIES (fail-closed → the login
// gate applies); on a loopback-bound server it keeps the lenient Host fallback (a LAN
// attacker cannot reach a loopback bind at all). The policy lives in the pure, unit-tested
// `decideClientLoopback` (config/loopback.ts). (Verified live under `vite dev --host`:
// loopback → 127.0.0.1 / ::1, LAN → the LAN IP.)
function clientIsLoopback(event: Parameters<Handle>[0]['event']): boolean {
	let clientAddr: string | null = null;
	try {
		const addr = event.getClientAddress();
		if (addr) clientAddr = normalizeAddr(addr);
	} catch {
		// getClientAddress throws if the adapter can't determine it — fall through to the
		// fail-closed Host fallback in decideClientLoopback.
	}
	// Bracketed-IPv6 aware Host parse: `[::1]:5173` → `::1` (a naive split(':')[0] yields
	// `[` and mis-classifies the loopback literal as non-loopback) — SF2-3(c).
	const hostHeader = hostnameFromHostHeader(event.request.headers.get('host'));
	// adapter-node's getClientAddress() returns a spoofable HEADER value (not the socket
	// peer) when ADDRESS_HEADER is configured — which ALSO means a reverse proxy fronts the
	// app, making even a loopback bind remotely reachable. Flag it so decideClientLoopback
	// fails closed on ANY bind (forged address AND Host-fallback) rather than trusting a
	// spoofed loopback value (SF2-3(a)).
	const clientAddrSpoofable = !!env.ADDRESS_HEADER?.trim();
	return decideClientLoopback({
		clientAddr,
		hostHeader,
		serverLoopbackBound: serverIsLoopbackBound(),
		clientAddrSpoofable
	});
}

/**
 * True iff THIS server binds a loopback address, from the HOST bind env (default
 * 127.0.0.1 — the SAME determination the D-025 boot gate uses via {@link serverBindHost},
 * so the two can never drift, SF2-3(b)). A LAN bind (HOST set to a routable address) is
 * exactly where the spoofable Host-header / header-derived-address loopback fallbacks
 * must fail closed (SEC-1 / SF2-3).
 */
function serverIsLoopbackBound(): boolean {
	return isServerLoopbackBound(env.HOST);
}

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const isLoopback = clientIsLoopback(event);

	// Default request auth state (loopback is implicitly authed). The auth pages read
	// `locals.auth.isLoopback`; they re-derive credential/cookie state from the DB.
	event.locals.auth = { isLoopback, hasCredential: false, authed: isLoopback };

	// Auth surface + control-plane callbacks + static assets bypass the gate entirely.
	if (isExemptPath(path)) return resolve(event);
	// Loopback is login-free — no DB read needed on the hot local path.
	if (isLoopback) return resolve(event);

	// External, non-exempt: consult the credential store (honest-degrade if DB down).
	const db = tryGetDb();
	let cred: Awaited<ReturnType<typeof readCredential>> | null = null;
	if (db) {
		try {
			cred = await readCredential(db);
		} catch {
			cred = null; // DB error → treat as no credential → fail closed below.
		}
	}
	const hasCredential = !!cred;
	const validCookie = cred ? verifySessionToken(event.cookies.get(AUTH_COOKIE), cred.signSecret) : false;
	event.locals.auth = { isLoopback, hasCredential, authed: validCookie };

	const isBrowserGet =
		event.request.method === 'GET' && acceptsHtml(event.request.headers.get('accept'));
	const decision = decideGate({ hasCredential, validCookie, isBrowserGet, path });
	if (decision.action === 'pass') return resolve(event);
	if (decision.action === 'redirect') {
		return new Response(null, { status: 303, headers: { location: decision.to } });
	}
	return new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } });
};
