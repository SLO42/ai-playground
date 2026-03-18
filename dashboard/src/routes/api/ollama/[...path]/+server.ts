import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { APIS } from '$lib/server/constants.js';

/** Allowed Ollama API path segments (whitelist approach to prevent SSRF) */
const ALLOWED_PATHS = new Set(['tags', 'ps', 'show', 'version']);

export const GET: RequestHandler = async ({ params }) => {
	const path = params.path ?? '';

	// Reject null bytes, traversal sequences, and paths not in the whitelist
	if (path.includes('\0') || path.includes('..') || !ALLOWED_PATHS.has(path)) {
		return json({ error: 'Invalid API path' }, { status: 400 });
	}

	try {
		const res = await fetch(`${APIS.ollama}/api/${path}`, {
			signal: AbortSignal.timeout(5000)
		});
		const data = await res.json();
		return json(data);
	} catch {
		return json({ error: 'Ollama unavailable' }, { status: 503 });
	}
};
