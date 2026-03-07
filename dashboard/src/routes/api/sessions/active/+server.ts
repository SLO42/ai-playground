import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getActiveAgents, getProjectAgentMap } from '$lib/server/heartbeat/shared.js';
import { getActiveSessions, cancelSession } from '$lib/server/session-manager.js';
import { getPoolStats } from '$lib/server/heartbeat/session-pool.js';

export interface ActiveProcess {
	id: string;
	type: 'agent' | 'chat' | 'pool';
	label: string;
	status: string;
	provider?: string;
	model?: string;
	projectId?: string;
	pid?: number;
	startedAt?: string;
	sessionId?: string;
}

export const GET: RequestHandler = async () => {
	const processes: ActiveProcess[] = [];

	// 1. Heartbeat-spawned agents (Claude Code / OpenClaw processes)
	const agents = getActiveAgents();
	const projectMap = getProjectAgentMap();
	for (const [taskId, agent] of agents) {
		processes.push({
			id: taskId,
			type: 'agent',
			label: agent.sender.label,
			status: 'running',
			provider: 'claude-code',
			projectId: projectMap.get(taskId),
			pid: agent.pid,
			startedAt: agent.startedAt,
			sessionId: agent.reportSessionId
		});
	}

	// 2. Active chat sessions (auto sessions, user chats)
	const chatSessions = getActiveSessions();
	for (const s of chatSessions) {
		// Skip agent report sessions (already listed above)
		const isAgentSession = [...agents.values()].some(a => a.reportSessionId === s.id);
		if (isAgentSession) continue;

		processes.push({
			id: s.id,
			type: 'chat',
			label: s.id.startsWith('claw-') ? 'Claw Session' : `Chat: ${s.id.slice(0, 12)}`,
			status: s.status,
			sessionId: s.id
		});
	}

	// 3. Active pool slots
	const pool = await getPoolStats();
	for (const slot of pool.slots) {
		if (slot.status !== 'active') continue;
		processes.push({
			id: slot.slotId,
			type: 'pool',
			label: `Pool: ${slot.area}`,
			status: 'active',
			model: slot.model,
			projectId: slot.projectId,
			sessionId: slot.sessionId || undefined
		});
	}

	return json({ processes, count: processes.length });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json() as { action: string; id: string; type?: string };

	if (body.action === 'cancel') {
		if (!body.id) return json({ error: 'id required' }, { status: 400 });

		// Try cancelling as agent (kill process)
		const agents = getActiveAgents();
		const agent = agents.get(body.id);
		if (agent && agent.pid) {
			try {
				process.kill(agent.pid, 'SIGTERM');
				return json({ ok: true, cancelled: body.id, type: 'agent' });
			} catch {
				return json({ error: `Failed to kill agent process ${agent.pid}` }, { status: 500 });
			}
		}

		// Try cancelling as chat session
		const cancelled = cancelSession(body.id);
		if (cancelled) {
			return json({ ok: true, cancelled: body.id, type: 'chat' });
		}

		return json({ error: `No active process found with id: ${body.id}` }, { status: 404 });
	}

	return json({ error: `Unknown action: ${body.action}` }, { status: 400 });
};
