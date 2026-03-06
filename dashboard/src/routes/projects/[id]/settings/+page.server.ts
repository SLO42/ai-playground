import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ params, fetch }) => {
	const res = await fetch(`/api/projects/${params.id}/settings`);
	if (!res.ok) {
		return {
			settings: null,
			error: 'Failed to load project settings'
		};
	}

	const settings = await res.json();
	return { settings, error: null };
};
