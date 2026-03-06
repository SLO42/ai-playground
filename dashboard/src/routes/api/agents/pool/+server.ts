import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getPoolStats, populateFromConfig, resetPool, removeSlot } from '$lib/server/heartbeat/session-pool.js';

export const GET: RequestHandler = async () => {
	const pool = await getPoolStats();
	return json(pool);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json() as { action: string; slotId?: string };

	switch (body.action) {
		case 'populate': {
			try {
				const result = await populateFromConfig();
				const pool = await getPoolStats();
				return json({ success: true, ...result, pool });
			} catch (e) {
				return json({ error: e instanceof Error ? e.message : 'Failed to populate pool' }, { status: 500 });
			}
		}
		case 'reset': {
			await resetPool();
			const pool = await getPoolStats();
			return json({ success: true, pool });
		}
		case 'remove': {
			if (!body.slotId) return json({ error: 'slotId required' }, { status: 400 });
			const removed = await removeSlot(body.slotId);
			if (!removed) return json({ error: 'Slot not found' }, { status: 404 });
			const pool = await getPoolStats();
			return json({ success: true, pool });
		}
		default:
			return json({ error: `Unknown action: ${body.action}` }, { status: 400 });
	}
};
