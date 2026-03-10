/**
 * ComfyUI REST API client — submit workflows, poll results, manage models.
 *
 * ComfyUI exposes:
 *   POST /prompt          — queue a workflow
 *   GET  /history/{id}    — check completion + get output filenames
 *   GET  /view?filename=  — fetch rendered image
 *   GET  /object_info     — list all node types + their options (models, samplers, etc.)
 *   GET  /system_stats    — health + VRAM usage
 *   POST /interrupt       — cancel current generation
 */
import { APIS } from './constants.js';

const BASE = APIS.comfyui;
const TIMEOUT = 10_000;

// ── Low-level fetch ─────────────────────────────────────────────────

async function comfyFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
	try {
		const res = await fetch(`${BASE}${path}`, {
			signal: AbortSignal.timeout(TIMEOUT),
			...init
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

// ── Health ──────────────────────────────────────────────────────────

export interface ComfySystemStats {
	system: {
		os: string;
		python_version: string;
		embedded_python: boolean;
	};
	devices: {
		name: string;
		type: string;
		index: number;
		vram_total: number;
		vram_free: number;
		torch_vram_total: number;
		torch_vram_free: number;
	}[];
}

export async function isComfyOnline(): Promise<boolean> {
	const stats = await comfyFetch<ComfySystemStats>('/system_stats');
	return stats !== null;
}

export async function getSystemStats(): Promise<ComfySystemStats | null> {
	return comfyFetch<ComfySystemStats>('/system_stats');
}

// ── Model / LoRA / Sampler discovery ────────────────────────────────

interface ObjectInfoNode {
	input: {
		required?: Record<string, [string[] | string, Record<string, unknown>?]>;
		optional?: Record<string, [string[] | string, Record<string, unknown>?]>;
	};
}

// Cache object_info — it's large and doesn't change unless ComfyUI restarts
let _objectInfoCache: Record<string, ObjectInfoNode> | null = null;
let _objectInfoExpiry = 0;

async function getObjectInfo(): Promise<Record<string, ObjectInfoNode>> {
	if (_objectInfoCache && Date.now() < _objectInfoExpiry) return _objectInfoCache;
	const info = await comfyFetch<Record<string, ObjectInfoNode>>('/object_info');
	if (info) {
		_objectInfoCache = info;
		_objectInfoExpiry = Date.now() + 5 * 60_000; // 5 min cache
	}
	return info ?? {};
}

/** List available checkpoint model filenames. */
export async function listCheckpoints(): Promise<string[]> {
	const info = await getObjectInfo();
	const node = info['CheckpointLoaderSimple'];
	if (!node) return [];
	const input = node.input.required?.['ckpt_name'];
	return Array.isArray(input?.[0]) ? input[0] : [];
}

/** List available LoRA filenames. */
export async function listLoras(): Promise<string[]> {
	const info = await getObjectInfo();
	const node = info['LoraLoader'];
	if (!node) return [];
	const input = node.input.required?.['lora_name'];
	return Array.isArray(input?.[0]) ? input[0] : [];
}

/** List available VAE filenames. */
export async function listVaes(): Promise<string[]> {
	const info = await getObjectInfo();
	const node = info['VAELoader'];
	if (!node) return [];
	const input = node.input.required?.['vae_name'];
	return Array.isArray(input?.[0]) ? input[0] : [];
}

/** List available sampler names. */
export async function listSamplers(): Promise<string[]> {
	const info = await getObjectInfo();
	const node = info['KSampler'];
	if (!node) return [];
	const input = node.input.required?.['sampler_name'];
	return Array.isArray(input?.[0]) ? input[0] : [];
}

/** List available scheduler names. */
export async function listSchedulers(): Promise<string[]> {
	const info = await getObjectInfo();
	const node = info['KSampler'];
	if (!node) return [];
	const input = node.input.required?.['scheduler'];
	return Array.isArray(input?.[0]) ? input[0] : [];
}

/** List available upscaler model filenames. */
export async function listUpscalers(): Promise<string[]> {
	const info = await getObjectInfo();
	const node = info['UpscaleModelLoader'];
	if (!node) return [];
	const input = node.input.required?.['model_name'];
	return Array.isArray(input?.[0]) ? input[0] : [];
}

/** Invalidate cached object info (call after installing new models). */
export function invalidateModelCache(): void {
	_objectInfoCache = null;
	_objectInfoExpiry = 0;
}

// ── Workflow submission ─────────────────────────────────────────────

export interface QueueResult {
	prompt_id: string;
	number: number;
	node_errors: Record<string, unknown>;
}

/** Submit a ComfyUI workflow (prompt) for execution. */
export async function queuePrompt(workflow: Record<string, unknown>): Promise<QueueResult | null> {
	return comfyFetch<QueueResult>('/prompt', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ prompt: workflow })
	});
}

// ── Result polling ──────────────────────────────────────────────────

export interface HistoryOutput {
	images?: { filename: string; subfolder: string; type: string }[];
}

export interface HistoryEntry {
	prompt: [number, string, Record<string, unknown>, unknown, unknown];
	outputs: Record<string, HistoryOutput>;
	status: { status_str: string; completed: boolean };
}

/** Check if a prompt has completed. Returns the history entry or null if still running. */
export async function getHistory(promptId: string): Promise<HistoryEntry | null> {
	const data = await comfyFetch<Record<string, HistoryEntry>>(`/history/${promptId}`);
	if (!data) return null;
	return data[promptId] ?? null;
}

/** Poll until a prompt completes or timeout. Returns output images. */
export async function waitForCompletion(
	promptId: string,
	timeoutMs = 300_000, // 5 min default
	pollIntervalMs = 2_000
): Promise<{ filename: string; subfolder: string; type: string }[]> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const entry = await getHistory(promptId);
		if (entry?.status?.completed) {
			const images: { filename: string; subfolder: string; type: string }[] = [];
			for (const output of Object.values(entry.outputs)) {
				if (output.images) images.push(...output.images);
			}
			return images;
		}
		await new Promise(r => setTimeout(r, pollIntervalMs));
	}

	throw new Error(`ComfyUI prompt ${promptId} timed out after ${timeoutMs}ms`);
}

// ── Image fetching ──────────────────────────────────────────────────

/** Get the URL for a rendered image (for proxying or direct fetch). */
export function imageUrl(filename: string, subfolder = '', type = 'output'): string {
	const params = new URLSearchParams({ filename, subfolder, type });
	return `${BASE}/view?${params}`;
}

/** Fetch a rendered image as a Buffer. */
export async function fetchImage(filename: string, subfolder = '', type = 'output'): Promise<Buffer | null> {
	try {
		const res = await fetch(imageUrl(filename, subfolder, type), {
			signal: AbortSignal.timeout(30_000)
		});
		if (!res.ok) return null;
		return Buffer.from(await res.arrayBuffer());
	} catch {
		return null;
	}
}

// ── Queue management ────────────────────────────────────────────────

/** Interrupt the currently running generation. */
export async function interrupt(): Promise<boolean> {
	try {
		const res = await fetch(`${BASE}/interrupt`, {
			method: 'POST',
			signal: AbortSignal.timeout(5_000)
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Get current queue status. */
export async function getQueue(): Promise<{ running: number; pending: number } | null> {
	const data = await comfyFetch<{ queue_running: unknown[]; queue_pending: unknown[] }>('/queue');
	if (!data) return null;
	return {
		running: data.queue_running?.length ?? 0,
		pending: data.queue_pending?.length ?? 0
	};
}
