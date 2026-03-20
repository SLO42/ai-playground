import type { PageServerLoad } from './$types.js';
import { getServices } from '$lib/server/services.js';

export type { Service } from '$lib/server/services.js';

export const load: PageServerLoad = async () => {
	const services = getServices();

	const running = services.filter((s) => s.status === 'running').length;
	const stopped = services.filter((s) => s.status === 'stopped').length;
	const errored = services.filter((s) => s.status === 'errored').length;

	return {
		services,
		stats: { running, stopped, errored, total: services.length }
	};
};
