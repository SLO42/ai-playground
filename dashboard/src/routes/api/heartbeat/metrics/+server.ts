import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getHeartbeatMetrics } from '$lib/server/heartbeat/heartbeat-metrics.js';

export const GET: RequestHandler = async () => {
	const metrics = await getHeartbeatMetrics();
	return json(metrics);
};
