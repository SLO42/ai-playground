import { error } from '@sveltejs/kit';
import { SERVICES } from '$lib/server/constants.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ params }) => {
	const service = SERVICES[params.id as keyof typeof SERVICES];
	if (!service) throw error(404, 'Service not found');
	if (!service.logFile) throw error(404, 'No logs available for this service');

	return {
		serviceId: service.id,
		serviceName: service.name
	};
};
