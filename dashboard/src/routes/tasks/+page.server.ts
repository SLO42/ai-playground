import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readdir } from 'fs/promises';
import { basename } from 'path';
import type { Task } from '$lib/types/tasks.js';
import { getAllTasks, migrateIfNeeded } from '$lib/server/task-store.js';
import { getSyncStatus } from '$lib/server/github-sync.js';
import { getAgentAnalytics } from '$lib/server/heartbeat/agent-analytics.js';

interface ProjectTask extends Task {
	projectId: string;
	projectName: string;
	githubIssue?: number;
	githubUrl?: string;
}

async function getAgentNames(): Promise<string[]> {
	try {
		const entries = await readdir(PATHS.agentsDir);
		return entries
			.filter((f) => f.endsWith('.md') || f.endsWith('.yaml') || f.endsWith('.yml'))
			.map((f) => basename(f, f.substring(f.lastIndexOf('.'))));
	} catch {
		return [];
	}
}

const PER_PAGE = 20;

export const load: PageServerLoad = async ({ url }) => {
	// Parse pagination & filter params from URL
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('perPage') ?? String(PER_PAGE), 10) || PER_PAGE));
	const filterParam = url.searchParams.get('filter') ?? 'active';
	const projectFilter = url.searchParams.get('project') ?? 'all';
	const searchQuery = url.searchParams.get('q') ?? '';

	const [projects, agentNames, syncStatus, analytics] = await Promise.all([
		scanAllProjects(PATHS.playgroundRegistry, PATHS.root),
		getAgentNames(),
		getSyncStatus(),
		getAgentAnalytics()
	]);

	// Build task→issue lookup from sync mappings
	const issueMap = new Map<string, { number: number; url: string }>();
	for (const mapping of syncStatus.state.mappings) {
		issueMap.set(mapping.taskId, {
			number: mapping.issueNumber,
			url: `https://github.com/${syncStatus.repo}/issues/${mapping.issueNumber}`
		});
	}

	const allTasks: ProjectTask[] = [];

	await Promise.all(
		projects.map(async (project) => {
			try {
				await migrateIfNeeded(project.path);
				const tasks = await getAllTasks(project.path);
				for (const task of tasks) {
					const issue = issueMap.get(task.id);
					allTasks.push({
						...task,
						projectId: project.id,
						projectName: project.name,
						githubIssue: issue?.number,
						githubUrl: issue?.url
					});
				}
			} catch {
				// no tasks
			}
		})
	);

	// Sort: active first, then by updatedAt descending
	allTasks.sort((a, b) => {
		const activeStatuses = ['pending', 'in_progress'];
		const aActive = activeStatuses.includes(a.status) ? 0 : 1;
		const bActive = activeStatuses.includes(b.status) ? 0 : 1;
		if (aActive !== bActive) return aActive - bActive;
		return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
	});

	// Summary is always computed from the full dataset
	const active = allTasks.filter((t) => t.status === 'pending' || t.status === 'in_progress').length;
	const critical = allTasks.filter((t) => t.priority === 'critical' && t.status !== 'completed' && t.status !== 'cancelled').length;
	const high = allTasks.filter((t) => t.priority === 'high' && t.status !== 'completed' && t.status !== 'cancelled').length;
	const flagged = allTasks.filter((t) => t.flagDiscussion && t.status !== 'completed' && t.status !== 'cancelled').length;

	// Apply filters server-side
	let filtered = allTasks;
	if (projectFilter !== 'all') filtered = filtered.filter((t) => t.projectId === projectFilter);
	if (filterParam === 'active') filtered = filtered.filter((t) => t.status === 'pending' || t.status === 'in_progress');
	else if (filterParam === 'completed') filtered = filtered.filter((t) => t.status === 'completed' || t.status === 'cancelled');
	if (searchQuery.trim()) {
		const q = searchQuery.trim().toLowerCase();
		filtered = filtered.filter((t) =>
			t.title.toLowerCase().includes(q) ||
			t.description?.toLowerCase().includes(q) ||
			t.assignee?.toLowerCase().includes(q) ||
			t.tags.some((tag) => tag.toLowerCase().includes(q)) ||
			t.projectName.toLowerCase().includes(q)
		);
	}

	// Paginate
	const totalFiltered = filtered.length;
	const totalPages = Math.max(1, Math.ceil(totalFiltered / perPage));
	const safePage = Math.min(page, totalPages);
	const pagedTasks = filtered.slice((safePage - 1) * perPage, safePage * perPage);

	// Build task analytics: group events by taskId, extract last meaningful event
	const taskAnalytics: Record<string, { lastEvent: string; model?: string; durationMs?: number; status: 'pending' | 'running' | 'completed' | 'failed' }> = {};
	const eventsByTask = new Map<string, typeof analytics.events>();
	for (const evt of analytics.events) {
		if (!evt.taskId) continue;
		const list = eventsByTask.get(evt.taskId) ?? [];
		list.push(evt);
		eventsByTask.set(evt.taskId, list);
	}
	for (const [taskId, events] of eventsByTask) {
		// Sort by timestamp ascending to find the last event
		events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
		const last = events[events.length - 1];
		let status: 'pending' | 'running' | 'completed' | 'failed' = 'pending';
		if (last.type === 'completed') status = 'completed';
		else if (last.type === 'failed') status = 'failed';
		else if (last.type === 'spawned' || last.type === 'context_gathering' || last.type === 'model_selected') status = 'running';

		// Find model from any model_selected or completion event
		const modelEvt = events.find(e => e.model);
		// Find duration from completion/failure event
		const durationEvt = events.find(e => e.durationMs != null);

		taskAnalytics[taskId] = {
			lastEvent: last.type,
			model: modelEvt?.model,
			durationMs: durationEvt?.durationMs ?? undefined,
			status
		};
	}

	// Resolve blocker task titles: build a lookup from all tasks
	const taskTitleMap = new Map<string, string>();
	for (const task of allTasks) {
		taskTitleMap.set(task.id, task.title);
	}
	const blockerNames: Record<string, string[]> = {};
	for (const task of pagedTasks) {
		if (task.blockedBy && task.blockedBy.length > 0) {
			blockerNames[task.id] = task.blockedBy.map(
				blockerId => taskTitleMap.get(blockerId) ?? blockerId
			);
		}
	}

	return {
		tasks: pagedTasks,
		projects: projects.map((p) => ({ id: p.id, name: p.name })),
		agentNames,
		summary: { total: allTasks.length, active, critical, high, flagged },
		pagination: {
			page: safePage,
			perPage,
			totalFiltered,
			totalPages
		},
		filters: {
			filter: filterParam,
			project: projectFilter,
			q: searchQuery
		},
		taskAnalytics,
		blockerNames
	};
};
