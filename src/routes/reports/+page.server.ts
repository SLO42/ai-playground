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

import { fail } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	buildReportSummary,
	buildTierUsage,
	buildRoutingRationale,
	buildProviderUsage,
	buildJudgedComparison,
	runJudgeBatch,
	resolveJudgeModel,
	makeClaudeJudge,
	boundJudgeLimit,
	EMPTY_SPEND_PROVENANCE
} from '$lib/server/analytics';
import type {
	DailyRollup,
	Anomaly,
	ReportSummary,
	TierUsage,
	RoutingRationale,
	ProviderUsage,
	ProviderVerdicts
} from '$lib/server/analytics';
import { loadAgentPool, loadModels } from '$lib/server/config';
import { listAllFindings } from '$lib/server/scanner';
import { buildTrayData, type NotificationItem } from '$lib/server/notifications/repo';
import { listIncidents } from '$lib/server/services/incidents';
import { listProjects } from '$lib/server/projects/repo';
import type { PageServerLoad, Actions } from './$types';

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
	/** MODEL-BENCHMARK-SPEC step 1 — the objective local-vs-cloud comparison (GROUP BY provider). */
	providerComparison: ProviderUsage[];
	/**
	 * MODEL-BENCHMARK-SPEC step 3 — the JUDGED local-vs-cloud comparison (LLM-judge verdicts
	 * grouped by session-under-test provider). Portfolio-wide (not project-scoped). Honest
	 * empty [] when no session has been judged yet (F-008).
	 */
	judgedComparison: ProviderVerdicts[];
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
	// The spend-provenance disclosure legs are part of the totals SHAPE, so the disconnected/error
	// branch returns an honest zeroed leg ("nothing estimated, nothing metered") rather than an
	// absent field the UI would have to guess about.
	return {
		spawns: 0,
		completions: 0,
		errors: 0,
		escalations: 0,
		tokensIn: 0,
		tokensOut: 0,
		costUsd: null,
		...EMPTY_SPEND_PROVENANCE
	};
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
	depends('app:benchmark'); // benchmark_verdict rows (re-runs after a judge action — step 3)

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
			providerComparison: [],
			judgedComparison: [],
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

		// MODEL-BENCHMARK-SPEC step 1 — the objective local-vs-cloud comparison (GROUP BY provider),
		// over the SAME window + project filter. Honest empty ([]) when no rows land yet (F-008).
		const providerComparison = await buildProviderUsage(db, {
			windowDays: days,
			...(project ? { projectId: project } : {})
		});

		// MODEL-BENCHMARK-SPEC step 3 — the JUDGED local-vs-cloud comparison (LLM-judge verdicts
		// grouped by session-under-test provider). Portfolio-wide over the same window; honest
		// empty ([]) until the operator runs the judge action (F-008).
		const judgedComparison = await buildJudgedComparison(db, { windowDays: days });

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
			providerComparison,
			judgedComparison,
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
			providerComparison: [],
			judgedComparison: [],
			routing: emptyRouting(),
			findings: [],
			notifications: [],
			incidents: [],
			error: (err as Error).message
		};
	}
};

/** Read the Claude direct-chat endpoint from models config; canonical Anthropic base as fallback. */
function readClaudeEndpoint(dir: string): string {
	for (const file of [`${dir}/models.json5`, `${dir}/models.yaml`]) {
		try {
			const models = loadModels(file) as {
				providers?: Record<string, { endpoint?: string }>;
			};
			const ep = models.providers?.claude?.endpoint;
			if (typeof ep === 'string' && ep.trim()) return ep.trim();
		} catch {
			// try the next candidate path
		}
	}
	return 'https://api.anthropic.com';
}

/**
 * MODEL-BENCHMARK-SPEC step 3 — the ON-DEMAND, cost-BOUNDED judge trigger (a form action, NOT
 * the heartbeat). Resolves a CLOUD judge model from the live pool (never the local model under
 * test), judges at most `limit` recent sessions, and stores structured verdicts. Every failure
 * is an honest, evidence-bearing reason (F-008) — never a silent no-op or a fabricated result.
 */
export const actions: Actions = {
	judge: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { judgeError: 'database unavailable — cannot run the judge.' });

		const form = await request.formData();
		const rawLimit = Number(form.get('limit'));
		const limit = boundJudgeLimit(Number.isFinite(rawLimit) ? rawLimit : undefined);
		const rawDays = Number(form.get('days'));
		const windowDays = DAY_OPTIONS.includes(rawDays) ? rawDays : 30;
		const rawProvider = String(form.get('provider') ?? '').trim();
		const provider = rawProvider && /^[A-Za-z0-9_-]{1,40}$/.test(rawProvider) ? rawProvider : undefined;

		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		let pool;
		try {
			pool = loadAgentPool(`${dir}/agent-pool.yaml`);
		} catch (e) {
			return fail(500, { judgeError: `config error: ${(e as Error).message}` });
		}

		// The judge is a CLOUD model (never the local model under test); refuse if none configured.
		const choice = resolveJudgeModel(pool);
		if (!choice) {
			return fail(400, {
				judgeError:
					'no cloud tier in agent-pool.yaml — the judge will not run on the local model under test.'
			});
		}
		const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
		if (!apiKey) {
			return fail(400, {
				judgeError:
					'no ANTHROPIC_API_KEY configured — the judge is a cloud LLM call (no key ⇒ no judging).'
			});
		}

		const model = makeClaudeJudge({
			endpoint: readClaudeEndpoint(dir),
			model: choice.modelId,
			apiKey
		});
		try {
			const result = await runJudgeBatch(db, {
				model,
				judge: { provider: choice.provider, modelId: choice.modelId },
				limit,
				windowDays,
				...(provider ? { provider } : {})
			});
			return {
				judgeResult: {
					...result,
					judgeModel: choice.modelId,
					judgeProvider: choice.provider,
					judgeTier: choice.tier
				}
			};
		} catch (e) {
			return fail(502, { judgeError: `judge run failed: ${(e as Error).message}` });
		}
	}
};
