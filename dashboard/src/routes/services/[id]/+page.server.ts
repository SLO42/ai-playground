import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getServiceById } from '$lib/server/services.js';

export const load: PageServerLoad = async ({ params }) => {
	const service = getServiceById(params.id);

	if (!service) {
		error(404, `Service "${params.id}" not found`);
	}

	return { service };
};
