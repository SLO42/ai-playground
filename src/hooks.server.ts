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
import { getEventBus, watchTable, type DbSourceHandle } from '$lib/server/events';
import { bootstrapControlPlane, type ListenerSpec } from '$lib/server/config/loopback';
import { startOrchestrator, type Orchestrator } from '$lib/server/orchestrator';

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

/** Tables whose row changes feed the dashboard's live regions.
 *  v0.1: project/task/session. 2.4 adds the analytics tables so /reports + /agents
 *  rollups and the live fleet/cost ticker (UI-SPEC §229/§230) update in place as
 *  agent_event / routing_event rows arrive — over the ONE SSE stream (§2.11).
 *  3.1 adds security_finding so the /reports Maintain rollup updates in place as a
 *  scan writes findings (UI-SPEC §207/§315). 7.1 adds `service` so the always-visible
 *  Statusbar service-health token updates live as a service row flips state (UI-SPEC §3).
 *  9.1 adds `pm_memory`, `decision`, `sprint` so the project-workspace PM tab updates in
 *  place as the PM records memory/decisions or a sprint is created/completed (UI-SPEC §51).
 *  11.1 adds `incident` so the /reports incidents history (the RightTray "see all" target)
 *  updates in place as a gate-denial / anomaly incident is recorded (UI-SPEC §208).
 *  11.3 adds `cc_agent` so the /agents catalog (and /claude-code catalog) live-refreshes
 *  in place when a project's `.claude/agents` is re-synced into the cc_* mirror (UI-SPEC §198/§214). */
const WATCHED_TABLES = ['project', 'task', 'session', 'agent_event', 'routing_event', 'security_finding', 'service', 'pm_memory', 'decision', 'sprint', 'task_sync', 'notification', 'incident', 'cc_agent'] as const;

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

/** The startup promise — loaders/routes can await it to know the DB state. */
export const startup: Promise<DbInitResult> = bootstrap();

async function bootstrap(): Promise<DbInitResult> {
	// D-025 FIRST: assert loopback + mint/surface the per-boot control-plane token
	// before anything opens a connection. Fail-closed on a routable bind (throws).
	bootstrapControlPlaneEnv();

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
	}
	return result;
}
