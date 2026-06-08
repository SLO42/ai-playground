// server/events — per-client SSE subscription + backpressure (TASK 0.d; ARCH §2.11).
//
// ONE SSE endpoint fans the `events` bus out to dashboard clients. Each connected
// client gets its OWN subscription off the bus, filtered to what its page needs.
// The fan-out applies BACKPRESSURE per client so a slow client never buffers
// unboundedly and never stalls the bus or other clients (§2.11):
//   • high-frequency types (token_usage / metric): LATEST-WINS coalescing, keyed by
//     (type|topic|key) — a slow client gets only the newest value per stream.
//   • everything else: DROP-OLDEST once a per-client cap is exceeded.
// The bus push itself is synchronous and non-blocking (see bus.ts); this queue is
// the only place a slow client's pressure is absorbed, and it is bounded.

import type { BusEvent, EventBus, EventFilter, EventType, Unsubscribe } from './bus';

/** Types that coalesce latest-wins instead of queueing every instance. */
const COALESCE_TYPES: ReadonlySet<EventType> = new Set<EventType>(['token_usage', 'metric']);

/** Per-client SSE options. */
export interface SseClientOptions {
	/** Only events passing this are queued for the client. Default: accept all. */
	filter?: EventFilter;
	/** Max queued events before drop-oldest kicks in (non-coalesced). Default 1000. */
	maxQueue?: number;
}

/** A monotonically increasing SSE id helps clients dedupe on reconnect. */
let nextId = 0;

/**
 * One client's bounded, backpressured view of the bus. Subscribe with {@link from},
 * then drain via the async iterator (the SSE route awaits `for await … of client`).
 * `close()` unsubscribes and ends the iterator.
 */
export class SseClient implements AsyncIterable<string> {
	#queue: BusEvent[] = [];
	/** index into #queue of the live (not-yet-flushed) coalescing slot, per key. */
	#coalesceIdx = new Map<string, number>();
	#maxQueue: number;
	#unsub: Unsubscribe | null = null;
	#closed = false;
	#wake: (() => void) | null = null;

	private constructor(maxQueue: number) {
		this.#maxQueue = maxQueue;
	}

	/** Attach a new client to the bus. Returns the client (an async iterable). */
	static from(bus: EventBus, opts: SseClientOptions = {}): SseClient {
		const client = new SseClient(opts.maxQueue ?? 1000);
		client.#unsub = bus.subscribe((e) => client.#enqueue(e), opts.filter ?? (() => true));
		return client;
	}

	#enqueue(e: BusEvent): void {
		if (this.#closed) return;

		// Latest-wins coalescing for high-frequency types: replace the queued event
		// that shares this stream key rather than appending a new one.
		if (COALESCE_TYPES.has(e.type)) {
			const ck = coalesceKey(e);
			const at = this.#coalesceIdx.get(ck);
			if (at !== undefined && this.#queue[at] !== undefined) {
				this.#queue[at] = e; // newest value supersedes the stale one (latest-wins)
				this.#wake?.();
				return;
			}
			this.#coalesceIdx.set(ck, this.#queue.length);
		}

		this.#queue.push(e);

		// Drop-oldest once the bound is exceeded (pure overflow protection). Dropping
		// from the front keeps the newest state; stale coalesce indices are rebuilt
		// lazily (a missing index just means the next same-key event appends fresh).
		if (this.#queue.length > this.#maxQueue) {
			this.#queue.shift();
			this.#reindexCoalesce();
		}
		this.#wake?.();
	}

	#reindexCoalesce(): void {
		this.#coalesceIdx.clear();
		for (let i = 0; i < this.#queue.length; i++) {
			const e = this.#queue[i];
			if (COALESCE_TYPES.has(e.type)) this.#coalesceIdx.set(coalesceKey(e), i);
		}
	}

	/** Unsubscribe from the bus and end the iterator. Idempotent. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsub?.();
		this.#unsub = null;
		this.#wake?.();
	}

	/** Number of events currently queued (tests/diagnostics). */
	get queued(): number {
		return this.#queue.length;
	}

	/**
	 * Drain queued events as wire-format SSE frames. Yields until {@link close}.
	 * Each frame is `id: <n>\nevent: <type>\ndata: <json>\n\n`.
	 */
	async *[Symbol.asyncIterator](): AsyncIterator<string> {
		while (!this.#closed || this.#queue.length > 0) {
			if (this.#queue.length === 0) {
				if (this.#closed) return;
				await new Promise<void>((resolve) => {
					this.#wake = resolve;
				});
				this.#wake = null;
				continue;
			}
			const e = this.#queue.shift()!;
			// A flushed event leaves the coalescing window — drop its stale index so a
			// later same-key event starts a new slot instead of overwriting nothing.
			if (COALESCE_TYPES.has(e.type)) {
				const ck = coalesceKey(e);
				if (this.#coalesceIdx.get(ck) === 0) this.#coalesceIdx.delete(ck);
				this.#reindexCoalesce();
			}
			yield formatFrame(e);
		}
	}
}

/** The stream identity used for latest-wins coalescing. */
function coalesceKey(e: BusEvent): string {
	return `${e.type}|${e.topic}|${e.key ?? ''}`;
}

/** Serialize a bus event into a single SSE wire frame. */
export function formatFrame(e: BusEvent): string {
	const id = ++nextId;
	const payload = JSON.stringify({ topic: e.topic, key: e.key, data: e.data });
	return `id: ${id}\nevent: ${e.type}\ndata: ${payload}\n\n`;
}

/**
 * Build a `ReadableStream<Uint8Array>` for a SvelteKit SSE Response body, fed by a
 * per-client {@link SseClient} off the bus. Closing the stream closes the client
 * (unsubscribes from the bus). This is the ONE place the bus reaches the dashboard.
 */
export function sseStream(bus: EventBus, opts: SseClientOptions = {}): ReadableStream<Uint8Array> {
	const client = SseClient.from(bus, opts);
	const encoder = new TextEncoder();
	let iterator: AsyncIterator<string>;
	return new ReadableStream<Uint8Array>({
		start() {
			iterator = client[Symbol.asyncIterator]();
		},
		async pull(controller) {
			const { value, done } = await iterator.next();
			if (done) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(value));
		},
		cancel() {
			client.close();
		}
	});
}
