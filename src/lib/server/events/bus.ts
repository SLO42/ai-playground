// server/events — the internal `events` bus (TASK 0.d; ARCHITECTURE §2.11).
//
// There is exactly ONE event bus in the process. Everything that wants to observe
// live state subscribes HERE — not to its own SurrealDB live query. `db` (see
// db-source.ts) is the SOLE owner of SurrealDB live queries and republishes those
// change events onto this bus; runtime transcript streams publish here too. The
// SSE fan-out (see sse.ts) is the SOLE consumer that reaches the dashboard, and it
// reads ONLY from this bus.
//
// INVARIANT (ARCHITECTURE §2.11): the bus is the single source of truth for
// dashboard-visible live state. No module opens its own live query for state it can
// get from the bus — that is the "double-fire" trap this design exists to prevent.
// The claude/channel push (D-035) is a SEPARATE transport for delivery INTO a
// running session; it is NEVER a second SSE source and never publishes a duplicate
// of a row change that already flows db → events.

/** The discriminant for what a bus event is about. Extended by later tasks. */
export type EventType =
	| 'db_change' // a SurrealDB row CREATE/UPDATE/DELETE republished by db-source
	| 'transcript' // a runtime/Claude Code transcript event
	| 'interject' // a channel.pushToSession push into a running session (TASK 2.10; D-035)
	| 'session_status' // a session lifecycle transition (stop/resume — TASK 2.10; D-011)
	| 'live_status' // a watched table's LIVE-subscription health (live/reconnecting/disconnected — F-042)
	| 'token_usage' // high-frequency metric — coalesced under backpressure (latest-wins)
	| 'metric' // generic high-frequency metric — coalesced
	| 'notification' // user-facing notification
	| 'log'; // log line — drop-oldest under backpressure

/** A single event on the bus. `key` enables per-client coalescing (latest-wins). */
export interface BusEvent<T = unknown> {
	/** Coarse type used for routing/filtering and backpressure policy. */
	type: EventType;
	/**
	 * For db_change: the table the row belongs to (e.g. 'task'). For transcript:
	 * the session id. Lets a client subscribe to only what its page needs.
	 */
	topic: string;
	/**
	 * Coalescing key. Two events with the same (type, topic, key) are considered
	 * the "same stream" for latest-wins coalescing of high-frequency types. For a
	 * db_change this is the record id, so repeated UPDATEs to one row collapse to
	 * the newest under backpressure. Omitted → every event is distinct.
	 */
	key?: string;
	/** The payload. For db_change: { action, record, result }. */
	data: T;
}

/** A predicate that decides whether a subscriber wants a given event. */
export type EventFilter = (e: BusEvent) => boolean;

/** Receives events that pass the filter. MUST NOT throw; throws are swallowed. */
export type EventListener = (e: BusEvent) => void;

/** Unsubscribe handle returned by {@link EventBus.subscribe}. Idempotent. */
export type Unsubscribe = () => void;

interface Subscription {
	filter: EventFilter;
	listener: EventListener;
}

/**
 * A minimal synchronous fan-out bus. `publish` delivers to every matching
 * subscriber in registration order; a throwing listener is isolated so it cannot
 * break delivery to the others (and never the publisher). There is no internal
 * buffering — backpressure is the SSE layer's job (per-client), keeping the bus
 * itself non-blocking so one slow consumer can never stall it (§2.11).
 */
export class EventBus {
	#subs = new Set<Subscription>();

	/**
	 * Register a listener. `filter` defaults to accept-all. Returns an idempotent
	 * unsubscribe. Subscribing/unsubscribing during a publish does not disturb the
	 * in-flight delivery (we snapshot the subscriber set per publish).
	 */
	subscribe(listener: EventListener, filter: EventFilter = () => true): Unsubscribe {
		const sub: Subscription = { filter, listener };
		this.#subs.add(sub);
		return () => {
			this.#subs.delete(sub);
		};
	}

	/** Publish one event to all matching subscribers. Never throws. */
	publish(event: BusEvent): void {
		// Snapshot so (un)subscribes triggered by a listener don't mutate iteration.
		for (const sub of [...this.#subs]) {
			let wanted = false;
			try {
				wanted = sub.filter(event);
			} catch {
				wanted = false; // a throwing filter must not break the bus
			}
			if (!wanted) continue;
			try {
				sub.listener(event);
			} catch {
				/* a throwing listener is isolated — never breaks other delivery */
			}
		}
	}

	/** Current subscriber count (for tests/diagnostics). */
	get size(): number {
		return this.#subs.size;
	}

	/** Drop all subscriptions (shutdown). */
	clear(): void {
		this.#subs.clear();
	}
}

// ── Process-wide singleton ───────────────────────────────────────────────────
// One bus per process — the SOLE fan-out. Modules import getEventBus(), they do
// NOT construct their own bus and do NOT open their own live query.

let singleton: EventBus | null = null;

/** Get the process-wide event bus, constructing it on first use. */
export function getEventBus(): EventBus {
	if (!singleton) singleton = new EventBus();
	return singleton;
}

/** Reset the singleton (tests only). */
export function resetEventBus(): void {
	singleton?.clear();
	singleton = null;
}
