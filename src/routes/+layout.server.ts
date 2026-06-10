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
import { listProjects } from '$lib/server/projects/repo';
import { buildTrayData, type TrayData } from '$lib/server/notifications/repo';
import { loadOrchestration, type OrchMode } from '$lib/server/config';
import { readServices } from '$lib/server/services/runtime';
import type { ServiceStatus } from '$lib/server/services/manager';
import type { LayoutServerLoad } from './$types';

/** Minimal project projection the CommandPalette needs for "Open project" commands. */
export interface PaletteProject {
	id: string;
	name: string;
}

/**
 * Roll the per-service statuses up into one shell-level health token (F-008): all the
 * KNOWN services healthy ⇒ 'up'; any crashed/down ⇒ 'down'; a mix (some stopped
 * alongside running) ⇒ 'degraded'; NO known service state yet ⇒ 'unknown' (honest,
 * never a fabricated "up"). 14.4a: the statuses come from the SAME probe-reconciled
 * read /services uses (readServices) — never the raw self-reported rows, so a stale
 * 'running' claim for a dead process can no longer light the strip green. Services
 * with no row AND no probe stay honest 'unknown' and are excluded from the verdict.
 */
function rollupServiceHealth(rows: Array<{ status: ServiceStatus }>): 'up' | 'degraded' | 'down' | 'unknown' {
	const statuses = rows.map((r) => r.status).filter((s) => s !== 'unknown');
	if (statuses.length === 0) return 'unknown';
	if (statuses.some((s) => s === 'crashed')) return 'down';
	if (statuses.every((s) => s === 'running')) return 'up';
	// Some running, some stopped — partial availability.
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

	// Honest empty tray when disconnected (F-008) — no fabricated notices.
	const emptyTray: TrayData = { items: [], unread: 0 };

	const db = tryGetDb();
	if (!db) {
		// Honest disconnected shell (D-019): no fabricated counters, no fake projects.
		return {
			shell: {
				connected: false,
				services: 'unknown' as const,
				runningAgents: null as number | null,
				tokensToday: null as number | null,
				costToday: null as number | null,
				mode
			},
			paletteProjects: [] as PaletteProject[],
			tray: emptyTray
		};
	}

	try {
		const metrics = await buildShellMetrics(db);
		// 14.4a — probe-reconciled service states (the same path /services renders), NOT the
		// raw self-reported rows: a dead service can no longer keep the strip green.
		const { services: svcViews } = await readServices(db);
		// Live project list for the CommandPalette "Open project" commands (real rows only).
		const paletteProjects: PaletteProject[] = (await listProjects(db)).map((p) => ({
			id: String(p.id),
			name: p.name
		}));
		// RightTray feed + unread badge (TASK 10.2) — real notification/agent_event rows.
		const tray = await buildTrayData(db);
		return {
			shell: {
				connected: true,
				services: rollupServiceHealth(svcViews),
				runningAgents: metrics.runningAgents,
				tokensToday: metrics.tokensToday,
				costToday: metrics.costToday,
				mode
			},
			paletteProjects,
			tray
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
			},
			paletteProjects: [] as PaletteProject[],
			tray: emptyTray
		};
	}
};
