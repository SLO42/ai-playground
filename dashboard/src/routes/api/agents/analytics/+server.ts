import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgentAnalytics } from '$lib/server/heartbeat/agent-analytics.js';

export const GET: RequestHandler = async () => {
	const analytics = await getAgentAnalytics();
	return json(analytics);
};
