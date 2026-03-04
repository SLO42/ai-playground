import { writable, derived } from 'svelte/store';

export interface OllamaModel {
	name: string;
	model: string;
	modified_at: string;
	size: number;
	digest: string;
	details?: {
		parent_model?: string;
		format?: string;
		family?: string;
		families?: string[];
		parameter_size?: string;
		quantization_level?: string;
	};
}

export interface OllamaRunningModel {
	name: string;
	model: string;
	size: number;
	digest: string;
	expires_at: string;
	size_vram: number;
	details?: {
		parent_model?: string;
		format?: string;
		family?: string;
		parameter_size?: string;
		quantization_level?: string;
	};
}

interface OllamaState {
	models: OllamaModel[];
	runningModels: OllamaRunningModel[];
	connected: boolean;
	error: string | null;
	lastPsUpdate: number;
	lastTagsUpdate: number;
}

const PS_INTERVAL = 5000;
const TAGS_INTERVAL = 30000;

function createOllamaStore() {
	let psTimer: ReturnType<typeof setInterval> | null = null;
	let tagsTimer: ReturnType<typeof setInterval> | null = null;

	const store = writable<OllamaState>({
		models: [],
		runningModels: [],
		connected: false,
		error: null,
		lastPsUpdate: 0,
		lastTagsUpdate: 0
	});

	async function fetchPs() {
		try {
			const res = await fetch('/api/ollama/ps', { signal: AbortSignal.timeout(5000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			store.update((s) => ({
				...s,
				runningModels: data.models ?? [],
				connected: true,
				error: null,
				lastPsUpdate: Date.now()
			}));
		} catch (e) {
			store.update((s) => ({
				...s,
				connected: false,
				error: e instanceof Error ? e.message : 'Ollama unavailable'
			}));
		}
	}

	async function fetchTags() {
		try {
			const res = await fetch('/api/ollama/tags', { signal: AbortSignal.timeout(5000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			store.update((s) => ({
				...s,
				models: data.models ?? [],
				connected: true,
				error: null,
				lastTagsUpdate: Date.now()
			}));
		} catch (e) {
			store.update((s) => ({
				...s,
				error: e instanceof Error ? e.message : 'Ollama unavailable'
			}));
		}
	}

	function start() {
		fetchPs();
		fetchTags();
		psTimer = setInterval(fetchPs, PS_INTERVAL);
		tagsTimer = setInterval(fetchTags, TAGS_INTERVAL);
	}

	function stop() {
		if (psTimer) { clearInterval(psTimer); psTimer = null; }
		if (tagsTimer) { clearInterval(tagsTimer); tagsTimer = null; }
	}

	const connected = derived(store, ($s) => $s.connected);
	const models = derived(store, ($s) => $s.models);
	const runningModels = derived(store, ($s) => $s.runningModels);

	const vramUsed = derived(store, ($s) =>
		$s.runningModels.reduce((sum, m) => sum + (m.size_vram ?? 0), 0)
	);

	const vramTotal = writable(24 * 1024 * 1024 * 1024); // 24GB default (RTX 3090)

	return {
		subscribe: store.subscribe,
		connected,
		models,
		runningModels,
		vramUsed,
		vramTotal,
		start,
		stop
	};
}

export const ollama = createOllamaStore();
