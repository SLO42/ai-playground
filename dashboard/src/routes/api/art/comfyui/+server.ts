import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import * as comfy from '$lib/server/comfyui-client.js';

/** GET /api/art/comfyui — health, queue, stats */
export const GET: RequestHandler = async ({ url }) => {
	const view = url.searchParams.get('view');

	if (view === 'queue') {
		const queue = await comfy.getQueue();
		return json(queue ?? { running: 0, pending: 0 });
	}

	// Default: system stats + online status
	const [online, stats] = await Promise.all([
		comfy.isComfyOnline(),
		comfy.getSystemStats()
	]);

	return json({ online, stats });
};

/** POST /api/art/comfyui — control operations */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	if (body.action === 'interrupt') {
		const ok = await comfy.interrupt();
		return json({ interrupted: ok });
	}

	if (body.action === 'refresh-models') {
		comfy.invalidateModelCache();
		return json({ refreshed: true });
	}

	return json({ error: 'Unknown action' }, { status: 400 });
};
