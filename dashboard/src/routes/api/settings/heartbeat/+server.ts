import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	startHeartbeat, stopHeartbeat, isHeartbeatRunning,
	getHeartbeatConfig, updateHeartbeatConfig,
} from '$lib/server/heartbeat.js';
import type { HeartbeatConfig } from '$lib/server/heartbeat.js';

export const GET: RequestHandler = async () => {
	const config = getHeartbeatConfig();
	return json({ ...config, enabled: isHeartbeatRunning() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json() as Partial<HeartbeatConfig>;

	// Handle enabled/disabled toggle (start/stop the heartbeat timer)
	if (typeof body.enabled === 'boolean') {
		if (body.enabled) {
			startHeartbeat();
		} else {
			stopHeartbeat();
		}
	}

	// Persist any config changes (phases, intervals, enabled flag)
	const updated = await updateHeartbeatConfig(body);

	return json({ ...updated, enabled: isHeartbeatRunning() });
};
