import { APIS } from './constants.js';

async function ollamaFetch<T>(path: string): Promise<T | null> {
	try {
		const res = await fetch(`${APIS.ollama}${path}`, {
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

export interface OllamaModel {
	name: string;
	model: string;
	size: number;
	digest: string;
	modified_at: string;
	details: {
		parent_model: string;
		format: string;
		family: string;
		families: string[];
		parameter_size: string;
		quantization_level: string;
	};
}

export interface OllamaRunningModel {
	name: string;
	model: string;
	size: number;
	size_vram: number;
	digest: string;
	expires_at: string;
	details: {
		parent_model: string;
		format: string;
		family: string;
		parameter_size: string;
		quantization_level: string;
	};
}

export async function getModels(): Promise<OllamaModel[]> {
	const data = await ollamaFetch<{ models: OllamaModel[] }>('/api/tags');
	return data?.models ?? [];
}

export async function getRunningModels(): Promise<OllamaRunningModel[]> {
	const data = await ollamaFetch<{ models: OllamaRunningModel[] }>('/api/ps');
	return data?.models ?? [];
}

export async function isOllamaOnline(): Promise<boolean> {
	try {
		const res = await fetch(`${APIS.ollama}/`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}
