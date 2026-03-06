import { notifications } from '$lib/stores/notifications.js';

export interface ApiError {
	status: number;
	statusText: string;
	message: string;
	url: string;
}

export interface ApiFetchOptions extends RequestInit {
	/** Suppress toast notifications on error */
	silent?: boolean;
	/** Timeout in ms (default: none) */
	timeout?: number;
}

/**
 * Centralized fetch wrapper that catches API errors, shows a toast,
 * and logs the failure for debugging.  Drop-in replacement for `fetch`.
 */
export async function apiFetch(
	input: RequestInfo | URL,
	init?: ApiFetchOptions
): Promise<Response> {
	const { silent, timeout, ...fetchInit } = init ?? {};
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

	if (timeout) {
		fetchInit.signal = fetchInit.signal ?? AbortSignal.timeout(timeout);
	}

	let res: Response;
	try {
		res = await fetch(input, fetchInit);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Network error';
		const apiError: ApiError = { status: 0, statusText: 'Network Error', message, url };
		console.error('[apiFetch] Network error:', apiError);
		if (!silent) {
			notifications.push('error', 'Network Error', `Could not reach ${stripOrigin(url)}`);
		}
		throw apiError;
	}

	if (!res.ok) {
		let message = res.statusText;
		try {
			const body = await res.clone().json();
			if (body.error) message = body.error;
			else if (body.message) message = body.message;
		} catch {
			// body wasn't JSON — use statusText
		}

		const apiError: ApiError = { status: res.status, statusText: res.statusText, message, url };
		console.error('[apiFetch] API error:', apiError);

		if (!silent) {
			notifications.push('error', `Error ${res.status}`, message);
		}
	}

	return res;
}

/** GET JSON from an API endpoint. Returns typed data or null on error. */
export async function apiGet<T>(path: string, opts?: ApiFetchOptions): Promise<T | null> {
	try {
		const res = await apiFetch(path, { ...opts, method: 'GET' });
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

/** POST JSON to an API endpoint. Returns typed response data or null on error. */
export async function apiPost<T = unknown>(
	path: string,
	body?: unknown,
	opts?: ApiFetchOptions
): Promise<T | null> {
	try {
		const { method: _skip, ...restOpts } = opts ?? {};
		const res = await apiFetch(path, {
			...restOpts,
			method: opts?.method ?? 'POST',
			headers: { 'Content-Type': 'application/json', ...opts?.headers },
			body: body !== undefined ? JSON.stringify(body) : undefined
		});
		if (!res.ok) return null;
		const text = await res.text();
		return text ? (JSON.parse(text) as T) : (null as T);
	} catch {
		return null;
	}
}

/** PUT JSON to an API endpoint. Returns typed response data or null on error. */
export async function apiPut<T = unknown>(
	path: string,
	body?: unknown,
	opts?: ApiFetchOptions
): Promise<T | null> {
	return apiPost<T>(path, body, { ...opts, method: 'PUT' } as ApiFetchOptions);
}

/** DELETE an API resource. Returns true on success, false on error. */
export async function apiDelete(path: string, opts?: ApiFetchOptions): Promise<boolean> {
	try {
		const res = await apiFetch(path, { ...opts, method: 'DELETE' });
		return res.ok;
	} catch {
		return false;
	}
}

// -- Typed memory API helpers --

import type { MemoryContextResponse } from '$lib/types/memory.js';

/** Fetch typed memory context from /api/memory/context */
export function fetchMemoryContext(opts?: ApiFetchOptions): Promise<MemoryContextResponse | null> {
	return apiGet<MemoryContextResponse>('/api/memory/context', opts);
}

/** Strip origin so toast shows just the path (e.g. "/api/settings") */
function stripOrigin(url: string): string {
	try {
		return new URL(url, 'http://localhost').pathname;
	} catch {
		return url;
	}
}
