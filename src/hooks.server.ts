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

import { env } from '$env/dynamic/private';
import { initDbFromEnv, tryGetDb, type DbInitResult } from '$lib/server/db/runtime-init';
import { closeDb } from '$lib/server/db/client';
import { getEventBus, watchTable, WATCHED_TABLES, type DbSourceHandle } from '$lib/server/events';
import { bootstrapControlPlane, type ListenerSpec } from '$lib/server/config/loopback';
import { startOrchestrator, reapStaleRuns, type Orchestrator } from '$lib/server/orchestrator';
import { killAllClaudeChildren } from '$lib/server/claude-code/cli-backend';
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
	const svelteHost = (env.HOST || '127.0.0.1').trim();
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
 * dashboard still serves. Exposed via {@link activeOrchestrator} for server-side introspection.
 */
const orchestrators: Orchestrator[] = [];

/** The live orchestrator, or null when none is running (honest degraded boot). */
export function activeOrchestrator(): Orchestrator | null {
	return orchestrators[0] ?? null;
}

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
			// The PM trigger engine is orchestration machinery too (TASK 16.2): same
			// teardown step — its bus subscription + tick timer must not outlive the boot.
			for (const e of pmTriggerEngines) e.stop();
			// The autonomous loop is a bus consumer too (PMA): its subscription must not
			// outlive the boot (F-014). Clear the registry so a stale handle isn't read.
			for (const l of autonomousLoops) l.stop();
			setActiveAutonomousLoop(null);
			// The scene projector is a bus consumer too (MEMORY-SCENE-SPEC §5): its
			// subscription must not outlive the boot (F-014).
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
			if (reaped.sessions || reaped.workflowRuns) {
				console.warn(
					`[startup] reaped ${reaped.sessions} session(s) + ${reaped.workflowRuns} workflow_run(s) left 'running' by a previous boot.`
				);
			}
		} catch (err) {
			// A reaper failure must never crash the boot (D-019) — it retries next boot.
			console.warn(`[startup] boot reaper failed: ${(err as Error).message}`);
		}

		// MEMORY-SCENE-SPEC §5 — start the scene PROJECTOR AFTER the watchTable live queries
		// are open, so the bus already carries the source-table row changes it mirrors. It is
		// a pure bus consumer (§2.11 — no own live query) and best-effort (a projection write
		// never crashes the host flow), so it starts on every connected boot. A start failure
		// must never crash the boot (D-019) — the scene feed simply stays empty (F-008 honest).
		try {
			const projector = new SceneProjector({ db, bus });
			projector.start();
			sceneProjectors.push(projector);
			console.log('[startup] scene projector started — scene_event derived from live row changes (MEMORY-SCENE-SPEC §5).');
		} catch (err) {
			console.warn(`[startup] scene projector boot failed: ${(err as Error).message}`);
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
			} else {
				console.warn(`[startup] orchestrator NOT started — ${boot.reason}`);
			}
		} catch (err) {
			// A boot failure must never crash the server boot (D-019 honest degrade).
			console.warn(`[startup] orchestrator boot failed: ${(err as Error).message}`);
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
				console.log('[startup] autonomous PM loop started — an ARMED PM re-ticks toward the DoD; at DoD it auto-publishes ONLY with recorded consent + a GREEN release-readiness gate, else HALTS at the publish gate (PMA, D-037 consented override / D-039 untouched).');
			} else {
				console.warn(`[startup] autonomous PM loop NOT started — ${loopBoot.reason}`);
			}
		} catch (err) {
			console.warn(`[startup] autonomous PM loop boot failed: ${(err as Error).message}`);
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
			let driftConfig: import('$lib/server/config/index').WorkforceConfig | null = null;
			try {
				const wf = loadWorkforce(`${dir}/workforce.yaml`);
				failureThreshold = wf.pm.triggers.failure_threshold;
				// WORKFORCE-SPEC §5: pass the full config so the periodic tick can run the
				// bounded drift auto-raise pass (operator decision 4). null on a bad config
				// → drift never auto-raises (the count-and-surface posture).
				driftConfig = wf;
			} catch (err) {
				console.warn(
					`[startup] workforce.yaml unreadable — pm failure trigger + §5 drift stay UNARMED: ${(err as Error).message}`
				);
			}
			const engine = new PmTriggerEngine({ db, bus, mode, failureThreshold, driftConfig });
			engine.start();
			pmTriggerEngines.push(engine);
			setActivePmTriggerEngine(engine);
			console.log(
				`[startup] pm trigger engine started (mode=${mode}, failure_threshold=${failureThreshold ?? 'unarmed'}, drift=${driftConfig && mode !== 'manual' ? 'armed' : 'unarmed'}) — PM-SPEC §3 + WORKFORCE-SPEC §5 (D-004).`
			);
		} catch (err) {
			console.warn(`[startup] pm trigger engine boot failed: ${(err as Error).message}`);
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
	}
	return result;
}
