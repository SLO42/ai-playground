import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { logRoutingDecision } from '$lib/server/routing-telemetry.js';

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
