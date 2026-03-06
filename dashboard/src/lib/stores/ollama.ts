import { writable, derived } from 'svelte/store';
import { apiGet } from '$lib/api-client.js';

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
		const data = await apiGet<{ models: OllamaRunningModel[] }>('/api/ollama/ps', {
			silent: true,
			timeout: 5000
		});
		if (data) {
			store.update((s) => ({
				...s,
				runningModels: data.models ?? [],
				connected: true,
				error: null,
				lastPsUpdate: Date.now()
			}));
		} else {
			store.update((s) => ({
				...s,
				connected: false,
				error: 'Ollama unavailable'
			}));
		}
	}

	async function fetchTags() {
		const data = await apiGet<{ models: OllamaModel[] }>('/api/ollama/tags', {
			silent: true,
			timeout: 5000
		});
		if (data) {
			store.update((s) => ({
				...s,
				models: data.models ?? [],
				connected: true,
				error: null,
				lastTagsUpdate: Date.now()
			}));
		} else {
			store.update((s) => ({
				...s,
				error: 'Ollama unavailable'
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
