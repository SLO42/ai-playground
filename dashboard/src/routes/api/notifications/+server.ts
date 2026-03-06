import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	getNotifications,
	pushNotification,
	markRead,
	markAllRead,
	dismissNotification,
	getStats,
	type NotifCategory,
	type NotifSeverity
} from '$lib/server/notifications.js';

export const GET: RequestHandler = async ({ url }) => {
	const category = url.searchParams.get('category') as NotifCategory | null;
	const unreadOnly = url.searchParams.get('unread') === 'true';
	const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
	const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

	const [result, stats] = await Promise.all([
		getNotifications({
			category: category ?? undefined,
			unreadOnly,
			limit: Math.min(limit, 200),
			offset: Math.max(offset, 0)
		}),
		getStats()
	]);

	return json({
		notifications: result.items,
		total: result.total,
		stats
	});
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const action = body.action as string;

	if (action === 'mark_read') {
		const id = body.id as string;
		if (!id) return json({ error: 'id required' }, { status: 400 });
		const ok = await markRead(id);
		return json({ ok });
	}

	if (action === 'mark_all_read') {
		const count = await markAllRead();
		return json({ ok: true, count });
	}

	if (action === 'dismiss') {
		const id = body.id as string;
		if (!id) return json({ error: 'id required' }, { status: 400 });
		const ok = await dismissNotification(id);
		return json({ ok });
	}

	// Default: push a new notification
	const validSeverities: NotifSeverity[] = ['critical', 'warning', 'info', 'success'];
	const validCategories: NotifCategory[] = ['task', 'service', 'agent', 'chat', 'memory', 'model', 'system'];

	const severity = validSeverities.includes(body.severity as NotifSeverity)
		? (body.severity as NotifSeverity)
		: 'info';
	const category = validCategories.includes(body.category as NotifCategory)
		? (body.category as NotifCategory)
		: 'system';

	if (!body.title || typeof body.title !== 'string') {
		return json({ error: 'title is required' }, { status: 400 });
	}

	const notif = await pushNotification({
		severity,
		category,
		title: body.title as string,
		message: (body.message as string) ?? '',
		source: (body.source as string) ?? undefined,
		link: (body.link as string) ?? undefined,
		linkLabel: (body.linkLabel as string) ?? undefined,
		desktop: body.desktop !== false
	});

	return json({ notification: notif }, { status: 201 });
};
