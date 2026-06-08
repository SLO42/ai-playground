// TASK 7.1 — shell tickers, LIVE (UI-SPEC §3 always-on awareness strip; F-008; D-019).
//
// The always-visible Statusbar/Topbar previously rendered HARDCODED placeholders
// (services unknown · agents — · tok — · $— · mode manual) on EVERY screen — the app
// misrepresented its own state. This loader feeds them REAL values:
//   • running agents + today's tokens/cost — analytics rollup (buildShellMetrics), real rows.
//   • service health                       — derived from the real `service` rows.
//   • orchestration mode                   — read from the operator's orchestration.yaml.
//
// Honest degradation (D-019 / F-008): when the DB singleton is not connected, every
// figure is reported as unknown (null / 'unknown'), NEVER zero-dressed-as-real. The page
// re-invalidates this load on the SSE stream so the tickers track live row changes.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import { buildShellMetrics } from '$lib/server/analytics/rollup';
import { loadOrchestration, type OrchMode } from '$lib/server/config';
import type { ServiceStatus } from '$lib/server/services/manager';
import type { LayoutServerLoad } from './$types';

/** A single `service` row projection (only the fields the health rollup needs). */
interface ServiceRow {
	status: ServiceStatus;
}

/**
 * Roll the per-service statuses up into one shell-level health token (F-008): all the
 * managed services healthy ⇒ 'up'; any crashed/down ⇒ 'down'; a mix (some stopped/unknown
 * alongside running) ⇒ 'degraded'; NO real service rows yet ⇒ 'unknown' (honest, never a
 * fabricated "up"). Pure so it stays testable.
 */
function rollupServiceHealth(rows: ServiceRow[]): 'up' | 'degraded' | 'down' | 'unknown' {
	if (rows.length === 0) return 'unknown';
	const statuses = rows.map((r) => r.status);
	if (statuses.some((s) => s === 'crashed')) return 'down';
	if (statuses.every((s) => s === 'running')) return 'up';
	// Some running, some stopped/unknown — partial availability.
	if (statuses.some((s) => s === 'running')) return 'degraded';
	return 'down';
}

/** Read the orchestration mode from config, degrading to 'manual' if config is unreadable. */
function readMode(): OrchMode {
	try {
		// CONFIG_DIR overridable for tests/tooling; default to the repo-root config dir.
		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		return loadOrchestration(`${dir}/orchestration.yaml`).mode;
	} catch {
		return 'manual';
	}
}

export const load: LayoutServerLoad = async ({ depends }) => {
	// Re-invalidated by the layout on session / agent_event / service row changes (live).
	depends('app:shell');

	const mode = readMode();

	const db = tryGetDb();
	if (!db) {
		// Honest disconnected shell (D-019): no fabricated counters.
		return {
			shell: {
				connected: false,
				services: 'unknown' as const,
				runningAgents: null as number | null,
				tokensToday: null as number | null,
				costToday: null as number | null,
				mode
			}
		};
	}

	try {
		const metrics = await buildShellMetrics(db);
		const [svc] = await db.query<[ServiceRow[]]>(`SELECT status FROM service;`);
		return {
			shell: {
				connected: true,
				services: rollupServiceHealth(svc ?? []),
				runningAgents: metrics.runningAgents,
				tokensToday: metrics.tokensToday,
				costToday: metrics.costToday,
				mode
			}
		};
	} catch (err) {
		// A dead cached handle or a live-query failure both mean "counters unknown" — run
		// through the shared classifier for consistency, then degrade honestly (D-019).
		void classifyDbError(err);
		return {
			shell: {
				connected: false,
				services: 'unknown' as const,
				runningAgents: null as number | null,
				tokensToday: null as number | null,
				costToday: null as number | null,
				mode
			}
		};
	}
};
