import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { resolve, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PATHS, APIS, SERVICES } from './constants.js';
import { getRoutingStats, getRecentDecisions } from './routing-telemetry.js';
import { getNotifications, getStats as getNotifStats } from './notifications.js';
import { getAllTasks, migrateIfNeeded } from './task-store.js';
import { getAgentAnalytics } from './heartbeat/agent-analytics.js';
import { computeScores, type ScoringResult } from './scoring-engine.js';
export type { ScoringResult, CompositeScore, ScoreBreakdown } from './scoring-engine.js';

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface Report {
	id: string;
	type: ReportType;
	periodStart: string;
	periodEnd: string;
	generatedAt: string;
	generatedBy: string;
	sections: ReportSections;
	scores: ScoringResult;
}

export interface ReportSections {
	summary: SummarySection;
	code: CodeSection;
	routing: RoutingSection;
	tasks: TaskSection;
	conversations: ConversationSection;
	services: ServiceSection;
	gpu: GpuSection;
	tokens: TokenSection;
	projects: ProjectSection;
	notifications: NotificationSection;
	systemEvents: SystemEventsSection;
}

export interface SummarySection {
	periodLabel: string;
	highlights: string[];
	healthScore: number; // 0-100 system health based on real metrics
}

export interface CodeSection {
	totalEdits: number;
	totalLinesChanged: number;
	totalCharsWritten: number;
	filesModified: number;
	topFiles: { file: string; changes: number }[];
}

export interface RoutingSection {
	totalDecisions: number;
	successRate: number;
	avgLatencyMs: number;
	costEstimate: number;
	byAgent: Record<string, { count: number; successRate: number }>;
	byModel: Record<string, { count: number; avgLatencyMs: number; cost: number }>;
	mostUsedModel: string;
	mostUsedAgent: string;
}

export interface TaskSection {
	created: number;
	completed: number;
	inProgress: number;
	pending: number;
	automationSuccessRate: number;
	topProjects: { project: string; taskCount: number }[];
}

export interface ConversationSection {
	totalSessions: number;
	totalMessages: number;
	clawSessions: number;
	userSessions: number;
	avgMessagesPerSession: number;
}

export interface ServiceSection {
	uptime: Record<string, { service: string; status: string; checks: number; upPercent: number }>;
	totalHealthChecks: number;
}

export interface GpuSection {
	modelName: string;
	vramUsedGb: number;
	vramTotalGb: number;
	estimatedHoursActive: number;
	estimatedWatts: number;
	estimatedKwh: number;
	estimatedCostUsd: number; // at ~$0.12/kWh average US residential
}

export interface TokenSection {
	claudeCodeTokensUsed: number;
	claudeCodeTokenLimit: number;
	claudeCodeUsagePercent: number;
	estimatedApiCost: number;
	localTokensFree: number;
	agentTokens: {
		totalInput: number;
		totalOutput: number;
		totalCost: number;
		taskCount: number;
		byModel: Record<string, { input: number; output: number; cost: number; count: number }>;
	};
}

export interface ProjectSection {
	totalProjects: number;
	mostActive: { name: string; activity: number }[];
	projectSummaries: { name: string; tasks: number; completedTasks: number; sessions: number }[];
}

export interface NotificationSection {
	total: number;
	bySeverity: Record<string, number>;
	byCategory: Record<string, number>;
	criticalCount: number;
}

export interface SystemEventsSection {
	review: { spawned: number; completed: number; findings: number; escalated: number };
	dependencies: { created: number; resolved: number; blocked: number };
	pm: { spawned: number; syncs: number; reviews: number; chats: number };
	memory: { consolidations: number; pruned: number };
	releases: { prepared: number; published: number; changelogs: number };
	settings: { saved: number; routingChanged: number };
	githubSync: { pulls: number; pushes: number; failures: number };
	dependencyHealth: { audits: number; vulnerabilities: number };
	coverage: { collected: number; regressions: number };
	services: { started: number; restarts: number; restartFailures: number };
}

// ── Report Storage ────────────────────────────────────────────────────

async function ensureDir() {
	await mkdir(PATHS.reportsDir, { recursive: true });
}

function reportFileName(type: ReportType, date: string): string {
	return `${type}-${date}.json`;
}

export async function saveReport(report: Report): Promise<void> {
	await ensureDir();
	const filename = reportFileName(report.type, report.periodStart.slice(0, 10));
	await writeFile(join(PATHS.reportsDir, filename), JSON.stringify(report, null, '\t'), 'utf-8');
}

export async function getReport(type: ReportType, date: string): Promise<Report | null> {
	try {
		const raw = await readFile(join(PATHS.reportsDir, reportFileName(type, date)), 'utf-8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export async function listReports(): Promise<{ id: string; type: ReportType; date: string; generatedAt: string }[]> {
	await ensureDir();
	try {
		const files = await readdir(PATHS.reportsDir);
		const reports: { id: string; type: ReportType; date: string; generatedAt: string }[] = [];

		for (const f of files.filter((f) => f.endsWith('.json'))) {
			try {
				const raw = await readFile(join(PATHS.reportsDir, f), 'utf-8');
				const report = JSON.parse(raw) as Report;
				reports.push({
					id: report.id,
					type: report.type,
					date: report.periodStart.slice(0, 10),
					generatedAt: report.generatedAt
				});
			} catch { /* skip bad files */ }
		}

		reports.sort((a, b) => b.date.localeCompare(a.date));
		return reports;
	} catch {
		return [];
	}
}

// ── Data Collection ───────────────────────────────────────────────────

async function readJson<T>(path: string): Promise<T | null> {
	try {
		const raw = await readFile(path, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function collectCodeStats(periodStart: Date, periodEnd: Date): Promise<CodeSection> {
	// Use git log --numstat for real file-change data
	const since = periodStart.toISOString();
	const until = periodEnd.toISOString();
	let totalEdits = 0;
	let totalLinesChanged = 0;
	const fileCounts: Record<string, number> = {};

	try {
		const { stdout } = await execFileAsync('git', [
			'log', '--numstat', '--pretty=format:', `--since=${since}`, `--until=${until}`
		], { cwd: PATHS.root, timeout: 10_000 });

		for (const line of stdout.split('\n')) {
			const parts = line.trim().split('\t');
			if (parts.length !== 3) continue;
			const [addedStr, deletedStr, file] = parts;
			if (addedStr === '-' || deletedStr === '-') continue; // binary files
			const added = parseInt(addedStr, 10) || 0;
			const deleted = parseInt(deletedStr, 10) || 0;
			totalLinesChanged += added + deleted;
			totalEdits++;
			fileCounts[file] = (fileCounts[file] ?? 0) + added + deleted;
		}
	} catch { /* git not available or no commits */ }

	// Also count edits from Claude Flow session metrics as a supplement
	try {
		const entries = await readdir(PATHS.sessionsDir);
		for (const file of entries.filter((f) => f.startsWith('session-') && f.endsWith('.json'))) {
			try {
				const raw = await readFile(join(PATHS.sessionsDir, file), 'utf-8');
				const session = JSON.parse(raw);
				const started = new Date(session.startedAt);
				if (started >= periodStart && started < periodEnd) {
					totalEdits += session.metrics?.edits ?? 0;
				}
			} catch { /* skip */ }
		}
	} catch { /* no sessions */ }

	const topFiles = Object.entries(fileCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([file, changes]) => ({ file, changes }));

	const filesModified = Object.keys(fileCounts).length;

	return {
		totalEdits,
		totalLinesChanged,
		totalCharsWritten: totalLinesChanged * 40,
		filesModified,
		topFiles
	};
}

async function collectTaskStats(periodStart: Date, periodEnd: Date): Promise<TaskSection> {
	const registry = await readJson<{ projects: { id: string; name: string; path: string }[] }>(PATHS.playgroundRegistry);

	let created = 0, completed = 0, inProgress = 0, pending = 0;
	const projectTaskCounts: Record<string, number> = {};
	let autoCreated = 0, autoCompleted = 0;
	const seenPaths = new Set<string>();

	// Collect tasks from project registry entries
	const projectEntries = registry?.projects ?? [];
	for (const project of projectEntries) {
		const fullPath = project.path === '.' ? PATHS.root : resolve(PATHS.root, project.path);
		seenPaths.add(fullPath);
		await migrateIfNeeded(fullPath);
		const tasks = await getAllTasks(fullPath);
		if (tasks.length === 0) continue;

		let projectCount = 0;
		for (const task of tasks) {
			const createdAt = new Date(task.createdAt);
			const inPeriod = createdAt >= periodStart && createdAt < periodEnd;

			if (inPeriod) {
				created++;
				projectCount++;
				if (task.createdBy === 'claw') autoCreated++;
			}

			if (task.status === 'completed') {
				const completedAt = task.completedAt ? new Date(task.completedAt) : null;
				if (completedAt && completedAt >= periodStart && completedAt < periodEnd) {
					completed++;
					if (task.assignee === 'claw') autoCompleted++;
				}
			} else if (task.status === 'in_progress') {
				inProgress++;
			} else if (task.status === 'pending') {
				pending++;
			}
		}

		const label = (project as Record<string, string>).name ?? (project as Record<string, string>).id ?? project.path;
		if (projectCount > 0) {
			projectTaskCounts[label] = projectCount;
		}
	}

	// Also include root-level tasks if not already covered by a project with path "."
	if (!seenPaths.has(PATHS.root)) {
		await migrateIfNeeded(PATHS.root);
		const rootTasks = await getAllTasks(PATHS.root);
		for (const task of rootTasks) {
			const createdAt = new Date(task.createdAt);
			const inPeriod = createdAt >= periodStart && createdAt < periodEnd;

			if (inPeriod) {
				created++;
				if (task.createdBy === 'claw') autoCreated++;
			}

			if (task.status === 'completed') {
				const completedAt = task.completedAt ? new Date(task.completedAt) : null;
				if (completedAt && completedAt >= periodStart && completedAt < periodEnd) {
					completed++;
					if (task.assignee === 'claw') autoCompleted++;
				}
			} else if (task.status === 'in_progress') {
				inProgress++;
			} else if (task.status === 'pending') {
				pending++;
			}
		}
	}

	const topProjects = Object.entries(projectTaskCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([project, taskCount]) => ({ project, taskCount }));

	return {
		created,
		completed,
		inProgress,
		pending,
		automationSuccessRate: autoCreated > 0 ? autoCompleted / autoCreated : 0,
		topProjects
	};
}

async function collectConversationStats(periodStart: Date, periodEnd: Date): Promise<ConversationSection> {
	let totalMessages = 0;
	let clawSessions = 0;
	let userSessions = 0;
	let totalSessions = 0;

	// Primary source: chat index
	const indexFile = `${PATHS.chatsDir}/index.json`;
	const chatIndex = await readJson<any[]>(indexFile) ?? [];

	const inPeriod = chatIndex.filter((s) => {
		const created = new Date(s.createdAt);
		return created >= periodStart && created < periodEnd;
	});

	for (const s of inPeriod) {
		totalMessages += s.messageCount ?? 0;
		if (s.source === 'claw') clawSessions++;
		else userSessions++;
	}
	totalSessions = inPeriod.length;

	// Fallback: if chat index is empty, count individual chat session files
	if (totalSessions === 0) {
		try {
			const files = await readdir(PATHS.chatsDir);
			const sessionFiles = files.filter((f) => f.endsWith('.json') && f !== 'index.json');
			for (const file of sessionFiles) {
				try {
					const raw = await readFile(join(PATHS.chatsDir, file), 'utf-8');
					const session = JSON.parse(raw);
					// Session files store messages as an array
					const messages = session.messages ?? [];
					const created = new Date(session.createdAt ?? session.startedAt ?? 0);
					if (created >= periodStart && created < periodEnd) {
						totalSessions++;
						totalMessages += messages.length;
						if (session.source === 'claw') clawSessions++;
						else userSessions++;
					}
				} catch { /* skip bad files */ }
			}
		} catch { /* no chats dir */ }
	}

	return {
		totalSessions,
		totalMessages,
		clawSessions,
		userSessions,
		avgMessagesPerSession: totalSessions > 0 ? totalMessages / totalSessions : 0
	};
}

async function collectRoutingStats(periodStart: Date, periodEnd: Date): Promise<RoutingSection> {
	const stats = await getRoutingStats();
	const recent = await getRecentDecisions(500);

	// Filter to period
	const inPeriod = recent.filter((d) => {
		const ts = new Date(d.timestamp);
		return ts >= periodStart && ts < periodEnd;
	});

	const total = inPeriod.length;
	const successes = inPeriod.filter((d) => d.success).length;

	const byAgent: Record<string, { count: number; successRate: number }> = {};
	const byModel: Record<string, { count: number; avgLatencyMs: number; cost: number }> = {};
	let totalCost = 0;

	for (const d of inPeriod) {
		// Agent stats
		if (!byAgent[d.agent]) byAgent[d.agent] = { count: 0, successRate: 0 };
		byAgent[d.agent].count++;
		if (d.success) byAgent[d.agent].successRate++;

		// Model stats
		if (!byModel[d.model]) byModel[d.model] = { count: 0, avgLatencyMs: 0, cost: 0 };
		byModel[d.model].count++;
		byModel[d.model].avgLatencyMs += d.latencyMs;
	}

	for (const a of Object.values(byAgent)) {
		if (a.count > 0) a.successRate /= a.count;
	}
	for (const m of Object.values(byModel)) {
		if (m.count > 0) m.avgLatencyMs /= m.count;
	}

	const mostUsedModel = Object.entries(byModel).sort((a, b) => b[1].count - a[1].count)[0]?.[0] ?? 'none';
	const mostUsedAgent = Object.entries(byAgent).sort((a, b) => b[1].count - a[1].count)[0]?.[0] ?? 'none';

	return {
		totalDecisions: total,
		successRate: total > 0 ? successes / total : 0,
		avgLatencyMs: total > 0 ? inPeriod.reduce((s, d) => s + d.latencyMs, 0) / total : 0,
		costEstimate: totalCost,
		byAgent,
		byModel,
		mostUsedModel,
		mostUsedAgent
	};
}

async function collectServiceStats(): Promise<ServiceSection> {
	const uptime: ServiceSection['uptime'] = {};
	let totalChecks = 0;

	for (const [id, svc] of Object.entries(SERVICES)) {
		let status = 'unknown';
		if (id === 'claude-flow') {
			// Daemon has no HTTP health endpoint — check PID file + tasklist
			try {
				const { readFileSync, existsSync } = await import('fs');
				const { join } = await import('path');
				const pidFile = join(PATHS.root, '.claude-flow', 'daemon.pid');
				const stateFile = join(PATHS.root, '.claude-flow', 'daemon-state.json');
				if (existsSync(pidFile)) {
					const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
					if (!isNaN(pid) && pid > 0) {
						const { execSync } = await import('child_process');
						const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
							encoding: 'utf-8', timeout: 5000, windowsHide: true
						});
						status = out.includes(String(pid)) ? 'up' : 'down';
					}
				}
				if (status === 'unknown' && existsSync(stateFile)) {
					const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
					status = state.running ? 'up' : 'down';
				}
			} catch {
				status = 'down';
			}
		} else if (svc.healthUrl) {
			try {
				const res = await fetch(svc.healthUrl, { signal: AbortSignal.timeout(3000) });
				status = res.ok ? 'up' : 'down';
			} catch {
				status = 'down';
			}
		}
		totalChecks++;
		uptime[id] = { service: svc.name, status, checks: 1, upPercent: status === 'up' ? 100 : 0 };
	}

	return { uptime, totalHealthChecks: totalChecks };
}

async function collectGpuStats(hoursActive: number): Promise<GpuSection> {
	let vramUsedGb = 0;
	let modelName = 'none';
	let ollamaUptime = hoursActive;

	try {
		const res = await fetch(`${APIS.ollama}/api/ps`, { signal: AbortSignal.timeout(3000) });
		if (res.ok) {
			const ps = await res.json();
			const models = ps.models ?? [];
			if (models.length > 0) {
				modelName = models.map((m: any) => m.name).join(' + ');
				vramUsedGb = models.reduce((s: number, m: any) => s + (m.size_vram ?? 0), 0) / (1024 ** 3);

				// Estimate uptime from model expiry: Ollama returns `expires_at` for loaded models.
				// The model stays loaded for a keep-alive duration (default 5 min after last use).
				// If a model is currently loaded, Ollama has been active at least since it was loaded.
				// Also use `size_vram > 0` to confirm GPU usage.
				for (const m of models) {
					if (m.expires_at) {
						// Model loaded on GPU — Ollama is actively using GPU
						// Use routing log timestamps to estimate actual active duration
					}
				}
			}
		}
	} catch { /* offline */ }

	// If routing-based estimate is 0 but Ollama has models loaded, estimate from sessions
	if (ollamaUptime <= 0) {
		try {
			const entries = await readdir(PATHS.sessionsDir);
			const sessionFiles = entries.filter((f) => f.startsWith('session-') && f.endsWith('.json'));
			let totalDurationMs = 0;
			for (const file of sessionFiles) {
				try {
					const raw = await readFile(join(PATHS.sessionsDir, file), 'utf-8');
					const session = JSON.parse(raw);
					if (session.duration) totalDurationMs += session.duration;
				} catch { /* skip */ }
			}
			// Sessions record total duration; assume ~30% involves GPU inference
			if (totalDurationMs > 0) {
				ollamaUptime = (totalDurationMs * 0.3) / 3_600_000;
			}
		} catch { /* no sessions */ }
	}

	// If we have models loaded on GPU, ensure at least a minimum uptime is reported
	if (ollamaUptime <= 0 && vramUsedGb > 0) {
		ollamaUptime = 0.1; // at least ~6 minutes if GPU is currently active
	}

	// RTX 3090: TDP ~350W, typical inference ~150-200W
	const inferenceWatts = 175;
	const kwh = (inferenceWatts * ollamaUptime) / 1000;
	const costPerKwh = 0.12; // US average residential

	return {
		modelName,
		vramUsedGb,
		vramTotalGb: 24,
		estimatedHoursActive: ollamaUptime,
		estimatedWatts: inferenceWatts,
		estimatedKwh: kwh,
		estimatedCostUsd: kwh * costPerKwh
	};
}

async function collectTokenStats(periodStart: Date, periodEnd: Date): Promise<TokenSection> {
	const tokenLimit = 1_000_000; // Typical monthly limit

	// ── Real agent token data from agent-usage.json ──
	const usagePath = resolve(PATHS.root, '.playground/agent-usage.json');
	let agentEntries: any[] = [];
	try {
		const raw = await readFile(usagePath, 'utf-8');
		agentEntries = JSON.parse(raw);
	} catch { /* no usage log yet */ }

	// Filter to period
	const periodEntries = agentEntries.filter((e: any) => {
		const ts = new Date(e.timestamp);
		return ts >= periodStart && ts < periodEnd;
	});

	let agentInputTotal = 0;
	let agentOutputTotal = 0;
	let agentCostTotal = 0;
	const byModel: Record<string, { input: number; output: number; cost: number; count: number }> = {};

	for (const e of periodEntries) {
		agentInputTotal += e.inputTokens ?? 0;
		agentOutputTotal += e.outputTokens ?? 0;
		agentCostTotal += e.costUsd ?? 0;

		const model = e.model ?? 'unknown';
		if (!byModel[model]) byModel[model] = { input: 0, output: 0, cost: 0, count: 0 };
		byModel[model].input += e.inputTokens ?? 0;
		byModel[model].output += e.outputTokens ?? 0;
		byModel[model].cost += e.costUsd ?? 0;
		byModel[model].count++;
	}

	// ── Routing-based estimates for non-agent calls ──
	const recent = await getRecentDecisions(500);
	const periodDecisions = recent.filter((d) => {
		const ts = new Date(d.timestamp);
		return ts >= periodStart && ts < periodEnd;
	});
	const localCalls = periodDecisions.filter((d) => d.provider === 'ollama' || d.provider === 'internal');
	const localTokenCount = localCalls.length * 800; // ~800 tokens per local call

	// Combined API tokens = real agent data + estimated routing API calls
	const apiDecisions = periodDecisions.filter((d) => d.provider === 'claude' || d.provider === 'claude-code');
	let routingApiCost = 0;
	for (const d of apiDecisions) {
		if (d.model.includes('haiku')) routingApiCost += 0.001;
		else if (d.model.includes('sonnet')) routingApiCost += 0.005;
		else routingApiCost += 0.01;
	}

	const totalApiTokens = agentInputTotal + agentOutputTotal + (apiDecisions.length * 1500);
	const totalApiCost = agentCostTotal + routingApiCost;

	return {
		claudeCodeTokensUsed: totalApiTokens,
		claudeCodeTokenLimit: tokenLimit,
		claudeCodeUsagePercent: tokenLimit > 0 ? (totalApiTokens / tokenLimit) * 100 : 0,
		estimatedApiCost: totalApiCost,
		localTokensFree: localTokenCount,
		agentTokens: {
			totalInput: agentInputTotal,
			totalOutput: agentOutputTotal,
			totalCost: agentCostTotal,
			taskCount: periodEntries.length,
			byModel
		}
	};
}

async function collectProjectStats(periodStart: Date, periodEnd: Date): Promise<ProjectSection> {
	const registry = await readJson<{ projects: { id: string; name: string; path: string }[] }>(PATHS.playgroundRegistry);
	if (!registry?.projects) return { totalProjects: 0, mostActive: [], projectSummaries: [] };

	const summaries: ProjectSection['projectSummaries'] = [];

	for (const project of registry.projects) {
		const fullPath = project.path === '.' ? PATHS.root : resolve(PATHS.root, project.path);
		await migrateIfNeeded(fullPath);
		const tasks = await getAllTasks(fullPath);

		const periodTasks = tasks.filter((t: any) => {
			const created = new Date(t.createdAt);
			return created >= periodStart && created < periodEnd;
		});

		summaries.push({
			name: project.name ?? project.id,
			tasks: periodTasks.length,
			completedTasks: periodTasks.filter((t) => t.status === 'completed').length,
			sessions: 0
		});
	}

	const mostActive = summaries
		.map((s) => ({ name: s.name, activity: s.tasks + s.completedTasks }))
		.sort((a, b) => b.activity - a.activity)
		.slice(0, 5);

	return {
		totalProjects: registry.projects.length,
		mostActive,
		projectSummaries: summaries
	};
}

async function collectNotificationStats(periodStart: Date, periodEnd: Date): Promise<NotificationSection> {
	const { items: all } = await getNotifications({ limit: 200 });
	const inPeriod = all.filter((n) => {
		const ts = new Date(n.timestamp);
		return ts >= periodStart && ts < periodEnd;
	});

	const bySeverity: Record<string, number> = {};
	const byCategory: Record<string, number> = {};

	for (const n of inPeriod) {
		bySeverity[n.severity] = (bySeverity[n.severity] ?? 0) + 1;
		byCategory[n.category] = (byCategory[n.category] ?? 0) + 1;
	}

	return {
		total: inPeriod.length,
		bySeverity,
		byCategory,
		criticalCount: bySeverity['critical'] ?? 0
	};
}

// ── Time-Series Data for Charts ───────────────────────────────────────

export interface TimeSeriesData {
	labels: string[];
	taskCompletion: { created: number[]; completed: number[] };
	routingDecisions: { total: number[]; success: number[] };
	tokenUsage: { api: number[]; local: number[] };
	gpuHours: number[];
}

/**
 * Generate daily time-series data for charts within a report's period.
 * Buckets raw data (routing decisions, tasks) into per-day aggregates.
 */
export async function generateTimeSeries(periodStart: Date, periodEnd: Date): Promise<TimeSeriesData> {
	const dayMs = 86400_000;
	const days: { date: string; label: string }[] = [];
	for (let t = periodStart.getTime(); t < periodEnd.getTime(); t += dayMs) {
		const d = new Date(t);
		days.push({
			date: d.toISOString().slice(0, 10),
			label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
		});
	}

	if (days.length > 90) days.length = 90;

	const labels = days.map((d) => d.label);
	const taskCreated = new Array(days.length).fill(0) as number[];
	const taskCompleted = new Array(days.length).fill(0) as number[];
	const routingTotal = new Array(days.length).fill(0) as number[];
	const routingSuccess = new Array(days.length).fill(0) as number[];
	const tokenApi = new Array(days.length).fill(0) as number[];
	const tokenLocal = new Array(days.length).fill(0) as number[];
	const gpuHrs = new Array(days.length).fill(0) as number[];

	const dayIndex = new Map<string, number>();
	days.forEach((d, i) => dayIndex.set(d.date, i));

	// Routing decisions
	const decisions = await getRecentDecisions(500);
	for (const d of decisions) {
		const dateStr = d.timestamp.slice(0, 10);
		const idx = dayIndex.get(dateStr);
		if (idx === undefined) continue;

		routingTotal[idx]++;
		if (d.success) routingSuccess[idx]++;

		if (d.provider === 'claude' || d.provider === 'claude-code') {
			tokenApi[idx] += 1500;
		} else if (d.provider === 'ollama' || d.provider === 'internal') {
			tokenLocal[idx] += 800;
		}

		if (d.provider === 'ollama' || d.provider === 'internal') {
			gpuHrs[idx] += (d.latencyMs * 2) / 3_600_000;
		}
	}

	// Real agent token data from usage log
	const usagePath = resolve(PATHS.root, '.playground/agent-usage.json');
	try {
		const raw = await readFile(usagePath, 'utf-8');
		const usageEntries = JSON.parse(raw);
		for (const e of usageEntries) {
			const dateStr = (e.timestamp ?? '').slice(0, 10);
			const idx = dayIndex.get(dateStr);
			if (idx === undefined) continue;
			tokenApi[idx] += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
		}
	} catch { /* no usage log */ }

	// Tasks
	const registry = await readJson<{ projects: { id: string; name: string; path: string }[] }>(PATHS.playgroundRegistry);
	const projectEntries = registry?.projects ?? [];
	const seenPaths = new Set<string>();

	for (const project of projectEntries) {
		const fullPath = project.path === '.' ? PATHS.root : resolve(PATHS.root, project.path);
		seenPaths.add(fullPath);
		await migrateIfNeeded(fullPath);
		const tasks = await getAllTasks(fullPath);
		for (const task of tasks) {
			const createdIdx = dayIndex.get(task.createdAt.slice(0, 10));
			if (createdIdx !== undefined) taskCreated[createdIdx]++;

			if (task.completedAt) {
				const completedIdx = dayIndex.get(task.completedAt.slice(0, 10));
				if (completedIdx !== undefined) taskCompleted[completedIdx]++;
			}
		}
	}

	if (!seenPaths.has(PATHS.root)) {
		await migrateIfNeeded(PATHS.root);
		const rootTasks = await getAllTasks(PATHS.root);
		for (const task of rootTasks) {
			const createdIdx = dayIndex.get(task.createdAt.slice(0, 10));
			if (createdIdx !== undefined) taskCreated[createdIdx]++;

			if (task.completedAt) {
				const completedIdx = dayIndex.get(task.completedAt.slice(0, 10));
				if (completedIdx !== undefined) taskCompleted[completedIdx]++;
			}
		}
	}

	return {
		labels,
		taskCompletion: { created: taskCreated, completed: taskCompleted },
		routingDecisions: { total: routingTotal, success: routingSuccess },
		tokenUsage: { api: tokenApi, local: tokenLocal },
		gpuHours: gpuHrs
	};
}

// ── System Events Collection ──────────────────────────────────────────

async function collectSystemEvents(periodStart: Date, periodEnd: Date): Promise<SystemEventsSection> {
	const analytics = await getAgentAnalytics();
	const events = analytics.events.filter((e) => {
		const ts = new Date(e.timestamp);
		return ts >= periodStart && ts < periodEnd;
	});

	const section: SystemEventsSection = {
		review: { spawned: 0, completed: 0, findings: 0, escalated: 0 },
		dependencies: { created: 0, resolved: 0, blocked: 0 },
		pm: { spawned: 0, syncs: 0, reviews: 0, chats: 0 },
		memory: { consolidations: 0, pruned: 0 },
		releases: { prepared: 0, published: 0, changelogs: 0 },
		settings: { saved: 0, routingChanged: 0 },
		githubSync: { pulls: 0, pushes: 0, failures: 0 },
		dependencyHealth: { audits: 0, vulnerabilities: 0 },
		coverage: { collected: 0, regressions: 0 },
		services: { started: 0, restarts: 0, restartFailures: 0 },
	};

	for (const e of events) {
		switch (e.type) {
			case 'review_spawned': section.review.spawned++; break;
			case 'review_completed': section.review.completed++; break;
			case 'review_findings': section.review.findings++; break;
			case 'review_escalated': section.review.escalated++; break;

			case 'task_dependency_created': section.dependencies.created++; break;
			case 'task_dependency_resolved': section.dependencies.resolved++; break;
			case 'task_blocked': section.dependencies.blocked++; break;

			case 'pm_spawned': section.pm.spawned++; break;
			case 'pm_sync_completed': section.pm.syncs++; break;
			case 'pm_reviewed': section.pm.reviews++; break;
			case 'pm_chat': section.pm.chats++; break;

			case 'memory_consolidation_started':
			case 'memory_consolidation_completed':
				section.memory.consolidations++; break;
			case 'memory_entries_pruned': section.memory.pruned++; break;

			case 'release_prepared': section.releases.prepared++; break;
			case 'release_published': section.releases.published++; break;
			case 'changelog_generated': section.releases.changelogs++; break;

			case 'settings_saved': section.settings.saved++; break;
			case 'model_routing_changed': section.settings.routingChanged++; break;

			case 'github_sync_pull': section.githubSync.pulls++; break;
			case 'github_sync_push': section.githubSync.pushes++; break;
			case 'github_sync_failed': section.githubSync.failures++; break;

			case 'dependency_audit_started':
			case 'dependency_audit_completed':
				section.dependencyHealth.audits++; break;
			case 'vulnerability_found': section.dependencyHealth.vulnerabilities++; break;

			case 'coverage_collected': section.coverage.collected++; break;
			case 'coverage_regression_detected': section.coverage.regressions++; break;

			case 'service_started': section.services.started++; break;
			case 'auto_restart_triggered': section.services.restarts++; break;
			case 'auto_restart_result':
				if (e.success === false) section.services.restartFailures++;
				break;
		}
	}

	return section;
}

// ── Report Generation ─────────────────────────────────────────────────

export async function generateReport(type: ReportType, opts?: { source?: string }): Promise<Report> {
	const now = new Date();
	let periodStart: Date;
	let periodEnd: Date;
	let periodLabel: string;

	if (type === 'daily') {
		periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		periodEnd = new Date(periodStart.getTime() + 86400_000);
		periodLabel = periodStart.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
	} else if (type === 'weekly') {
		periodEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
		periodStart = new Date(periodEnd.getTime() - 7 * 86400_000);
		const startLabel = periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		const endLabel = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
		periodLabel = `Week of ${startLabel} - ${endLabel}`;
	} else if (type === 'monthly') {
		periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
		periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
		periodLabel = periodStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
	} else if (type === 'quarterly') {
		const quarterStart = Math.floor(now.getMonth() / 3) * 3;
		periodStart = new Date(now.getFullYear(), quarterStart, 1);
		periodEnd = new Date(now.getFullYear(), quarterStart + 3, 1);
		const qNum = Math.floor(quarterStart / 3) + 1;
		periodLabel = `Q${qNum} ${now.getFullYear()}`;
	} else {
		// yearly
		periodStart = new Date(now.getFullYear(), 0, 1);
		periodEnd = new Date(now.getFullYear() + 1, 0, 1);
		periodLabel = `${now.getFullYear()}`;
	}

	// Estimate GPU active hours from routing decisions
	const routingDecisions = await getRecentDecisions(500);
	const periodDecisions = routingDecisions.filter((d) => {
		const ts = new Date(d.timestamp);
		return ts >= periodStart && ts < periodEnd;
	});
	// Use actual latency from local model decisions to estimate GPU time
	const localDecisions = periodDecisions.filter((d) => d.provider === 'ollama' || d.provider === 'internal');
	let gpuHoursEstimate: number;
	if (localDecisions.length > 0) {
		// Sum actual recorded latency, then add ~2x overhead for processing between calls
		const totalLatencyMs = localDecisions.reduce((sum, d) => sum + d.latencyMs, 0);
		gpuHoursEstimate = (totalLatencyMs * 2) / 3_600_000;
	} else {
		gpuHoursEstimate = 0;
	}

	const [code, tasks, conversations, routing, services, gpu, tokens, projects, notifications, systemEvents] = await Promise.all([
		collectCodeStats(periodStart, periodEnd),
		collectTaskStats(periodStart, periodEnd),
		collectConversationStats(periodStart, periodEnd),
		collectRoutingStats(periodStart, periodEnd),
		collectServiceStats(),
		collectGpuStats(gpuHoursEstimate),
		collectTokenStats(periodStart, periodEnd),
		collectProjectStats(periodStart, periodEnd),
		collectNotificationStats(periodStart, periodEnd),
		collectSystemEvents(periodStart, periodEnd)
	]);

	// Compute scores via the scoring engine
	const scores = computeScores({ code, routing, tasks, conversations, services, gpu, tokens, notifications });

	// Generate highlights
	const highlights: string[] = [];
	if (tasks.completed > 0) highlights.push(`Completed ${tasks.completed} task${tasks.completed > 1 ? 's' : ''}`);
	if (tasks.created > 0) highlights.push(`Created ${tasks.created} new task${tasks.created > 1 ? 's' : ''}`);
	if (code.totalEdits > 0) highlights.push(`Made ${code.totalEdits} code edit${code.totalEdits > 1 ? 's' : ''} (~${code.totalLinesChanged} lines)`);
	if (conversations.totalSessions > 0) highlights.push(`${conversations.totalSessions} chat session${conversations.totalSessions > 1 ? 's' : ''} (${conversations.totalMessages} messages)`);
	if (routing.totalDecisions > 0) highlights.push(`${routing.totalDecisions} routing decisions at ${(routing.successRate * 100).toFixed(0)}% success rate`);
	if (gpu.estimatedKwh > 0) highlights.push(`GPU used ~${gpu.estimatedKwh.toFixed(2)} kWh ($${gpu.estimatedCostUsd.toFixed(3)})`);
	if (notifications.criticalCount > 0) highlights.push(`${notifications.criticalCount} critical alert${notifications.criticalCount > 1 ? 's' : ''}`);

	// Use the scoring engine's system health as the summary healthScore
	const score = scores.systemHealth.score;

	const report: Report = {
		id: `${type}-${periodStart.toISOString().slice(0, 10)}`,
		type,
		periodStart: periodStart.toISOString(),
		periodEnd: periodEnd.toISOString(),
		generatedAt: now.toISOString(),
		generatedBy: opts?.source ?? 'system',
		sections: {
			summary: { periodLabel, highlights, healthScore: score },
			code,
			routing,
			tasks,
			conversations,
			services,
			gpu,
			tokens,
			projects,
			notifications,
			systemEvents
		},
		scores
	};

	await saveReport(report);
	return report;
}
