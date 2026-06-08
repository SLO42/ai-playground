// Client SSE connection — the browser end of the one event stream (TASK 1.5).
//
// Subscribes to /api/events (the SOLE SSE fan-out) and exposes:
//   • connection: 'live' | 'reconnecting' | 'offline' | 'unknown'  (D-019, UI-SPEC §7)
//   • a way to register per-table db_change handlers so pages re-fetch/patch live.
//
// Svelte 5 RUNES only ($state) — never stores (D-005). Honest connection state:
// we start 'unknown', flip to 'live' on open, 'reconnecting' on error while the
// browser retries (EventSource auto-reconnects), and 'offline' only when explicitly
// stopped. We NEVER fake 'live' before the socket opens (F-008 / §1.3).

import type { DbChange } from '$lib/server/events/db-source';

export type ConnectionState = 'live' | 'reconnecting' | 'offline' | 'unknown';

/** Payload as the SSE frame delivers it (see events/sse.ts formatFrame). */
interface SseFrame<T = unknown> {
	topic: string;
	key?: string;
	data: T;
}

type DbChangeHandler = (change: DbChange, topic: string) => void;

/** A handler for a topic-scoped live event (transcript/token_usage/session_status/interject). */
export type TopicHandler<T = unknown> = (data: T, key?: string) => void;

/** The live event types a topic subscriber can listen to (besides db_change). */
export type LiveEventType = 'transcript' | 'token_usage' | 'session_status' | 'interject';

/** All live event types the topic stream carries — kept in one place so the URL + listeners agree. */
const TOPIC_EVENT_TYPES: LiveEventType[] = [
	'transcript',
	'token_usage',
	'session_status',
	'interject'
];

/**
 * A reactive SSE client. Construct once (e.g. in the root layout), call `start()`
 * in an `$effect` so it only runs in the browser, and read `.connection` reactively.
 * Pages call `onDbChange(table, fn)` to react to live row changes for their table.
 */
export class SseConnection {
	/** Reactive connection state for the Topbar/Statusbar indicators (UI-SPEC §3). */
	connection = $state<ConnectionState>('unknown');
	/** Timestamp of the last frame received — drives "as of <time>" staleness (§7). */
	lastEventAt = $state<number | null>(null);

	#source: EventSource | null = null;
	#handlers = new Map<string, Set<DbChangeHandler>>();
	#url: string;

	// Topic-scoped live-event stream (transcript/token_usage/session_status/interject).
	// Opened lazily ONLY when a view subscribes (e.g. a session transcript panel), so the
	// default page load never carries the high-frequency transcript types it doesn't need.
	// Same /api/events fan-out, narrowed by ?types= — still the one bus → one SSE (§2.11).
	#topicSource: EventSource | null = null;
	// key = `${eventType}::${topic}` → handlers.
	#topicHandlers = new Map<string, Set<TopicHandler>>();

	constructor(url = '/api/events?types=db_change') {
		this.#url = url;
	}

	/** Register a handler for a table's db_change events. Returns an unsubscribe. */
	onDbChange(table: string, fn: DbChangeHandler): () => void {
		let set = this.#handlers.get(table);
		if (!set) {
			set = new Set();
			this.#handlers.set(table, set);
		}
		set.add(fn);
		return () => set?.delete(fn);
	}

	/** Open the stream. Idempotent + browser-only (EventSource is undefined on the server). */
	start(): void {
		if (this.#source || typeof EventSource === 'undefined') return;

		const es = new EventSource(this.#url);
		this.#source = es;

		es.onopen = () => {
			this.connection = 'live';
		};
		// EventSource auto-reconnects on error; surface that as 'reconnecting' (D-019),
		// never blank/offline while the browser is still retrying.
		es.onerror = () => {
			if (es.readyState === EventSource.CLOSED) this.connection = 'offline';
			else this.connection = 'reconnecting';
		};
		es.addEventListener('db_change', (ev) => this.#onDbChange(ev as MessageEvent));
	}

	#onDbChange(ev: MessageEvent): void {
		this.lastEventAt = Date.now();
		let frame: SseFrame<DbChange>;
		try {
			frame = JSON.parse(ev.data) as SseFrame<DbChange>;
		} catch {
			return; // a malformed frame is dropped, never crashes the stream
		}
		const set = this.#handlers.get(frame.topic);
		if (!set) return;
		for (const fn of set) {
			try {
				fn(frame.data, frame.topic);
			} catch {
				/* a throwing handler is isolated */
			}
		}
	}

	/**
	 * Subscribe to a topic-scoped live event (transcript/token_usage/session_status/interject)
	 * for one `topic` (a session id). Lazily opens the topic EventSource on first use. Returns
	 * an unsubscribe; the topic source is closed when the last subscriber leaves so an idle
	 * page carries no transcript stream. Frames whose topic doesn't match are ignored.
	 */
	subscribeTopic<T = unknown>(
		eventType: LiveEventType,
		topic: string,
		fn: TopicHandler<T>
	): () => void {
		this.#ensureTopicSource();
		const key = `${eventType}::${topic}`;
		let set = this.#topicHandlers.get(key);
		if (!set) {
			set = new Set();
			this.#topicHandlers.set(key, set);
		}
		set.add(fn as TopicHandler);
		return () => {
			set?.delete(fn as TopicHandler);
			if (set && set.size === 0) this.#topicHandlers.delete(key);
			// Tear the topic source down once nothing listens — keep idle pages quiet.
			if (this.#topicHandlers.size === 0) {
				this.#topicSource?.close();
				this.#topicSource = null;
			}
		};
	}

	#ensureTopicSource(): void {
		if (this.#topicSource || typeof EventSource === 'undefined') return;
		const url = `/api/events?types=${TOPIC_EVENT_TYPES.join(',')}`;
		const es = new EventSource(url);
		this.#topicSource = es;
		for (const type of TOPIC_EVENT_TYPES) {
			es.addEventListener(type, (ev) => this.#onTopicEvent(type, ev as MessageEvent));
		}
	}

	#onTopicEvent(eventType: LiveEventType, ev: MessageEvent): void {
		this.lastEventAt = Date.now();
		let frame: SseFrame;
		try {
			frame = JSON.parse(ev.data) as SseFrame;
		} catch {
			return; // a malformed frame is dropped, never crashes the stream
		}
		const set = this.#topicHandlers.get(`${eventType}::${frame.topic}`);
		if (!set) return;
		for (const fn of set) {
			try {
				fn(frame.data, frame.key);
			} catch {
				/* a throwing handler is isolated */
			}
		}
	}

	/** Close the stream and mark offline. Idempotent. */
	stop(): void {
		this.#source?.close();
		this.#source = null;
		this.#topicSource?.close();
		this.#topicSource = null;
		this.connection = 'offline';
	}
}
