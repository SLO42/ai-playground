// Shared client SSE connection instance (TASK 1.5).
//
// ONE SseConnection per browser tab — the client mirror of the server's one bus →
// one SSE fan-out (ARCHITECTURE §2.11). The root layout `start()`s it; any page
// reads `.connection` reactively or registers a db_change handler to live-update.
// Kept as a module singleton (not Svelte context) so non-component code can reach it.

import { SseConnection } from './sse.svelte';

export const stream = new SseConnection();
