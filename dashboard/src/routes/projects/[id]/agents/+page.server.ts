import type { PageServerLoad } from './$types.js';
import { getFeatureFlags } from '$lib/server/feature-flags.js';
import { getProjectPoolStats } from '$lib/server/heartbeat/session-pool.js';

export const load: PageServerLoad = async ({ params, url, fetch }) => {
	const flags = getFeatureFlags();
	if (!flags.previewNewPages) {
		return {
			previewEnabled: false,
			loadError: null,
			summary: { associated: 0, available: 0, total: 0, types: 0 },
			capacity: { current: 0, max: 15 },
			agents: [],
			availableAgents: [],
			recentCompletions: [],
			poolSlots: [],
			pagination: { page: 1, pageSize: 10, totalItems: 0, totalPages: 1 }
		};
	}

	const page = url.searchParams.get('page') ?? '1';
	const pageSize = url.searchParams.get('pageSize') ?? '10';

	try {
		const [res, projectPool] = await Promise.all([
			fetch(`/api/projects/${encodeURIComponent(params.id)}/agents?page=${page}&pageSize=${pageSize}`),
			getProjectPoolStats(params.id)
		]);

		if (!res.ok) {
			const body = await res.json().catch(() => null);
			return {
				previewEnabled: true,
				loadError: body?.error ?? `API error (${res.status})`,
				summary: { associated: 0, available: 0, total: 0, types: 0 },
				capacity: { current: 0, max: 15 },
				agents: [],
				availableAgents: [],
				recentCompletions: [],
				poolSlots: projectPool.slots,
				pagination: { page: 1, pageSize: parseInt(pageSize, 10) || 10, totalItems: 0, totalPages: 1 }
			};
		}

		const data = await res.json();

		return {
			previewEnabled: true,
			loadError: null,
			summary: data.summary,
			capacity: data.capacity,
			agents: data.agents,
			availableAgents: data.availableAgents,
			recentCompletions: [],
			poolSlots: projectPool.slots,
			pagination: data.pagination
		};
	} catch (e) {
		return {
			previewEnabled: true,
			loadError: e instanceof Error ? e.message : 'Failed to load agents',
			summary: { associated: 0, available: 0, total: 0, types: 0 },
			capacity: { current: 0, max: 15 },
			agents: [],
			availableAgents: [],
			recentCompletions: [],
			poolSlots: [],
			pagination: { page: 1, pageSize: parseInt(pageSize, 10) || 10, totalItems: 0, totalPages: 1 }
		};
	}
};
