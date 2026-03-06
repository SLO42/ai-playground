/**
 * In-memory request rate limiter.
 *
 * Designed for drop-in use with SvelteKit RequestHandlers.
 * Uses a sliding-window counter per client IP. The store interface
 * is intentionally simple so it can be swapped for Redis/Valkey in
 * production without changing call sites.
 */

import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

/* ------------------------------------------------------------------ */
/*  Store interface (swap implementation for Redis in production)      */
/* ------------------------------------------------------------------ */

export interface RateLimitStore {
	/** Increment the counter for `key`, returning the new count and TTL reset time. */
	increment(key: string, windowMs: number): { count: number; resetAt: number };
	/** Remove expired entries (called automatically). */
	prune(): void;
}

/* ------------------------------------------------------------------ */
/*  In-memory store                                                   */
/* ------------------------------------------------------------------ */

interface Bucket {
	count: number;
	resetAt: number;
}

class MemoryStore implements RateLimitStore {
	private buckets = new Map<string, Bucket>();
	private pruneTimer: ReturnType<typeof setInterval>;

	constructor() {
		// Prune every 60 s to avoid unbounded memory growth
		this.pruneTimer = setInterval(() => this.prune(), 60_000);
		// Allow the timer to not keep the process alive
		if (this.pruneTimer.unref) this.pruneTimer.unref();
	}

	increment(key: string, windowMs: number): { count: number; resetAt: number } {
		const now = Date.now();
		const existing = this.buckets.get(key);

		if (existing && now < existing.resetAt) {
			existing.count++;
			return { count: existing.count, resetAt: existing.resetAt };
		}

		const bucket: Bucket = { count: 1, resetAt: now + windowMs };
		this.buckets.set(key, bucket);
		return { count: 1, resetAt: bucket.resetAt };
	}

	prune() {
		const now = Date.now();
		for (const [key, bucket] of this.buckets) {
			if (now >= bucket.resetAt) this.buckets.delete(key);
		}
	}
}

/* ------------------------------------------------------------------ */
/*  Rate limiter factory                                              */
/* ------------------------------------------------------------------ */

export interface RateLimitOptions {
	/** Maximum requests per window. Default: 30 */
	max?: number;
	/** Window size in milliseconds. Default: 60 000 (1 min) */
	windowMs?: number;
	/** Optional custom store (defaults to in-memory). */
	store?: RateLimitStore;
	/** Key prefix to namespace different limiters. Default: "rl" */
	prefix?: string;
}

export interface RateLimitResult {
	limited: boolean;
	/** Current request count in this window. */
	current: number;
	/** Max allowed. */
	limit: number;
	/** Remaining requests in window. */
	remaining: number;
	/** Unix ms when the window resets. */
	resetAt: number;
}

const defaultStore = new MemoryStore();

function clientIp(event: RequestEvent): string {
	// SvelteKit populates getClientAddress() from the adapter
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

/**
 * Create a rate-limit checker.
 *
 * Usage in a +server.ts handler:
 * ```ts
 * const limiter = createRateLimiter({ max: 20, windowMs: 60_000 });
 *
 * export const POST: RequestHandler = async (event) => {
 *   const rl = limiter.check(event);
 *   if (rl.limited) return limiter.rejectResponse(rl);
 *   // ... handle request
 * };
 * ```
 */
export function createRateLimiter(opts: RateLimitOptions = {}) {
	const max = opts.max ?? 30;
	const windowMs = opts.windowMs ?? 60_000;
	const store = opts.store ?? defaultStore;
	const prefix = opts.prefix ?? 'rl';

	function check(event: RequestEvent): RateLimitResult {
		const ip = clientIp(event);
		const key = `${prefix}:${ip}`;
		const { count, resetAt } = store.increment(key, windowMs);
		const limited = count > max;
		return {
			limited,
			current: count,
			limit: max,
			remaining: Math.max(0, max - count),
			resetAt
		};
	}

	function headers(result: RateLimitResult): Record<string, string> {
		return {
			'X-RateLimit-Limit': String(result.limit),
			'X-RateLimit-Remaining': String(result.remaining),
			'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000))
		};
	}

	function rejectResponse(result: RateLimitResult): Response {
		const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
		return json(
			{ error: 'Too many requests. Please try again later.' },
			{
				status: 429,
				headers: {
					...headers(result),
					'Retry-After': String(Math.max(1, retryAfter))
				}
			}
		);
	}

	return { check, headers, rejectResponse };
}
