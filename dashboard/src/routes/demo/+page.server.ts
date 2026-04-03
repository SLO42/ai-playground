import type { PageServerLoad } from './$types.js';
import { getAgentAnalytics, type AgentEvent } from '$lib/server/heartbeat/agent-analytics.js';
import { getAllTasks } from '$lib/server/task-store-sql.js';
import { PATHS } from '$lib/server/constants.js';

/** Lifecycle event types in execution order */
const LIFECYCLE_ORDER: string[] = [
	'classified',
	'escalation_check',
	'model_selected',
	'context_gathering',
	'context_gathered',
	'spawned',
	'handoff',
	'completed',
	'committed',
	'test_run',
	'review_spawned',
	'review_findings',
	'review_completed',
	'follow_up_spawned',
	'follow_up_done',
	'failed'
];

export interface LifecycleTask {
	taskId: string;
	taskTitle: string;
	events: AgentEvent[];
	status: 'pending' | 'running' | 'completed' | 'failed';
	route?: string;
	model?: string;
	modelTier?: string;
	provider?: string;
	durationMs?: number;
	costUsd?: number;
	filesChanged?: number;
	commitHash?: string;
	hadReview: boolean;
	hadFollowUp: boolean;
}

export const load: PageServerLoad = async () => {
	const analytics = await getAgentAnalytics();
	const tasks = await getAllTasks(PATHS.root);

	// Group events by taskId, keeping only lifecycle-relevant ones
	const taskEventMap = new Map<string, AgentEvent[]>();
	for (const event of analytics.events) {
		if (!event.taskId || !LIFECYCLE_ORDER.includes(event.type)) continue;
		if (!taskEventMap.has(event.taskId)) taskEventMap.set(event.taskId, []);
		taskEventMap.get(event.taskId)!.push(event);
	}

	// Build lifecycle entries for tasks that have meaningful event chains
	const lifecycleTasks: LifecycleTask[] = [];
	for (const [taskId, events] of taskEventMap) {
		if (events.length < 2) continue; // need at least classify + spawn/complete

		// Sort by lifecycle order, then by timestamp within same type
		events.sort((a, b) => {
			const orderA = LIFECYCLE_ORDER.indexOf(a.type);
			const orderB = LIFECYCLE_ORDER.indexOf(b.type);
			if (orderA !== orderB) return orderA - orderB;
			return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
		});

		const completed = events.find(e => e.type === 'completed');
		const failed = events.find(e => e.type === 'failed');
		const spawned = events.find(e => e.type === 'spawned');
		const classified = events.find(e => e.type === 'classified');
		const committed = events.find(e => e.type === 'committed');

		const dbTask = tasks.find(t => t.id === taskId);
		const title = events[0].taskTitle ?? dbTask?.title ?? taskId;

		lifecycleTasks.push({
			taskId,
			taskTitle: title,
			events,
			status: completed ? 'completed' : failed ? 'failed' : spawned ? 'running' : 'pending',
			route: classified?.route,
			model: (completed ?? spawned)?.model,
			modelTier: (completed ?? spawned)?.modelTier,
			provider: (completed ?? spawned)?.provider,
			durationMs: completed?.durationMs,
			costUsd: completed?.costUsd,
			filesChanged: committed?.commitFiles ?? completed?.filesChanged,
			commitHash: committed?.commitHash,
			hadReview: events.some(e => e.type === 'review_spawned'),
			hadFollowUp: events.some(e => e.type === 'follow_up_spawned')
		});
	}

	// Sort by most recent first (last event timestamp)
	lifecycleTasks.sort((a, b) => {
		const aTime = new Date(a.events[a.events.length - 1].timestamp).getTime();
		const bTime = new Date(b.events[b.events.length - 1].timestamp).getTime();
		return bTime - aTime;
	});

	return {
		lifecycleTasks: lifecycleTasks.slice(0, 50),
		summary: analytics.summary,
		byRoute: analytics.byRoute,
		escalationRate: analytics.escalationRate,
		modelDistribution: analytics.modelDistribution
	};
};
