import type { PageServerLoad } from './$types.js';
import { getProjectPoolStats } from '$lib/server/heartbeat/session-pool.js';
import { loadProjectMaxAgents } from '$lib/server/heartbeat/shared.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { PATHS } from '$lib/server/constants.js';

export const load: PageServerLoad = async ({ params, url, fetch }) => {
	const page = url.searchParams.get('page') ?? '1';
	const pageSize = url.searchParams.get('pageSize') ?? '10';

	try {
		// Load project info to get path and per-project maxAgents
		const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
		const project = projects.find(p => p.id === params.id);
		const projectMaxAgents = project
			? await loadProjectMaxAgents(project.path, params.id)
			: 2;

		const [res, projectPool] = await Promise.all([
			fetch(`/api/projects/${encodeURIComponent(params.id)}/agents?page=${page}&pageSize=${pageSize}`),
			getProjectPoolStats(params.id)
		]);

		if (!res.ok) {
			const body = await res.json().catch(() => null);
			return {
				loadError: body?.error ?? `API error (${res.status})`,
				summary: { associated: 0, available: 0, total: 0, types: 0 },
				capacity: { current: 0, max: projectMaxAgents },
				agents: [],
				availableAgents: [],
				poolSlots: projectPool.slots,
				projectMaxAgents,
				pagination: { page: 1, pageSize: parseInt(pageSize, 10) || 10, totalItems: 0, totalPages: 1 }
			};
		}

		const data = await res.json();

		return {
			loadError: null,
			summary: data.summary,
			capacity: { ...data.capacity, max: projectMaxAgents },
			agents: data.agents,
			availableAgents: data.availableAgents,
			poolSlots: projectPool.slots,
			projectMaxAgents,
			pagination: data.pagination
		};
	} catch (e) {
		return {
			loadError: e instanceof Error ? e.message : 'Failed to load agents',
			summary: { associated: 0, available: 0, total: 0, types: 0 },
			capacity: { current: 0, max: 2 },
			agents: [],
			availableAgents: [],
			poolSlots: [],
			projectMaxAgents: 2,
			pagination: { page: 1, pageSize: parseInt(pageSize, 10) || 10, totalItems: 0, totalPages: 1 }
		};
	}
};
