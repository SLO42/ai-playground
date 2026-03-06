import type { PageServerLoad } from './$types.js';
import { error } from '@sveltejs/kit';
import { getFeatureFlags } from '$lib/server/feature-flags.js';

const empty = {
	summary: { active: 0, paused: 0, completed: 0, totalTurns: 0 },
	sessions: [] as any[],
	timeline: [] as any[],
	resources: {
		apiTokens: { value: 0, cost: '$0.00' },
		localTokens: { value: 0, cost: '$0.00 (Ollama)' },
		memoryNodes: { value: 0, label: 'none indexed' }
	},
	pagination: { page: 1, perPage: 10, totalSessions: 0, totalPages: 1 },
	error: null as string | null
};

export const load: PageServerLoad = async ({ params, url, fetch }) => {
	const flags = getFeatureFlags();
	if (!flags.previewNewPages) throw error(404, 'Not found');

	const page = url.searchParams.get('page') || '1';
	const perPage = url.searchParams.get('perPage') || '10';

	try {
		const apiUrl = `/api/projects/${encodeURIComponent(params.id)}/sessions?page=${page}&perPage=${perPage}`;
		const res = await fetch(apiUrl);

		if (!res.ok) {
			const body = await res.json().catch(() => ({ error: res.statusText }));
			return { ...empty, error: body.error ?? `Failed to load sessions (${res.status})` };
		}

		const data = await res.json();
		return { ...data, error: null };
	} catch (err) {
		return { ...empty, error: 'Failed to connect to sessions API' };
	}
};
