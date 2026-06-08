// TASK 2.2 — in-process counting semaphore for INTERACTIVE spawn caps
// (ARCHITECTURE §2.2 "(a) Interactive spawns — gated by an in-process semaphore
// living in the long-lived SvelteKit server"; D-004).
//
// This is the INTERACTIVE concurrency mechanism — ONE of the two distinct queues.
// It is a plain in-memory counting semaphore: it lives in the long-lived server
// process and caps how many interactive agents run AT ONCE. It is NOT the background
// `work_item` claim queue (that is workqueue.ts, the other distinct mechanism — an
// interactive spawn never sits in the work_item queue and a background job never
// consumes this semaphore; ARCHITECTURE §2.2).
//
// No busy loop (D-004): waiters park on a Promise and are woken FIFO on release.
// `tryAcquire` is the non-blocking variant the orchestrator's drain uses so a full
// semaphore simply leaves work parked in the claim queue rather than blocking.

/** A held permit. Call {@link Permit.release} exactly once when the work finishes. */
export interface Permit {
	/** Release the permit back to the semaphore, waking the next FIFO waiter. */
	release(): void;
}

/**
 * A fair (FIFO) counting semaphore. Construct with the max number of concurrent
 * permits; `acquire()` resolves when a permit is free (parking, never spinning);
 * `tryAcquire()` returns a permit immediately or `null` if none is free.
 *
 * Releasing is idempotent per Permit handle — a double-release cannot inflate the
 * permit count (a common interactive-cap bug class: a finally-block + a catch both
 * releasing would otherwise over-grant).
 */
export class Semaphore {
	#max: number;
	#inUse = 0;
	/** FIFO queue of waiters; each resolve hands the waiter a fresh Permit. */
	#waiters: Array<(p: Permit) => void> = [];

	constructor(max: number) {
		if (!Number.isInteger(max) || max < 1) {
			throw new Error(`Semaphore max must be a positive integer (got ${String(max)})`);
		}
		this.#max = max;
	}

	/** Permits currently held. */
	get inUse(): number {
		return this.#inUse;
	}

	/** Free permits right now (never negative). */
	get available(): number {
		return this.#max - this.#inUse;
	}

	/** Number of parked waiters. */
	get waiting(): number {
		return this.#waiters.length;
	}

	/** The configured maximum. */
	get max(): number {
		return this.#max;
	}

	/** Mint a release-once Permit that returns a permit to the pool when released. */
	#mint(): Permit {
		this.#inUse++;
		let released = false;
		return {
			release: () => {
				if (released) return; // idempotent — never over-grant
				released = true;
				this.#inUse--;
				// Hand the freed permit straight to the next FIFO waiter, if any.
				const next = this.#waiters.shift();
				if (next) next(this.#mint());
			}
		};
	}

	/** Acquire a permit immediately, or `null` if none is free (non-blocking). */
	tryAcquire(): Permit | null {
		if (this.#inUse < this.#max) return this.#mint();
		return null;
	}

	/** Acquire a permit, parking (FIFO, no spin) until one is free. */
	acquire(): Promise<Permit> {
		const immediate = this.tryAcquire();
		if (immediate) return Promise.resolve(immediate);
		return new Promise<Permit>((resolve) => this.#waiters.push(resolve));
	}
}
