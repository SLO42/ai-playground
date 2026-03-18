import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getCoverageTrend } from '$lib/server/coverage-tracker.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const projectId = params.id;
	const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);

	const trend = await getCoverageTrend(projectId, Math.min(limit, 200));

	return json({
		projectId,
		reports: trend,
		total: trend.length,
		latest: trend[0] ?? null
	});
};
