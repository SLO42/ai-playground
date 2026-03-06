import { writable, derived } from 'svelte/store';
import { apiGet } from '$lib/api-client.js';
import type { Service } from '$lib/types/services.js';

interface ServicesState {
	services: Service[];
	timestamp: string | null;
	connected: boolean;
	error: string | null;
}

const POLL_INTERVAL = 10000;

function createServicesStore() {
	let timer: ReturnType<typeof setInterval> | null = null;

	const store = writable<ServicesState>({
		services: [],
		timestamp: null,
		connected: false,
		error: null
	});

	async function poll() {
		const data = await apiGet<{ services: Service[]; timestamp?: string }>('/api/services', {
			silent: true,
			timeout: 8000
		});
		if (data) {
			store.update((s) => ({
				...s,
				services: data.services ?? [],
				timestamp: data.timestamp ?? new Date().toISOString(),
				connected: true,
				error: null
			}));
		} else {
			store.update((s) => ({
				...s,
				connected: false,
				error: 'Services unavailable'
			}));
		}
	}

	function start() {
		poll();
		timer = setInterval(poll, POLL_INTERVAL);
	}

	function stop() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	/** Force an immediate refresh (e.g. after start/stop action) */
	function refresh() {
		poll();
	}

	const services = derived(store, ($s) => $s.services);
	const timestamp = derived(store, ($s) => $s.timestamp);
	const connected = derived(store, ($s) => $s.connected);

	return {
		subscribe: store.subscribe,
		services,
		timestamp,
		connected,
		start,
		stop,
		refresh
	};
}

export const servicesStore = createServicesStore();
