import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getActiveAgents } from '$lib/server/heartbeat/shared.js';

export const GET: RequestHandler = async () => {
	const agents = getActiveAgents();
	const list = Array.from(agents.values()).map(a => ({
		taskId: a.taskId,
		pid: a.pid,
		startedAt: a.startedAt,
		label: a.sender.label,
		color: a.sender.color,
		sessionId: a.reportSessionId,
		logFile: a.logFile.split('/').pop() ?? a.logFile
	}));
	return json({ agents: list, count: list.length });
};
