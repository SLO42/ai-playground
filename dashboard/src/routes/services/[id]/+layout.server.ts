import { error } from '@sveltejs/kit';
import { SERVICES } from '$lib/server/constants.js';
import type { LayoutServerLoad } from './$types.js';

export const load: LayoutServerLoad = async ({ params }) => {
	const service = SERVICES[params.id as keyof typeof SERVICES];
	if (!service) throw error(404, 'Service not found');

	return {
		serviceId: service.id,
		serviceName: service.name,
		serviceType: service.type,
		configPath: service.configPath,
		port: service.port,
		hasLogs: !!service.logFile,
		hasConfig: !!service.configPath
	};
};
