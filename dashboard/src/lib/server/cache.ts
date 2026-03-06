/**
 * Simple LRU cache with TTL support for server-side data.
 * Used to reduce filesystem/database reads for frequently accessed data.
 */

interface CacheEntry<T> {
	value: T;
	expires: number;
}

class LRUCache<T> {
	private cache = new Map<string, CacheEntry<T>>();
	private readonly maxSize: number;
	private readonly ttlMs: number;

	constructor(maxSize: number, ttlMs: number) {
		this.maxSize = maxSize;
		this.ttlMs = ttlMs;
	}

	get(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expires) {
			this.cache.delete(key);
			return undefined;
		}
		// Move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.value;
	}

	set(key: string, value: T): void {
		this.cache.delete(key);
		if (this.cache.size >= this.maxSize) {
			// Evict oldest (first) entry
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.set(key, { value, expires: Date.now() + this.ttlMs });
	}

	invalidate(key: string): void {
		this.cache.delete(key);
	}

	invalidateAll(): void {
		this.cache.clear();
	}

	has(key: string): boolean {
		return this.get(key) !== undefined;
	}

	/** Returns the remaining TTL in seconds for a cached key, or 0 if missing/expired. */
	getRemainingTtl(key: string): number {
		const entry = this.cache.get(key);
		if (!entry) return 0;
		const remaining = entry.expires - Date.now();
		return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
	}
}

/** Graph state cache — 30s TTL, max 16 entries */
export const graphCache = new LRUCache<unknown>(16, 30_000);

/** Project memory cache — 30s TTL, max 32 entries */
export const projectMemoryCache = new LRUCache<unknown>(32, 30_000);

/** Invalidate all memory-related caches (call on memory writes) */
export function invalidateMemoryCaches(): void {
	graphCache.invalidateAll();
	projectMemoryCache.invalidateAll();
}
