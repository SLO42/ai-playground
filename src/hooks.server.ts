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

import { initDbFromEnv, tryGetDb, type DbInitResult } from '$lib/server/db/runtime-init';
import { getEventBus, watchTable, type DbSourceHandle } from '$lib/server/events';

/** Tables whose row changes feed the dashboard's live regions (v0.1 set). */
const WATCHED_TABLES = ['project', 'task', 'session'] as const;

const watchers: DbSourceHandle[] = [];

/** The startup promise — loaders/routes can await it to know the DB state. */
export const startup: Promise<DbInitResult> = bootstrap();

async function bootstrap(): Promise<DbInitResult> {
	const result = await initDbFromEnv();
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
	}
	return result;
}
