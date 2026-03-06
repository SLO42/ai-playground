import type { PageServerLoad } from './$types.js';
import { error } from '@sveltejs/kit';
import { getFeatureFlags } from '$lib/server/feature-flags.js';

const PAGE_SIZE = 10;

export const load: PageServerLoad = async ({ params, url, fetch }) => {
	const flags = getFeatureFlags();
	if (!flags.previewNewPages) throw error(404, 'Not found');

	const res = await fetch(`/api/projects/${encodeURIComponent(params.id)}/hooks`);

	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: 'Failed to load hooks' }));
		return {
			hooks: [],
			total: 0,
			page: 1,
			pageSize: PAGE_SIZE,
			totalPages: 1,
			projectId: params.id,
			error: body.error ?? `Failed to load hooks (${res.status})`
		};
	}

	const data = await res.json();
	const allHooks: { name: string; type: string; description: string; enabled: boolean; command?: string }[] = data.hooks ?? [];
	const total = allHooks.length;

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const pageSize = Math.max(1, Math.min(50, parseInt(url.searchParams.get('pageSize') ?? String(PAGE_SIZE), 10) || PAGE_SIZE));
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const safePage = Math.min(page, totalPages);

	const start = (safePage - 1) * pageSize;
	const paginatedHooks = allHooks.slice(start, start + pageSize);

	return {
		hooks: paginatedHooks,
		total,
		page: safePage,
		pageSize,
		totalPages,
		projectId: params.id
	};
};
