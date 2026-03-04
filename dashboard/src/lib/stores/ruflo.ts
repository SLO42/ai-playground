import { writable, derived } from 'svelte/store';
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

	async function fetchEndpoint<T>(path: string): Promise<T | null> {
		try {
			const res = await fetch(path, { signal: AbortSignal.timeout(5000) });
			if (!res.ok) return null;
			return await res.json();
		} catch {
			return null;
		}
	}

	async function poll() {
		const [progress, swarm, learning] = await Promise.all([
			fetchEndpoint<V3Progress>('/api/v3/progress'),
			fetchEndpoint<SwarmActivity>('/api/v3/swarm'),
			fetchEndpoint<Learning>('/api/v3/learning')
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
