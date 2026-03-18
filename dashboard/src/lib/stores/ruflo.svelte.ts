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

let timer: ReturnType<typeof setInterval> | null = null;

let state = $state<RufloState>({
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

	state.progress = progress ?? state.progress;
	state.swarm = swarm ?? state.swarm;
	state.learning = learning ?? state.learning;
	state.connected = anyConnected;
	state.error = anyConnected ? null : 'Ruflo metrics unavailable';
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

const connected = $derived(state.connected);
const activeAgents = $derived(state.progress?.swarm.activeAgents ?? 0);
const patternsLearned = $derived(state.learning?.patterns.shortTerm ?? 0);
const routingAccuracy = $derived(state.learning?.routing.accuracy ?? 0);
const topology = $derived(state.progress?.swarm.topology ?? 'unknown');

export const ruflo = {
	get state() { return state; },
	get connected() { return connected; },
	get activeAgents() { return activeAgents; },
	get patternsLearned() { return patternsLearned; },
	get routingAccuracy() { return routingAccuracy; },
	get topology() { return topology; },
	start,
	stop
};
