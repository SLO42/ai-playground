import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { APIS } from '$lib/server/constants.js';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const res = await fetch(`${APIS.ollama}/api/${params.path}`, {
			signal: AbortSignal.timeout(5000)
		});
		const data = await res.json();
		return json(data);
	} catch {
		return json({ error: 'Ollama unavailable' }, { status: 503 });
	}
};
