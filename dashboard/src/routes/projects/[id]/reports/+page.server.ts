import type { PageServerLoad } from './$types.js';
import { getAllTasks } from '$lib/server/task-store-sql.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { PATHS } from '$lib/server/constants.js';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { project } = await parent();

	const [projects, tasks] = await Promise.all([
		scanAllProjects(PATHS.playgroundRegistry, PATHS.root),
		getAllTasks(project.path).catch(() => [])
	]);

	const proj = projects.find((p) => p.id === params.id);

	// Task stats
	const completed = tasks.filter((t) => t.status === 'completed').length;
	const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
	const pending = tasks.filter((t) => t.status === 'pending').length;
	const total = tasks.length;

	// Recent completions (last 10)
	const recentCompleted = tasks
		.filter((t) => t.status === 'completed' && t.updatedAt)
		.sort((a, b) => new Date(b.updatedAt!).getTime() - new Date(a.updatedAt!).getTime())
		.slice(0, 10);

	// Tag distribution
	const tagCounts: Record<string, number> = {};
	for (const task of tasks) {
		for (const tag of task.tags ?? []) {
			tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
		}
	}
	const topTags = Object.entries(tagCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8)
		.map(([tag, count]) => ({ tag, count }));

	// Priority breakdown
	const byPriority: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
	for (const task of tasks) {
		const p = task.priority ?? 'medium';
		byPriority[p] = (byPriority[p] ?? 0) + 1;
	}

	return {
		projectId: params.id,
		stats: { total, completed, inProgress, pending },
		recentCompleted,
		topTags,
		byPriority,
		projectMeta: {
			health: proj?.health ?? project.health,
			commits: proj?.commits ?? project.commits,
			branch: proj?.branch ?? project.branch,
			lastActivity: proj?.lastActivity ?? null
		}
	};
};
