/**
 * POST /api/tasks/suggest — Drop improvement tasks into the suggestion inbox.
 *
 * Any caller (daemon, agents, external scripts) can POST here.
 * The heartbeat processes the inbox each cycle, creating real tasks.
 *
 * Body: { suggestions: [{ title, description?, priority?, tags?, feature?, source }] }
 * Or shorthand: { title, description?, priority?, tags?, feature?, source }
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { suggestTasks, peekSuggestions } from '$lib/server/task-suggestions.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	// Accept single suggestion or array
	let suggestions: Array<{
		title: string;
		description?: string;
		priority?: string;
		tags?: string[];
		feature?: string;
		source?: string;
	}>;

	if (Array.isArray(body.suggestions)) {
		suggestions = body.suggestions;
	} else if (body.title) {
		suggestions = [body];
	} else {
		return json({ error: 'Expected { suggestions: [...] } or { title, ... }' }, { status: 400 });
	}

	// Validate
	const valid = suggestions.filter(s => s.title?.trim());
	if (valid.length === 0) {
		return json({ error: 'No valid suggestions (title required)' }, { status: 400 });
	}

	const count = await suggestTasks(
		valid.map(s => ({
			title: s.title,
			description: s.description,
			priority: s.priority as 'critical' | 'high' | 'medium' | 'low' | undefined,
			tags: s.tags,
			feature: s.feature,
			source: s.source ?? 'api'
		}))
	);

	return json({ success: true, queued: count });
};

export const GET: RequestHandler = async () => {
	const suggestions = await peekSuggestions();
	return json({ count: suggestions.length, suggestions });
};
