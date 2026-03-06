import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { startHeartbeat, stopHeartbeat, isHeartbeatRunning } from '$lib/server/heartbeat.js';

export const GET: RequestHandler = async () => {
	return json({ enabled: isHeartbeatRunning() });
};

export const POST: RequestHandler = async ({ request }) => {
	const { enabled } = await request.json() as { enabled: boolean };

	if (enabled) {
		startHeartbeat();
	} else {
		stopHeartbeat();
	}

	return json({ enabled: isHeartbeatRunning() });
};
