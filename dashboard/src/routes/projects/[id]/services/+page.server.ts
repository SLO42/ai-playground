import type { PageServerLoad } from './$types.js';
import { error } from '@sveltejs/kit';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { getFeatureFlags } from '$lib/server/feature-flags.js';
import type { Service } from '$lib/types/services.js';

interface ServiceEntry {
	id: string;
	name: string;
	status: string;
	description: string;
	port: number | null;
	pid: number | null;
	uptime: string | null;
	configFile: string | null;
}

const PAGE_SIZE = 10;

function toServiceEntry(svc: Service): ServiceEntry {
	return {
		id: svc.id,
		name: svc.name,
		status: svc.status,
		description: svc.type,
		port: svc.port,
		pid: svc.pid,
		uptime: svc.uptime,
		configFile: svc.configPath
	};
}

export const load: PageServerLoad = async ({ params, url, fetch: serverFetch }) => {
	const flags = getFeatureFlags();
	if (!flags.previewNewPages) throw error(404, 'Not found');

	try {
		const [projects, apiRes] = await Promise.all([
			scanAllProjects(PATHS.playgroundRegistry, PATHS.root),
			serverFetch(`/api/projects/${encodeURIComponent(params.id)}/services`)
		]);

		const project = projects.find((p) => p.id === params.id);

		if (!apiRes.ok) {
			const body = await apiRes.json().catch(() => ({ error: 'Unknown error' }));
			throw new Error(body.error ?? `API returned ${apiRes.status}`);
		}

		const { services: rawServices } = (await apiRes.json()) as { services: Service[] };
		const services: ServiceEntry[] = rawServices.map(toServiceEntry);

		const configSources = new Set<string>();
		for (const svc of rawServices) {
			if (svc.configPath) configSources.add(svc.configPath);
		}

		const running = services.filter((s) => s.status === 'running').length;
		const stopped = services.filter((s) => s.status !== 'running').length;

		// Filtering
		const statusFilter = url.searchParams.get('status');
		const search = url.searchParams.get('q')?.toLowerCase();
		let filtered = services;
		if (statusFilter && statusFilter !== 'all') {
			filtered = filtered.filter((s) => s.status === statusFilter);
		}
		if (search) {
			filtered = filtered.filter(
				(s) => s.name.toLowerCase().includes(search) || s.description.toLowerCase().includes(search)
			);
		}

		// Sorting
		const sortBy = url.searchParams.get('sort') ?? 'name';
		const sortDir = url.searchParams.get('dir') === 'desc' ? -1 : 1;
		filtered.sort((a, b) => {
			const aVal = (a as Record<string, unknown>)[sortBy] ?? '';
			const bVal = (b as Record<string, unknown>)[sortBy] ?? '';
			if (typeof aVal === 'string' && typeof bVal === 'string') return aVal.localeCompare(bVal) * sortDir;
			if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * sortDir;
			return 0;
		});

		// Pagination
		const total = filtered.length;
		const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
		const pageSize = Math.max(1, Math.min(50, parseInt(url.searchParams.get('pageSize') ?? String(PAGE_SIZE), 10) || PAGE_SIZE));
		const totalPages = Math.max(1, Math.ceil(total / pageSize));
		const safePage = Math.min(page, totalPages);
		const start = (safePage - 1) * pageSize;
		const paginatedServices = filtered.slice(start, start + pageSize);

		return {
			projectName: project?.name ?? params.id,
			error: null as string | null,
			summary: {
				running,
				stopped,
				fromConfig: rawServices.filter((s) => s.configPath).length,
				manual: rawServices.filter((s) => !s.configPath).length,
				configSource: [...configSources]
			},
			services: paginatedServices,
			pagination: {
				page: safePage,
				pageSize,
				total,
				totalPages
			},
			autoStart: [] as any[],
			logs: [] as any[]
		};
	} catch (err) {
		return {
			projectName: params.id,
			error: err instanceof Error ? err.message : 'Failed to load services',
			summary: { running: 0, stopped: 0, fromConfig: 0, manual: 0, configSource: [] as string[] },
			services: [] as ServiceEntry[],
			pagination: { page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1 },
			autoStart: [] as any[],
			logs: [] as any[]
		};
	}
};
