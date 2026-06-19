// server/events — public barrel (TASK 0.d; ARCHITECTURE §2.11).
//
// The `events` bus is the SOLE source for the one SSE fan-out. Import the bus and
// SSE helpers from here; open live queries ONLY via watchTable (db-source) — never
// a second live query elsewhere (the §2.11 double-fire invariant).

export {
	EventBus,
	getEventBus,
	resetEventBus,
	type BusEvent,
	type EventType,
	type EventFilter,
	type EventListener,
	type Unsubscribe
} from './bus';

export { SseClient, sseStream, formatFrame, type SseClientOptions } from './sse';

export {
	watchTable,
	type DbSourceHandle,
	type DbChange,
	type LiveStatus,
	type LiveStatusPhase
} from './db-source';

export { WATCHED_TABLES, type WatchedTable } from './watched-tables';
