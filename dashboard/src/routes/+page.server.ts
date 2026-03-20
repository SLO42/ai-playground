import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { getRunningModels } from '$lib/server/ollama-client.js';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import type { RankedContext } from '$lib/types/memory.js';
import type { DaemonState, GraphState } from '$lib/types/daemon.js';
import { getAgentAnalytics } from '$lib/server/heartbeat/agent-analytics.js';
import { getPoolStats } from '$lib/server/heartbeat/session-pool.js';
import { getActiveAgents } from '$lib/server/heartbeat/shared.js';
import { isHeartbeatRunning } from '$lib/server/heartbeat.js';
import { getAllTasks } from '$lib/server/task-store-sql.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readFile, readdir } from 'fs/promises';

async function checkHealth(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

interface RecentSession {
	id: string;
	title: string;
	source?: string;
	status?: string;
	updatedAt: string;
}

async function loadRecentSessions(): Promise<RecentSession[]> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/index.json`, 'utf-8');
		const index = JSON.parse(raw) as RecentSession[];
		return index
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
			.slice(0, 8);
	} catch {
		return [];
	}
}

interface Notification {
	id: string;
	severity: string;
	category: string;
	title: string;
	message: string;
	timestamp: string;
	read?: boolean;
}

async function loadRecentNotifications(): Promise<{ items: Notification[]; unread: number }> {
	try {
		const raw = await readFile(`${PATHS.root}/.playground/notifications.json`, 'utf-8');
		const all: Notification[] = JSON.parse(raw);
		const recent = all.slice(-10).reverse();
		const unread = all.filter(n => !n.read).length;
		return { items: recent, unread };
	} catch {
		return { items: [], unread: 0 };
	}
}

export const load: PageServerLoad = async () => {
	const [
		daemonState, graphState, rankedContext, runningModels,
		analytics, poolStats, tasks, recentSessions, notifications,
		...healthResults
	] = await Promise.all([
		readJsonFile<DaemonState>(PATHS.daemonState),
		readJsonFile<GraphState>(PATHS.graphState),
		readJsonFile<RankedContext>(PATHS.rankedContext),
		getRunningModels(),
		getAgentAnalytics(),
		getPoolStats(),
		Promise.resolve(getAllTasks(PATHS.root)).catch(() => []),
		loadRecentSessions(),
		loadRecentNotifications(),
		...Object.values(SERVICES).map((s) =>
			s.healthUrl ? checkHealth(s.healthUrl) : Promise.resolve(false)
		)
	]);

	const topEntries = (rankedContext?.entries ?? [])
		.sort((a, b) => b.pageRank - a.pageRank)
		.slice(0, 5);

	const serviceNames = Object.keys(SERVICES);
	const servicesRunning = healthResults.filter(Boolean).length;

	// Active agents (synchronous)
	const activeAgents = Array.from(getActiveAgents().values()).map(a => ({
		taskId: a.taskId,
		label: a.sender.label,
		color: a.sender.color,
		startedAt: a.startedAt,
		sessionId: a.reportSessionId
	}));

	// Task summary
	const taskSummary = {
		total: tasks.length,
		pending: tasks.filter(t => t.status === 'pending').length,
		inProgress: tasks.filter(t => t.status === 'in_progress').length,
		completed: tasks.filter(t => t.status === 'completed').length,
		failed: tasks.filter(t => t.status === 'cancelled').length
	};

	// Service health map for display
	const serviceHealth = Object.entries(SERVICES).map(([id, svc], i) => ({
		id,
		name: svc.name,
		online: healthResults[i] ?? false
	}));

	// Check if any projects exist for onboarding detection
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root).catch(() => []);

	return {
		hasProjects: projects.length > 0,
		daemonState,
		graphState,
		topEntries,
		runningModels,
		servicesRunning,
		servicesTotal: serviceNames.length,
		analytics,
		poolStats,
		activeAgents,
		taskSummary,
		recentSessions,
		notifications,
		serviceHealth,
		heartbeatEnabled: isHeartbeatRunning()
	};
};
