/**
 * Heartbeat settings API — enable/disable heartbeat, configure phases and intervals.
 * Data stored at: .playground/heartbeat-config.json (via heartbeat/shared.ts).
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	startHeartbeat, stopHeartbeat, isHeartbeatRunning,
	getHeartbeatConfig, updateHeartbeatConfig,
} from '$lib/server/heartbeat.js';
import type { HeartbeatConfig } from '$lib/server/heartbeat.js';

export const GET: RequestHandler = async () => {
	try {
		const config = getHeartbeatConfig();
		return json({ ...config, enabled: isHeartbeatRunning() });
	} catch (e) {
		console.error('[api/settings/heartbeat] GET failed:', e);
		return json({ error: 'Failed to load heartbeat config' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Partial<HeartbeatConfig>;
	try {
		body = await request.json() as Partial<HeartbeatConfig>;
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	try {
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
	} catch (e) {
		console.error('[api/settings/heartbeat] POST failed:', e);
		return json({ error: 'Failed to update heartbeat config' }, { status: 500 });
	}
};
