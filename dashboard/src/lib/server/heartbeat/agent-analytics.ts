/**
 * Agent lifecycle analytics — tracks every decision point from classification
 * through model selection, spawn, escalation, handoff, and completion.
 *
 * Events are stored in .playground/agent-analytics.json and served via API
 * for the Models page visualization.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { PATHS } from '../constants.js';

// ── Event types ──────────────────────────────────────────────────────

export type AgentEventType =
	| 'classified'          // task routed to openclaw, openclaw-context, or claude-code
	| 'escalation_check'    // shouldEscalate result
	| 'model_selected'      // pickModelForTask picked sonnet/opus
	| 'spawned'             // agent process started
	| 'handoff'             // escalated from one provider to another
	| 'context_gathering'   // OpenClaw starting context/project scoping
	| 'context_gathered'    // OpenClaw context ready for Claude Code
	| 'learning_extracted'  // OpenClaw extracted learnings after task completion
	| 'completed'           // agent finished successfully
	| 'failed'              // agent failed or exited non-zero
	| 'committed'           // agent changes committed to git
	| 'follow_up_spawned'   // documenter or memory agent spawned
	| 'follow_up_done'      // follow-up agent completed
	| 'test_run';           // post-commit test suite executed

export interface AgentEvent {
	id: string;
	taskId: string;
	taskTitle: string;
	type: AgentEventType;
	timestamp: string;

	// Project
	projectId?: string;

	// Classification
	route?: 'openclaw' | 'openclaw-context' | 'claude-code';
	escalated?: boolean;
	escalationReason?: string;

	// Model selection
	model?: string;
	modelTier?: 'sonnet' | 'opus' | 'local';
	provider?: 'openclaw' | 'claude-code';

	// Spawn
	pid?: number;
	maxTurns?: number;
	sessionId?: string;

	// Handoff
	fromProvider?: string;
	toProvider?: string;
	handoffReason?: string;

	// Completion
	exitCode?: number;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	filesChanged?: number;
	insertions?: number;
	deletions?: number;

	// Commit
	commitHash?: string;
	commitFiles?: number;
	commitError?: string;

	// Follow-up
	followUpType?: 'documenter' | 'memory';
	followUpReason?: string;
	parentTaskId?: string;

	// Context gathering (OpenClaw)
	contextLength?: number;
	learningData?: string;
}

// ── Aggregated analytics ─────────────────────────────────────────────

export interface AgentAnalytics {
	events: AgentEvent[];
	summary: {
		totalTasks: number;
		completedTasks: number;
		failedTasks: number;
		totalCostUsd: number;
		totalDurationMs: number;
		avgCostPerTask: number;
		avgDurationMs: number;
	};
	byModel: Record<string, {
		model: string;
		tier: string;
		count: number;
		completedCount: number;
		failedCount: number;
		totalCost: number;
		totalDuration: number;
		avgCost: number;
		avgDuration: number;
		totalInput: number;
		totalOutput: number;
	}>;
	byRoute: {
		openclaw: { count: number; escalated: number; completedLocally: number; contextGathered: number; totalCost: number };
		claudeCode: { count: number; sonnet: number; opus: number; totalCost: number };
	};
	escalationRate: number;
	modelDistribution: { model: string; percentage: number; count: number }[];
	timeline: { hour: string; events: number; cost: number; tasks: number }[];
	recentEvents: AgentEvent[];
	byProject: Record<string, {
		projectId: string;
		taskCount: number;
		completedCount: number;
		failedCount: number;
		totalCost: number;
		totalDuration: number;
	}>;
}

// ── Storage ──────────────────────────────────────────────────────────

const ANALYTICS_PATH = resolve(PATHS.root, '.playground/agent-analytics.json');
const MAX_EVENTS = 2000;

// Use globalThis so HMR reloads share the same cache instead of duplicating it
const _g = globalThis as Record<string, unknown>;
let eventCache: AgentEvent[] | null = (_g.__claw_analytics_cache as AgentEvent[] | null) ?? null;

async function loadEvents(): Promise<AgentEvent[]> {
	if (eventCache) return eventCache;
	try {
		const raw = await readFile(ANALYTICS_PATH, 'utf-8');
		eventCache = JSON.parse(raw) as AgentEvent[];
		_g.__claw_analytics_cache = eventCache;
		return eventCache;
	} catch {
		eventCache = [];
		_g.__claw_analytics_cache = eventCache;
		return eventCache;
	}
}

async function saveEvents(events: AgentEvent[]): Promise<void> {
	const trimmed = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
	eventCache = trimmed;
	_g.__claw_analytics_cache = trimmed;
	try {
		await mkdir(dirname(ANALYTICS_PATH), { recursive: true });
		await writeFile(ANALYTICS_PATH, JSON.stringify(trimmed, null, '\t'), 'utf-8');
	} catch { /* best effort */ }
}

// ── Record an event ──────────────────────────────────────────────────

let eventCounter = 0;

export async function recordEvent(event: Omit<AgentEvent, 'id' | 'timestamp'>): Promise<void> {
	const events = await loadEvents();
	const id = `evt-${Date.now()}-${++eventCounter}`;
	events.push({
		id,
		timestamp: new Date().toISOString(),
		...event
	} as AgentEvent);
	await saveEvents(events);
}

// ── Build analytics summary ──────────────────────────────────────────

export async function getAgentAnalytics(): Promise<AgentAnalytics> {
	const events = await loadEvents();

	// Group events by taskId to build per-task lifecycle
	const taskEvents = new Map<string, AgentEvent[]>();
	for (const e of events) {
		const list = taskEvents.get(e.taskId) ?? [];
		list.push(e);
		taskEvents.set(e.taskId, list);
	}

	let totalCost = 0, totalDuration = 0, completed = 0, failed = 0;
	const byModel: Record<string, AgentAnalytics['byModel'][string]> = {};
	let openclawCount = 0, openclawEscalated = 0, openclawLocal = 0, openclawCost = 0;
	let ccCount = 0, ccSonnet = 0, ccOpus = 0, ccCost = 0;

	// Process completion events for stats
	const completionEvents = events.filter(e => e.type === 'completed' || e.type === 'failed');
	for (const e of completionEvents) {
		const cost = e.costUsd ?? 0;
		const dur = e.durationMs ?? 0;
		totalCost += cost;
		totalDuration += dur;

		if (e.type === 'completed') completed++;
		if (e.type === 'failed') failed++;

		const model = e.model ?? 'unknown';
		if (!byModel[model]) {
			byModel[model] = {
				model,
				tier: model.includes('sonnet') ? 'sonnet' : model.includes('opus') ? 'opus' : 'local',
				count: 0, completedCount: 0, failedCount: 0,
				totalCost: 0, totalDuration: 0, avgCost: 0, avgDuration: 0,
				totalInput: 0, totalOutput: 0
			};
		}
		byModel[model].count++;
		if (e.type === 'completed') byModel[model].completedCount++;
		if (e.type === 'failed') byModel[model].failedCount++;
		byModel[model].totalCost += cost;
		byModel[model].totalDuration += dur;
		byModel[model].totalInput += e.inputTokens ?? 0;
		byModel[model].totalOutput += e.outputTokens ?? 0;
	}

	// Compute averages
	for (const m of Object.values(byModel)) {
		if (m.count > 0) {
			m.avgCost = m.totalCost / m.count;
			m.avgDuration = m.totalDuration / m.count;
		}
	}

	// Route stats from classification events
	let contextGatheredCount = 0;
	const classEvents = events.filter(e => e.type === 'classified');
	for (const e of classEvents) {
		if (e.route === 'openclaw' || e.route === 'openclaw-context') openclawCount++;
		else ccCount++;
	}

	// Count context gathering events
	const contextEvents = events.filter(e => e.type === 'context_gathered');
	contextGatheredCount = contextEvents.length;

	const escalationEvents = events.filter(e => e.type === 'escalation_check');
	for (const e of escalationEvents) {
		if (e.escalated) openclawEscalated++;
	}
	openclawLocal = openclawCount - openclawEscalated;

	// Model tier counts from model_selected events
	const modelEvents = events.filter(e => e.type === 'model_selected');
	for (const e of modelEvents) {
		if (e.modelTier === 'sonnet') ccSonnet++;
		else if (e.modelTier === 'opus') ccOpus++;
	}

	// Cost by route from completion events
	for (const e of completionEvents) {
		if (e.provider === 'openclaw') openclawCost += e.costUsd ?? 0;
		else ccCost += e.costUsd ?? 0;
	}

	// Model distribution
	const totalModeled = Object.values(byModel).reduce((s, m) => s + m.count, 0);
	const modelDistribution = Object.values(byModel).map(m => ({
		model: m.model,
		percentage: totalModeled > 0 ? (m.count / totalModeled) * 100 : 0,
		count: m.count
	})).sort((a, b) => b.count - a.count);

	// Hourly timeline (last 24h)
	const now = Date.now();
	const h24ago = now - 24 * 60 * 60 * 1000;
	const hourBuckets = new Map<string, { events: number; cost: number; tasks: Set<string> }>();
	for (const e of events) {
		const ts = new Date(e.timestamp).getTime();
		if (ts < h24ago) continue;
		const hour = new Date(e.timestamp).toISOString().slice(0, 13) + ':00';
		const bucket = hourBuckets.get(hour) ?? { events: 0, cost: 0, tasks: new Set<string>() };
		bucket.events++;
		if (e.costUsd) bucket.cost += e.costUsd;
		bucket.tasks.add(e.taskId);
		hourBuckets.set(hour, bucket);
	}
	const timeline = [...hourBuckets.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([hour, b]) => ({ hour, events: b.events, cost: b.cost, tasks: b.tasks.size }));

	// Per-project stats from completion events
	const byProject: AgentAnalytics['byProject'] = {};
	for (const e of completionEvents) {
		const pid = e.projectId ?? 'unknown';
		if (!byProject[pid]) {
			byProject[pid] = { projectId: pid, taskCount: 0, completedCount: 0, failedCount: 0, totalCost: 0, totalDuration: 0 };
		}
		byProject[pid].taskCount++;
		if (e.type === 'completed') byProject[pid].completedCount++;
		if (e.type === 'failed') byProject[pid].failedCount++;
		byProject[pid].totalCost += e.costUsd ?? 0;
		byProject[pid].totalDuration += e.durationMs ?? 0;
	}

	const totalTasks = completed + failed;
	const escalationRate = openclawCount > 0 ? openclawEscalated / openclawCount : 0;

	return {
		events,
		summary: {
			totalTasks,
			completedTasks: completed,
			failedTasks: failed,
			totalCostUsd: totalCost,
			totalDurationMs: totalDuration,
			avgCostPerTask: totalTasks > 0 ? totalCost / totalTasks : 0,
			avgDurationMs: totalTasks > 0 ? totalDuration / totalTasks : 0,
		},
		byModel,
		byRoute: {
			openclaw: { count: openclawCount, escalated: openclawEscalated, completedLocally: openclawLocal, contextGathered: contextGatheredCount, totalCost: openclawCost },
			claudeCode: { count: ccCount, sonnet: ccSonnet, opus: ccOpus, totalCost: ccCost }
		},
		escalationRate,
		modelDistribution,
		timeline,
		recentEvents: events.slice(-50).reverse(),
		byProject
	};
}
