// TASK 2.4 — /reports analytics dashboard, LIVE rollups + anomaly flags (UI-SPEC §6
// /reports; F-008; D-019).
//
// Serves daily agent-activity rollups + anomaly flags + per-tier usage, all computed
// from REAL `agent_event` rows (F-008 — no fabricated metric; cost only when rows were
// priced). Degrades honestly (D-019): DB not connected → `connected:false` + empty,
// never zero-dressed-as-real. Live: the SSE `agent_event` watcher re-invalidates this
// loader so the rollups + ticker update in place (UI-SPEC §229/§230).

import { tryGetDb } from '$lib/server/db/runtime-init';
import { buildReportSummary, buildTierUsage } from '$lib/server/analytics';
import type { DailyRollup, Anomaly, ReportSummary, TierUsage } from '$lib/server/analytics';
import type { PageServerLoad } from './$types';

export interface ReportsData {
	connected: boolean;
	days: DailyRollup[];
	anomalies: Anomaly[];
	totals: ReportSummary['totals'];
	usage: TierUsage[];
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<ReportsData> => {
	// Live re-invalidation key: the SSE agent_event watcher calls invalidate('app:analytics').
	depends('app:analytics');

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			days: [],
			anomalies: [],
			totals: { spawns: 0, completions: 0, errors: 0, escalations: 0, tokensIn: 0, tokensOut: 0, costUsd: null },
			usage: []
		};
	}
	try {
		const summary = await buildReportSummary(db, { windowDays: 14 });
		const usage = await buildTierUsage(db, { windowDays: 30 });
		return {
			connected: true,
			days: summary.days,
			anomalies: summary.anomalies,
			totals: summary.totals,
			usage
		};
	} catch (err) {
		return {
			connected: false,
			days: [],
			anomalies: [],
			totals: { spawns: 0, completions: 0, errors: 0, escalations: 0, tokensIn: 0, tokensOut: 0, costUsd: null },
			usage: [],
			error: (err as Error).message
		};
	}
};
