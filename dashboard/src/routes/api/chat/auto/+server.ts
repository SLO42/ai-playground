import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { startAutoSession, injectMessage, pauseSession, resumeSession, getSessionStatus } from '$lib/server/session-manager.js';

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const action = body.action as string | undefined;

	// Control actions on existing sessions
	if (action === 'inject') {
		const sessionId = body.sessionId as string;
		const message = body.message as string;
		if (!sessionId || !message) {
			return json({ error: 'sessionId and message required' }, { status: 400 });
		}
		const ok = await injectMessage(sessionId, message);
		return json({ ok });
	}

	if (action === 'pause') {
		const sessionId = body.sessionId as string;
		if (!sessionId) return json({ error: 'sessionId required' }, { status: 400 });
		const ok = await pauseSession(sessionId);
		return json({ ok });
	}

	if (action === 'resume') {
		const sessionId = body.sessionId as string;
		if (!sessionId) return json({ error: 'sessionId required' }, { status: 400 });
		const ok = await resumeSession(sessionId);
		return json({ ok });
	}

	if (action === 'status') {
		const sessionId = body.sessionId as string;
		if (!sessionId) return json({ error: 'sessionId required' }, { status: 400 });
		return json({ status: getSessionStatus(sessionId) });
	}

	// Default: start a new auto session
	const model = (body.model as string) ?? 'gpt-oss:20b';
	const provider = (body.provider as string) ?? 'ollama';
	const systemPrompt = body.systemPrompt as string | undefined;
	const userMessage = body.userMessage as string ?? body.message as string;
	const source = body.source as string | undefined;

	if (!userMessage) {
		return json({ error: 'userMessage is required' }, { status: 400 });
	}

	const sessionId = await startAutoSession({
		model,
		provider,
		systemPrompt,
		userMessage,
		source
	});

	return json({ sessionId, status: 'streaming' }, { status: 201 });
};
