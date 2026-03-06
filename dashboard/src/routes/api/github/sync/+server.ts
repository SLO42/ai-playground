import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { syncTasks, getSyncStatus } from '$lib/server/github-sync.js';
import { pushNotification } from '$lib/server/notifications.js';

export const GET: RequestHandler = async () => {
	const status = await getSyncStatus();
	return json(status);
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const direction = (body.direction as string) ?? 'both';
	if (!['push', 'pull', 'both'].includes(direction)) {
		return json({ error: 'direction must be push, pull, or both' }, { status: 400 });
	}

	const projectId = (body.projectId as string) ?? '.';
	const dryRun = body.dryRun === true;

	const result = await syncTasks({
		projectId,
		direction: direction as 'push' | 'pull' | 'both',
		dryRun,
		source: (body.source as string) ?? undefined
	});

	// Notify on sync completion
	const total = result.created + result.updated + result.pulled;
	if (total > 0 || result.errors.length > 0) {
		const parts = [];
		if (result.created > 0) parts.push(`${result.created} issues created`);
		if (result.updated > 0) parts.push(`${result.updated} updated`);
		if (result.pulled > 0) parts.push(`${result.pulled} imported`);
		if (result.errors.length > 0) parts.push(`${result.errors.length} errors`);

		await pushNotification({
			severity: result.errors.length > 0 ? 'warning' : 'success',
			category: 'task',
			title: 'GitHub Sync Complete',
			message: parts.join(', '),
			source: (body.source as string) ?? 'dashboard',
			link: '/tasks',
			linkLabel: 'View Tasks'
		}).catch(() => {});
	}

	return json(result);
};
