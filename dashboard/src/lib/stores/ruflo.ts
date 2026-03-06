import { writable, derived } from 'svelte/store';
import { apiGet } from '$lib/api-client.js';
import type { V3Progress, SwarmActivity, Learning } from '$lib/types/metrics.js';

interface RufloState {
	progress: V3Progress | null;
	swarm: SwarmActivity | null;
	learning: Learning | null;
	connected: boolean;
	error: string | null;
}

const POLL_INTERVAL = 10000;

function createRufloStore() {
	let timer: ReturnType<typeof setInterval> | null = null;

	const store = writable<RufloState>({
		progress: null,
		swarm: null,
		learning: null,
		connected: false,
		error: null
	});

	async function poll() {
		const [progress, swarm, learning] = await Promise.all([
			apiGet<V3Progress>('/api/v3/progress', { silent: true, timeout: 5000 }),
			apiGet<SwarmActivity>('/api/v3/swarm', { silent: true, timeout: 5000 }),
			apiGet<Learning>('/api/v3/learning', { silent: true, timeout: 5000 })
		]);

		const anyConnected = progress !== null || swarm !== null || learning !== null;

		store.update((s) => ({
			...s,
			progress: progress ?? s.progress,
			swarm: swarm ?? s.swarm,
			learning: learning ?? s.learning,
			connected: anyConnected,
			error: anyConnected ? null : 'Ruflo metrics unavailable'
		}));
	}

	function start() {
		poll();
		timer = setInterval(poll, POLL_INTERVAL);
	}

	function stop() {
		if (timer) { clearInterval(timer); timer = null; }
	}

	const connected = derived(store, ($s) => $s.connected);
	const activeAgents = derived(store, ($s) => $s.progress?.swarm.activeAgents ?? 0);
	const patternsLearned = derived(store, ($s) => $s.learning?.patterns.shortTerm ?? 0);
	const routingAccuracy = derived(store, ($s) => $s.learning?.routing.accuracy ?? 0);
	const topology = derived(store, ($s) => $s.progress?.swarm.topology ?? 'unknown');

	return {
		subscribe: store.subscribe,
		connected,
		activeAgents,
		patternsLearned,
		routingAccuracy,
		topology,
		start,
		stop
	};
}

export const ruflo = createRufloStore();
