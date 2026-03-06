import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { PATHS } from './constants.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface RoutingDecision {
	id: string;
	timestamp: string;
	model: string;
	provider: string;
	agent: string;
	taskType: string;
	complexity: number;
	latencyMs: number;
	success: boolean;
	source: string;
	reason?: string;
	sessionId?: string;
}

export interface RoutingStats {
	totalDecisions: number;
	successRate: number;
	avgLatencyMs: number;
	byModel: Record<string, ModelStats>;
	byAgent: Record<string, AgentStats>;
	byTaskType: Record<string, TaskTypeStats>;
	recentDecisions: RoutingDecision[];
	hourlyActivity: HourlyBucket[];
}

export interface ModelStats {
	model: string;
	provider: string;
	count: number;
	successRate: number;
	avgLatencyMs: number;
	avgComplexity: number;
	costEstimate: number;
}

export interface AgentStats {
	agent: string;
	count: number;
	successRate: number;
	avgLatencyMs: number;
	taskTypes: string[];
}

export interface TaskTypeStats {
	taskType: string;
	count: number;
	preferredAgent: string;
	avgComplexity: number;
	successRate: number;
}

export interface HourlyBucket {
	hour: string;
	count: number;
	successRate: number;
}

export interface WorkflowStep {
	agent: string;
	model: string;
	provider: string;
	taskType: string;
	complexity: number;
	latencyMs: number;
	success: boolean;
}

export interface WorkflowChain {
	sessionId: string;
	source: string;
	steps: WorkflowStep[];
	totalLatencyMs: number;
	escalated: boolean;
	startTime: string;
}

export interface SourceStats {
	source: string;
	count: number;
	successRate: number;
	avgLatencyMs: number;
	escalationRate: number;
	topAgents: { agent: string; count: number }[];
	topTaskTypes: { taskType: string; count: number }[];
}

export interface ChainPattern {
	pattern: string[];        // agent names in order
	count: number;
	successRate: number;
	avgLatencyMs: number;
	escalationRate: number;
	sources: { source: string; count: number }[];
}

export interface AgentRoutingProfile {
	agent: string;
	totalRouted: number;
	asFirst: number;          // times this agent started a chain
	asLast: number;           // times this agent ended a chain
	escalatedFrom: number;    // times work was escalated FROM this agent
	escalatedTo: number;      // times work was escalated TO this agent
	avgComplexityHandled: number;
	modelsUsed: { model: string; count: number }[];
	taskTypes: { taskType: string; count: number }[];
	successRate: number;
	avgLatencyMs: number;
}

export interface WorkflowStats {
	bySource: Record<string, SourceStats>;
	recentWorkflows: WorkflowChain[];
	escalationRate: number;
	avgChainLength: number;
	clawInitiated: number;
	userInitiated: number;
	chainPatterns: ChainPattern[];
	agentProfiles: Record<string, AgentRoutingProfile>;
}

// ── Storage ────────────────────────────────────────────────────────────

const MAX_ENTRIES = 500;

async function readLog(): Promise<RoutingDecision[]> {
	try {
		const raw = await readFile(PATHS.routingLog, 'utf-8');
		return JSON.parse(raw) as RoutingDecision[];
	} catch {
		return [];
	}
}

async function writeLog(entries: RoutingDecision[]): Promise<void> {
	await mkdir(dirname(PATHS.routingLog), { recursive: true });
	await writeFile(PATHS.routingLog, JSON.stringify(entries, null, '\t'), 'utf-8');
}

// ── Cost estimation (per 1K tokens, approximate) ───────────────────────

const COST_PER_REQUEST: Record<string, number> = {
	'gpt-oss:20b': 0,
	'gpt-oss': 0,
	'ollama': 0,
	'claude-code': 0.01,
	'claude-sonnet-4-6': 0.003,
	'claude-haiku-4-5-20251001': 0.0002
};

function estimateCost(model: string): number {
	for (const [key, cost] of Object.entries(COST_PER_REQUEST)) {
		if (model.includes(key)) return cost;
	}
	return 0;
}

// ── Public API ─────────────────────────────────────────────────────────

export async function logRoutingDecision(opts: {
	model: string;
	provider: string;
	agent: string;
	taskType: string;
	complexity: number;
	latencyMs: number;
	success: boolean;
	source: string;
	reason?: string;
	sessionId?: string;
}): Promise<RoutingDecision> {
	const entry: RoutingDecision = {
		id: crypto.randomUUID().slice(0, 10),
		timestamp: new Date().toISOString(),
		...opts
	};

	const log = await readLog();
	log.unshift(entry);
	if (log.length > MAX_ENTRIES) {
		log.length = MAX_ENTRIES;
	}
	await writeLog(log);

	return entry;
}

export async function getRoutingStats(): Promise<RoutingStats> {
	const log = await readLog();

	const totalDecisions = log.length;
	const successCount = log.filter((d) => d.success).length;
	const successRate = totalDecisions > 0 ? successCount / totalDecisions : 0;
	const avgLatencyMs = totalDecisions > 0
		? log.reduce((sum, d) => sum + d.latencyMs, 0) / totalDecisions
		: 0;

	// By model
	const byModel: Record<string, ModelStats> = {};
	for (const d of log) {
		if (!byModel[d.model]) {
			byModel[d.model] = {
				model: d.model,
				provider: d.provider,
				count: 0,
				successRate: 0,
				avgLatencyMs: 0,
				avgComplexity: 0,
				costEstimate: 0
			};
		}
		const m = byModel[d.model];
		m.count++;
		m.avgLatencyMs += d.latencyMs;
		m.avgComplexity += d.complexity;
		m.costEstimate += estimateCost(d.model);
		if (d.success) m.successRate++;
	}
	for (const m of Object.values(byModel)) {
		if (m.count > 0) {
			m.avgLatencyMs /= m.count;
			m.avgComplexity /= m.count;
			m.successRate /= m.count;
		}
	}

	// By agent
	const byAgent: Record<string, AgentStats> = {};
	for (const d of log) {
		if (!byAgent[d.agent]) {
			byAgent[d.agent] = { agent: d.agent, count: 0, successRate: 0, avgLatencyMs: 0, taskTypes: [] };
		}
		const a = byAgent[d.agent];
		a.count++;
		a.avgLatencyMs += d.latencyMs;
		if (d.success) a.successRate++;
		if (!a.taskTypes.includes(d.taskType)) a.taskTypes.push(d.taskType);
	}
	for (const a of Object.values(byAgent)) {
		if (a.count > 0) {
			a.avgLatencyMs /= a.count;
			a.successRate /= a.count;
		}
	}

	// By task type
	const byTaskType: Record<string, TaskTypeStats> = {};
	for (const d of log) {
		if (!byTaskType[d.taskType]) {
			byTaskType[d.taskType] = {
				taskType: d.taskType,
				count: 0,
				preferredAgent: '',
				avgComplexity: 0,
				successRate: 0
			};
		}
		const t = byTaskType[d.taskType];
		t.count++;
		t.avgComplexity += d.complexity;
		if (d.success) t.successRate++;
	}
	// Find preferred agent per task type
	for (const [taskType, stats] of Object.entries(byTaskType)) {
		const taskEntries = log.filter((d) => d.taskType === taskType);
		const agentCounts: Record<string, number> = {};
		for (const d of taskEntries) {
			agentCounts[d.agent] = (agentCounts[d.agent] ?? 0) + 1;
		}
		stats.preferredAgent = Object.entries(agentCounts)
			.sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
		if (stats.count > 0) {
			stats.avgComplexity /= stats.count;
			stats.successRate /= stats.count;
		}
	}

	// Hourly activity (last 24 hours)
	const now = Date.now();
	const hourlyActivity: HourlyBucket[] = [];
	for (let h = 23; h >= 0; h--) {
		const hourStart = now - (h + 1) * 3600_000;
		const hourEnd = now - h * 3600_000;
		const bucket = log.filter((d) => {
			const ts = new Date(d.timestamp).getTime();
			return ts >= hourStart && ts < hourEnd;
		});
		const hourLabel = new Date(hourEnd).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		hourlyActivity.push({
			hour: hourLabel,
			count: bucket.length,
			successRate: bucket.length > 0 ? bucket.filter((d) => d.success).length / bucket.length : 0
		});
	}

	return {
		totalDecisions,
		successRate,
		avgLatencyMs,
		byModel,
		byAgent,
		byTaskType,
		recentDecisions: log.slice(0, 20),
		hourlyActivity
	};
}

export async function getRecentDecisions(limit = 20): Promise<RoutingDecision[]> {
	const log = await readLog();
	return log.slice(0, limit);
}

export async function getWorkflowStats(): Promise<WorkflowStats> {
	const log = await readLog();

	// Group decisions by sessionId to form workflow chains
	const sessionMap = new Map<string, RoutingDecision[]>();
	const noSession: RoutingDecision[] = [];

	for (const d of log) {
		if (d.sessionId) {
			const arr = sessionMap.get(d.sessionId) ?? [];
			arr.push(d);
			sessionMap.set(d.sessionId, arr);
		} else {
			noSession.push(d);
		}
	}

	// Build workflow chains from sessions
	const workflows: WorkflowChain[] = [];
	for (const [sessionId, decisions] of sessionMap) {
		const sorted = decisions.sort((a, b) =>
			new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
		);
		const steps: WorkflowStep[] = sorted.map((d) => ({
			agent: d.agent,
			model: d.model,
			provider: d.provider,
			taskType: d.taskType,
			complexity: d.complexity,
			latencyMs: d.latencyMs,
			success: d.success
		}));

		const providers = new Set(sorted.map((d) => d.provider));
		const escalated = providers.size > 1 || sorted.some((d) => d.complexity > 0.3 && d.provider !== 'internal');

		workflows.push({
			sessionId,
			source: sorted[0].source,
			steps,
			totalLatencyMs: sorted.reduce((sum, d) => sum + d.latencyMs, 0),
			escalated,
			startTime: sorted[0].timestamp
		});
	}

	// Also create single-step "workflows" for non-session decisions
	for (const d of noSession) {
		workflows.push({
			sessionId: d.id,
			source: d.source,
			steps: [{
				agent: d.agent,
				model: d.model,
				provider: d.provider,
				taskType: d.taskType,
				complexity: d.complexity,
				latencyMs: d.latencyMs,
				success: d.success
			}],
			totalLatencyMs: d.latencyMs,
			escalated: false,
			startTime: d.timestamp
		});
	}

	// Sort by most recent
	workflows.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

	// By source stats
	const bySource: Record<string, SourceStats> = {};
	for (const wf of workflows) {
		const src = wf.source || 'unknown';
		if (!bySource[src]) {
			bySource[src] = {
				source: src,
				count: 0,
				successRate: 0,
				avgLatencyMs: 0,
				escalationRate: 0,
				topAgents: [],
				topTaskTypes: []
			};
		}
		const s = bySource[src];
		s.count++;
		s.avgLatencyMs += wf.totalLatencyMs;
		if (wf.escalated) s.escalationRate++;
		const allSuccess = wf.steps.every((st) => st.success);
		if (allSuccess) s.successRate++;
	}

	for (const s of Object.values(bySource)) {
		if (s.count > 0) {
			s.avgLatencyMs /= s.count;
			s.successRate /= s.count;
			s.escalationRate /= s.count;
		}

		// Compute top agents and task types from all decisions for this source
		const agentCounts: Record<string, number> = {};
		const taskCounts: Record<string, number> = {};
		for (const wf of workflows) {
			if ((wf.source || 'unknown') !== s.source) continue;
			for (const step of wf.steps) {
				agentCounts[step.agent] = (agentCounts[step.agent] ?? 0) + 1;
				taskCounts[step.taskType] = (taskCounts[step.taskType] ?? 0) + 1;
			}
		}
		s.topAgents = Object.entries(agentCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([agent, count]) => ({ agent, count }));
		s.topTaskTypes = Object.entries(taskCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([taskType, count]) => ({ taskType, count }));
	}

	const escalatedCount = workflows.filter((w) => w.escalated).length;
	const totalChainSteps = workflows.reduce((sum, w) => sum + w.steps.length, 0);

	// ── Chain pattern analysis ─────────────────────────────────────────
	const patternMap = new Map<string, { count: number; successes: number; latencySum: number; escalations: number; sourceCounts: Record<string, number> }>();
	for (const wf of workflows) {
		if (wf.steps.length === 0) continue;
		const key = wf.steps.map((s) => s.agent).join(' → ');
		const entry = patternMap.get(key) ?? { count: 0, successes: 0, latencySum: 0, escalations: 0, sourceCounts: {} };
		entry.count++;
		if (wf.steps.every((s) => s.success)) entry.successes++;
		entry.latencySum += wf.totalLatencyMs;
		if (wf.escalated) entry.escalations++;
		entry.sourceCounts[wf.source] = (entry.sourceCounts[wf.source] ?? 0) + 1;
		patternMap.set(key, entry);
	}

	const chainPatterns: ChainPattern[] = [...patternMap.entries()]
		.map(([key, v]) => ({
			pattern: key.split(' → '),
			count: v.count,
			successRate: v.count > 0 ? v.successes / v.count : 0,
			avgLatencyMs: v.count > 0 ? v.latencySum / v.count : 0,
			escalationRate: v.count > 0 ? v.escalations / v.count : 0,
			sources: Object.entries(v.sourceCounts)
				.sort((a, b) => b[1] - a[1])
				.map(([source, count]) => ({ source, count }))
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, 15);

	// ── Agent routing profiles ─────────────────────────────────────────
	const agentProfiles: Record<string, AgentRoutingProfile> = {};

	function ensureProfile(agent: string): AgentRoutingProfile {
		if (!agentProfiles[agent]) {
			agentProfiles[agent] = {
				agent,
				totalRouted: 0,
				asFirst: 0,
				asLast: 0,
				escalatedFrom: 0,
				escalatedTo: 0,
				avgComplexityHandled: 0,
				modelsUsed: [],
				taskTypes: [],
				successRate: 0,
				avgLatencyMs: 0
			};
		}
		return agentProfiles[agent];
	}

	const agentModelCounts: Record<string, Record<string, number>> = {};
	const agentTaskCounts: Record<string, Record<string, number>> = {};

	for (const wf of workflows) {
		for (let i = 0; i < wf.steps.length; i++) {
			const step = wf.steps[i];
			const p = ensureProfile(step.agent);
			p.totalRouted++;
			p.avgComplexityHandled += step.complexity;
			p.avgLatencyMs += step.latencyMs;
			if (step.success) p.successRate++;

			if (i === 0) p.asFirst++;
			if (i === wf.steps.length - 1) p.asLast++;

			// Escalation tracking: if next step uses a different provider, this agent escalated
			if (i < wf.steps.length - 1 && wf.steps[i + 1].provider !== step.provider) {
				p.escalatedFrom++;
				const nextP = ensureProfile(wf.steps[i + 1].agent);
				nextP.escalatedTo++;
			}

			// Model and task type tracking
			if (!agentModelCounts[step.agent]) agentModelCounts[step.agent] = {};
			agentModelCounts[step.agent][step.model] = (agentModelCounts[step.agent][step.model] ?? 0) + 1;

			if (!agentTaskCounts[step.agent]) agentTaskCounts[step.agent] = {};
			agentTaskCounts[step.agent][step.taskType] = (agentTaskCounts[step.agent][step.taskType] ?? 0) + 1;
		}
	}

	for (const p of Object.values(agentProfiles)) {
		if (p.totalRouted > 0) {
			p.avgComplexityHandled /= p.totalRouted;
			p.avgLatencyMs /= p.totalRouted;
			p.successRate /= p.totalRouted;
		}
		p.modelsUsed = Object.entries(agentModelCounts[p.agent] ?? {})
			.sort((a, b) => b[1] - a[1])
			.map(([model, count]) => ({ model, count }));
		p.taskTypes = Object.entries(agentTaskCounts[p.agent] ?? {})
			.sort((a, b) => b[1] - a[1])
			.map(([taskType, count]) => ({ taskType, count }));
	}

	return {
		bySource,
		recentWorkflows: workflows.slice(0, 10),
		escalationRate: workflows.length > 0 ? escalatedCount / workflows.length : 0,
		avgChainLength: workflows.length > 0 ? totalChainSteps / workflows.length : 0,
		clawInitiated: workflows.filter((w) => w.source === 'claw').length,
		userInitiated: workflows.filter((w) => w.source === 'user').length,
		chainPatterns,
		agentProfiles
	};
}
