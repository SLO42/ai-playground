import type {
	CodeSection,
	RoutingSection,
	TaskSection,
	ConversationSection,
	ServiceSection,
	GpuSection,
	TokenSection,
	NotificationSection
} from './reports.js';

// ── Score Types ──────────────────────────────────────────────────────

export interface ScoreBreakdown {
	label: string;
	score: number; // 0-100
	weight: number; // 0-1, weights within a category sum to 1
	detail: string;
}

export interface CompositeScore {
	score: number; // 0-100 weighted total
	grade: 'A' | 'B' | 'C' | 'D' | 'F';
	breakdown: ScoreBreakdown[];
}

export interface ScoringResult {
	systemHealth: CompositeScore;
	businessValue: CompositeScore;
	overall: number; // 0-100 blended
}

// ── Helpers ──────────────────────────────────────────────────────────

function clamp(v: number, min = 0, max = 100): number {
	return Math.max(min, Math.min(max, v));
}

function grade(score: number): CompositeScore['grade'] {
	if (score >= 90) return 'A';
	if (score >= 75) return 'B';
	if (score >= 60) return 'C';
	if (score >= 40) return 'D';
	return 'F';
}

function weightedScore(breakdown: ScoreBreakdown[]): number {
	const total = breakdown.reduce((sum, b) => sum + b.score * b.weight, 0);
	return clamp(Math.round(total));
}

// ── System Health Scoring ────────────────────────────────────────────
// Measures operational reliability: are services up, is routing working,
// are alerts low, is GPU healthy?

export function computeSystemHealth(sections: {
	services: ServiceSection;
	routing: RoutingSection;
	gpu: GpuSection;
	tokens: TokenSection;
	notifications: NotificationSection;
}): CompositeScore {
	const { services, routing, gpu, tokens, notifications } = sections;

	// 1. Service uptime (weight 0.30)
	const svcEntries = Object.values(services.uptime);
	const uptimePct = svcEntries.length > 0
		? svcEntries.reduce((s, e) => s + e.upPercent, 0) / svcEntries.length
		: 100;
	const uptimeScore = clamp(uptimePct);

	// 2. Routing success (weight 0.25)
	const routingScore = routing.totalDecisions > 0
		? clamp(routing.successRate * 100)
		: 100; // no decisions = no failures

	// 3. Routing latency (weight 0.10) — penalize high avg latency
	let latencyScore = 100;
	if (routing.totalDecisions > 0) {
		// <100ms = 100, >2000ms = 0, linear between
		latencyScore = clamp(100 - ((routing.avgLatencyMs - 100) / 1900) * 100);
	}

	// 4. Alert burden (weight 0.20) — critical alerts hurt the most
	const alertPenalty = Math.min(notifications.criticalCount * 15 + (notifications.total - notifications.criticalCount) * 2, 100);
	const alertScore = clamp(100 - alertPenalty);

	// 5. GPU health (weight 0.15) — VRAM usage ratio
	let gpuScore = 100;
	if (gpu.vramTotalGb > 0 && gpu.vramUsedGb > 0) {
		const vramRatio = gpu.vramUsedGb / gpu.vramTotalGb;
		// Under 80% = fine, 80-95% warning, >95% critical
		if (vramRatio > 0.95) gpuScore = 20;
		else if (vramRatio > 0.80) gpuScore = 60;
		else gpuScore = 100;
	}

	const breakdown: ScoreBreakdown[] = [
		{ label: 'Service Uptime', score: uptimeScore, weight: 0.30, detail: `${uptimePct.toFixed(0)}% average across ${svcEntries.length} services` },
		{ label: 'Routing Success', score: routingScore, weight: 0.25, detail: `${(routing.successRate * 100).toFixed(0)}% of ${routing.totalDecisions} decisions` },
		{ label: 'Routing Latency', score: latencyScore, weight: 0.10, detail: `${routing.avgLatencyMs.toFixed(0)}ms average` },
		{ label: 'Alert Burden', score: alertScore, weight: 0.20, detail: `${notifications.criticalCount} critical, ${notifications.total} total` },
		{ label: 'GPU Health', score: gpuScore, weight: 0.15, detail: `${gpu.vramUsedGb.toFixed(1)}/${gpu.vramTotalGb} GB VRAM` }
	];

	const score = weightedScore(breakdown);
	return { score, grade: grade(score), breakdown };
}

// ── Business Value Scoring ───────────────────────────────────────────
// Measures productivity and ROI: are tasks being completed, is code
// being written, are conversations productive, is cost efficient?

export function computeBusinessValue(sections: {
	tasks: TaskSection;
	code: CodeSection;
	conversations: ConversationSection;
	routing: RoutingSection;
	tokens: TokenSection;
	gpu: GpuSection;
}): CompositeScore {
	const { tasks, code, conversations, routing, tokens, gpu } = sections;

	// 1. Task throughput (weight 0.30) — completion rate
	let taskScore = 100;
	if (tasks.created > 0) {
		taskScore = clamp((tasks.completed / tasks.created) * 100);
	} else {
		taskScore = 50; // no tasks = neutral
	}

	// 2. Code output (weight 0.20) — edits and lines
	let codeScore = 50; // baseline
	if (code.totalEdits > 0) {
		// Scale: 1-5 edits = 60, 5-20 = 80, 20+ = 100
		if (code.totalEdits >= 20) codeScore = 100;
		else if (code.totalEdits >= 5) codeScore = 80;
		else codeScore = 60;
	}

	// 3. Automation rate (weight 0.15) — tasks auto-completed by Claw
	const autoScore = tasks.automationSuccessRate > 0
		? clamp(tasks.automationSuccessRate * 100)
		: 50;

	// 4. Conversation engagement (weight 0.15)
	let engageScore = 50;
	if (conversations.totalSessions > 0) {
		// More sessions with reasonable message counts = good
		const avgMsgs = conversations.avgMessagesPerSession;
		if (avgMsgs >= 3 && avgMsgs <= 50) engageScore = 90;
		else if (avgMsgs > 0) engageScore = 70;
	}

	// 5. Cost efficiency (weight 0.20) — local vs API ratio
	const totalTokens = tokens.claudeCodeTokensUsed + tokens.localTokensFree;
	let costScore = 80;
	if (totalTokens > 0) {
		const localRatio = tokens.localTokensFree / totalTokens;
		// Higher local ratio = better cost efficiency
		costScore = clamp(localRatio * 100 + 20); // +20 baseline since some API use is expected
	}

	const breakdown: ScoreBreakdown[] = [
		{ label: 'Task Throughput', score: taskScore, weight: 0.30, detail: `${tasks.completed}/${tasks.created} completed` },
		{ label: 'Code Output', score: codeScore, weight: 0.20, detail: `${code.totalEdits} edits, ~${code.totalLinesChanged} lines` },
		{ label: 'Automation Rate', score: autoScore, weight: 0.15, detail: `${(tasks.automationSuccessRate * 100).toFixed(0)}% auto-success` },
		{ label: 'Engagement', score: engageScore, weight: 0.15, detail: `${conversations.totalSessions} sessions, ${conversations.avgMessagesPerSession.toFixed(1)} avg msgs` },
		{ label: 'Cost Efficiency', score: costScore, weight: 0.20, detail: `$${tokens.estimatedApiCost.toFixed(4)} API + $${gpu.estimatedCostUsd.toFixed(4)} GPU` }
	];

	const score = weightedScore(breakdown);
	return { score, grade: grade(score), breakdown };
}

// ── Combined Scoring ─────────────────────────────────────────────────

export function computeScores(sections: {
	code: CodeSection;
	routing: RoutingSection;
	tasks: TaskSection;
	conversations: ConversationSection;
	services: ServiceSection;
	gpu: GpuSection;
	tokens: TokenSection;
	notifications: NotificationSection;
}): ScoringResult {
	const systemHealth = computeSystemHealth(sections);
	const businessValue = computeBusinessValue(sections);

	// Overall: 50/50 blend
	const overall = clamp(Math.round(systemHealth.score * 0.5 + businessValue.score * 0.5));

	return { systemHealth, businessValue, overall };
}
