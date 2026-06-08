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
import { listAllFindings } from '$lib/server/scanner';
import type { PageServerLoad } from './$types';

/** A serializable finding DTO for the Maintain rollup (no SDK RecordId/Date objects). */
export interface FindingCard {
	id: string;
	project?: string;
	rule: string;
	severity: 'low' | 'medium' | 'high' | 'critical';
	file?: string;
	line?: number;
	detail?: string;
}

export interface ReportsData {
	connected: boolean;
	days: DailyRollup[];
	anomalies: Anomaly[];
	totals: ReportSummary['totals'];
	usage: TierUsage[];
	findings: FindingCard[];
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<ReportsData> => {
	// Live re-invalidation key: the SSE agent_event watcher calls invalidate('app:analytics').
	depends('app:analytics');

	// Live re-invalidation: a security_finding row change re-runs this loader too.
	depends('app:findings');

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			days: [],
			anomalies: [],
			totals: { spawns: 0, completions: 0, errors: 0, escalations: 0, tokensIn: 0, tokensOut: 0, costUsd: null },
			usage: [],
			findings: []
		};
	}
	try {
		const summary = await buildReportSummary(db, { windowDays: 14 });
		const usage = await buildTierUsage(db, { windowDays: 30 });
		// Maintain rollup (UI-SPEC §207/§315): live security_finding rows across all projects.
		const findingRows = await listAllFindings(db);
		const findings: FindingCard[] = findingRows.map((f) => ({
			id: f.id,
			...(f.project ? { project: f.project } : {}),
			rule: f.rule,
			severity: f.severity,
			...(f.file ? { file: f.file } : {}),
			...(typeof f.line === 'number' ? { line: f.line } : {}),
			...(f.detail ? { detail: f.detail } : {})
		}));
		return {
			connected: true,
			days: summary.days,
			anomalies: summary.anomalies,
			totals: summary.totals,
			usage,
			findings
		};
	} catch (err) {
		return {
			connected: false,
			days: [],
			anomalies: [],
			totals: { spawns: 0, completions: 0, errors: 0, escalations: 0, tokensIn: 0, tokensOut: 0, costUsd: null },
			usage: [],
			findings: [],
			error: (err as Error).message
		};
	}
};
