// TASK 2.4 / TASK 11.1 — /reports analytics dashboard, LIVE rollups + the operator's
// core requirement: see HOW + WHY every routing decision was made (UI-SPEC §6/§206/§207/§208;
// F-008; D-016; D-019; F-013).
//
// Serves, all from REAL rows (F-008 — no fabricated metric):
//   • daily agent-activity rollups + anomaly flags + per-tier usage (TASK 2.4)
//   • the RoutingRationale view — per-decision rationale + the aggregate panel (TASK 11.1a)
//   • a server-driven filter set (project / time range / model) that narrows everything
//     honestly with real counts (TASK 11.1b)
//   • the Maintain rollup — security + dependency-health + UX findings, categorized by rule
//     family across all projects (TASK 11.1c, UI-SPEC §207)
//   • the incidents + notifications HISTORY view — the RightTray "see all" target, with
//     read/unread + kind filter (TASK 11.1d, UI-SPEC §208)
//
// Filters are SERVER-driven: read from the URL query (?project=&days=&model=) and threaded
// into every builder so the counts the operator sees are the counts that match. Degrades
// honestly (D-019): DB down → connected:false + empty, never zero-dressed-as-real.

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	buildReportSummary,
	buildTierUsage,
	buildRoutingRationale
} from '$lib/server/analytics';
import type {
	DailyRollup,
	Anomaly,
	ReportSummary,
	TierUsage,
	RoutingRationale
} from '$lib/server/analytics';
import { listAllFindings } from '$lib/server/scanner';
import { buildTrayData, type NotificationItem } from '$lib/server/notifications/repo';
import { listIncidents } from '$lib/server/services/incidents';
import { listProjects } from '$lib/server/projects/repo';
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
	/** Which Maintain family the rule belongs to (UI-SPEC §207). */
	family: 'security' | 'dependency' | 'ux';
}

/** One incident in the durable history view (UI-SPEC §208). */
export interface IncidentCard {
	id: string;
	title: string;
	detail?: string;
	severity: 'info' | 'warn' | 'error' | 'critical';
	at: string;
}

/** Project option for the filter dropdown (id + display name). */
export interface ProjectOption {
	id: string;
	name: string;
}

/** The active, validated filter set echoed back so the UI can reflect the server's view. */
export interface ReportFilters {
	/** Selected project id (`project:…`) or null for portfolio-wide. */
	project: string | null;
	/** Trailing window in days. */
	days: number;
	/** Selected model id or null for all models. */
	model: string | null;
}

export interface ReportsData {
	connected: boolean;
	filters: ReportFilters;
	/** Filter option lists (real, from the DB): projects + the models that appear in routing. */
	projectOptions: ProjectOption[];
	modelOptions: string[];
	dayOptions: number[];
	days: DailyRollup[];
	anomalies: Anomaly[];
	totals: ReportSummary['totals'];
	usage: TierUsage[];
	/** The RoutingRationale view (per-decision rows + aggregate) — TASK 11.1a. */
	routing: RoutingRationale;
	findings: FindingCard[];
	/** Durable notifications history — the "see all" target from the RightTray (TASK 10.2). */
	notifications: NotificationItem[];
	/** Durable incidents history (gate-denial / anomaly incidents — UI-SPEC §208). */
	incidents: IncidentCard[];
	error?: string;
}

/** Legal trailing-window choices for the time-range filter. */
const DAY_OPTIONS = [1, 7, 14, 30, 90];
const DEFAULT_DAYS = 14;

/** Categorize a finding into its Maintain family by rule prefix (UI-SPEC §207). */
function familyForRule(rule: string): FindingCard['family'] {
	if (rule.startsWith('dependency.')) return 'dependency';
	if (rule.startsWith('ux.')) return 'ux';
	return 'security';
}

function emptyTotals(): ReportSummary['totals'] {
	return { spawns: 0, completions: 0, errors: 0, escalations: 0, tokensIn: 0, tokensOut: 0, costUsd: null };
}

function emptyRouting(): RoutingRationale {
	return {
		decisions: [],
		aggregate: { total: 0, byTier: [], byModel: [], byMethod: [], overrideRate: null, overrides: 0 }
	};
}

export const load: PageServerLoad = async ({ depends, url }): Promise<ReportsData> => {
	// Live re-invalidation keys (one SSE stream re-runs the matching loader — UI-SPEC §1.2):
	depends('app:analytics'); // agent_event / routing_event rows
	depends('app:findings'); // security_finding rows (incl. dependency.* / ux.*)
	depends('app:shell'); // notification rows (shared with the RightTray — TASK 10.2)
	depends('app:incidents'); // incident rows (durable history — TASK 11.1d)

	// ── Server-driven filters (TASK 11.1b): read + validate from the URL query. ──────
	const rawDays = Number(url.searchParams.get('days'));
	const days = DAY_OPTIONS.includes(rawDays) ? rawDays : DEFAULT_DAYS;
	const rawProject = url.searchParams.get('project');
	// A project filter must be a `project:…` record id to be a legal link; anything else ⇒ none.
	const project = rawProject && /^project:[A-Za-z0-9_]+$/.test(rawProject) ? rawProject : null;
	const rawModel = url.searchParams.get('model');
	const model = rawModel && rawModel.length > 0 && rawModel.length < 200 ? rawModel : null;
	const filters: ReportFilters = { project, days, model };

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			filters,
			projectOptions: [],
			modelOptions: [],
			dayOptions: DAY_OPTIONS,
			days: [],
			anomalies: [],
			totals: emptyTotals(),
			usage: [],
			routing: emptyRouting(),
			findings: [],
			notifications: [],
			incidents: []
		};
	}
	try {
		// Activity rollups + per-tier usage (project + window filters applied — TASK 2.4/11.1b).
		const summary = await buildReportSummary(db, {
			windowDays: days,
			...(project ? { projectId: project } : {})
		});
		const usage = await buildTierUsage(db, { windowDays: Math.max(days, 30) });

		// RoutingRationale view (TASK 11.1a): per-decision rows + aggregate, all filters applied.
		const routing = await buildRoutingRationale(db, {
			windowDays: days,
			...(project ? { projectId: project } : {}),
			...(model ? { model } : {})
		});

		// Maintain rollup (UI-SPEC §207): live findings across all projects, categorized by
		// family (security / dependency-health / UX). Honors the project filter when set.
		const findingRows = await listAllFindings(db);
		const findings: FindingCard[] = findingRows
			.filter((f) => (project ? f.project === project : true))
			.map((f) => ({
				id: f.id,
				...(f.project ? { project: f.project } : {}),
				rule: f.rule,
				severity: f.severity,
				...(f.file ? { file: f.file } : {}),
				...(typeof f.line === 'number' ? { line: f.line } : {}),
				...(f.detail ? { detail: f.detail } : {}),
				family: familyForRule(f.rule)
			}));

		// Durable history (UI-SPEC §208): notifications (RightTray "see all") + incidents.
		const tray = await buildTrayData(db, 50);
		const notifications = tray.items.filter(
			(i): i is NotificationItem => i.kind === 'notification'
		);
		const incidentRows = await listIncidents(db, 50);
		const incidents: IncidentCard[] = incidentRows.map((i) => ({
			id: i.id,
			title: i.title,
			...(i.detail ? { detail: i.detail } : {}),
			severity: i.severity,
			at: i.at
		}));

		// Filter option lists from real data: all projects + the models that appear in routing
		// (computed over an unfiltered routing read so the dropdown isn't narrowed by itself).
		const projectRows = await listProjects(db);
		const projectOptions: ProjectOption[] = projectRows.map((p) => ({ id: p.id, name: p.name }));
		const allRouting = model
			? await buildRoutingRationale(db, { windowDays: days, ...(project ? { projectId: project } : {}) })
			: routing;
		const modelOptions = [...new Set(allRouting.decisions.map((d) => d.model))].sort();

		return {
			connected: true,
			filters,
			projectOptions,
			modelOptions,
			dayOptions: DAY_OPTIONS,
			days: summary.days,
			anomalies: summary.anomalies,
			totals: summary.totals,
			usage,
			routing,
			findings,
			notifications,
			incidents
		};
	} catch (err) {
		return {
			connected: false,
			filters,
			projectOptions: [],
			modelOptions: [],
			dayOptions: DAY_OPTIONS,
			days: [],
			anomalies: [],
			totals: emptyTotals(),
			usage: [],
			routing: emptyRouting(),
			findings: [],
			notifications: [],
			incidents: [],
			error: (err as Error).message
		};
	}
};
