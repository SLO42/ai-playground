import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { listTasks, type TaskIndexEntry } from '$lib/server/task-store-sql.js';
import { PATHS } from '$lib/server/constants.js';

export const GET: RequestHandler = async ({ url }) => {
	const allTasks = listTasks(PATHS.root);

	// Filtering
	const status = url.searchParams.get('status');
	const priority = url.searchParams.get('priority');
	const tag = url.searchParams.get('tag');
	const search = url.searchParams.get('search')?.toLowerCase();

	let tasks: TaskIndexEntry[] = allTasks;

	if (status) {
		tasks = tasks.filter((t) => t.status === status);
	}
	if (priority) {
		tasks = tasks.filter((t) => t.priority === priority);
	}
	if (tag) {
		tasks = tasks.filter((t) => t.tags.includes(tag));
	}
	if (search) {
		tasks = tasks.filter(
			(t) => t.title.toLowerCase().includes(search) || t.tags.some((tg) => tg.toLowerCase().includes(search))
		);
	}

	const total = tasks.length;

	// Pagination
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const perPage = Math.min(100, Math.max(0, parseInt(url.searchParams.get('perPage') ?? '0', 10) || 0));

	let paginatedTasks = tasks;
	let totalPages = 1;

	if (perPage > 0) {
		totalPages = Math.max(1, Math.ceil(total / perPage));
		const safePage = Math.min(page, totalPages);
		const start = (safePage - 1) * perPage;
		paginatedTasks = tasks.slice(start, start + perPage);
	}

	return json({
		tasks: paginatedTasks,
		total,
		page: perPage > 0 ? Math.min(page, totalPages) : 1,
		perPage: perPage > 0 ? perPage : total,
		totalPages
	});
};
