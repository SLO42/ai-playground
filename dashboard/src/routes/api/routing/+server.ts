import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { logRoutingDecision, getRoutingStats, getRecentDecisions, getWorkflowStats } from '$lib/server/routing-telemetry.js';

export const GET: RequestHandler = async ({ url }) => {
	const view = url.searchParams.get('view');

	if (view === 'recent') {
		const limit = Math.min(50, parseInt(url.searchParams.get('limit') ?? '20', 10));
		const decisions = await getRecentDecisions(limit);
		return json({ decisions });
	}

	if (view === 'workflows') {
		const wfStats = await getWorkflowStats();
		return json(wfStats);
	}

	const [stats, wfStats] = await Promise.all([getRoutingStats(), getWorkflowStats()]);
	return json({ ...stats, workflowStats: wfStats });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.model || !body.agent || !body.taskType) {
		return json({ error: 'model, agent, and taskType are required' }, { status: 400 });
	}

	// Also accept "log" action path from /api/routing/log
	const entry = await logRoutingDecision({
		model: body.model as string,
		provider: (body.provider as string) ?? 'unknown',
		agent: body.agent as string,
		taskType: body.taskType as string,
		complexity: typeof body.complexity === 'number' ? body.complexity : 0.5,
		latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : 0,
		success: body.success !== false,
		source: (body.source as string) ?? 'unknown',
		reason: body.reason as string | undefined,
		sessionId: body.sessionId as string | undefined
	});

	return json({ entry }, { status: 201 });
};
