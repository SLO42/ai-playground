import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getPoolStats, populateFromConfig, populateFromProjects, resetPool, removeSlot } from '$lib/server/heartbeat/session-pool.js';
import { loadProjectMaxAgents } from '$lib/server/heartbeat/shared.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { PATHS } from '$lib/server/constants.js';

export const GET: RequestHandler = async () => {
	const pool = await getPoolStats();
	return json(pool);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json() as { action: string; slotId?: string };

	switch (body.action) {
		case 'populate': {
			try {
				// Project-aware: iterate all projects, respect per-project limits
				const result = await populateFromProjects(
					() => scanAllProjects(PATHS.playgroundRegistry, PATHS.root).then(ps => ps.map(p => ({ id: p.id, path: p.path }))),
					loadProjectMaxAgents
				);
				const pool = await getPoolStats();
				return json({ success: true, ...result, pool });
			} catch (e) {
				return json({ error: e instanceof Error ? e.message : 'Failed to populate pool' }, { status: 500 });
			}
		}
		case 'populate-config': {
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
