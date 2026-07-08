// The ONE SSE fan-out endpoint (TASK 1.5; ARCHITECTURE §2.11).
//
// This is the SOLE place the `events` bus reaches the dashboard. Each connected
// client gets its OWN backpressured subscription off the bus via sseStream()
// (events/sse.ts) — latest-wins coalescing for high-frequency types, drop-oldest
// otherwise. A client may narrow the stream to specific bus `type`s via the
// `?types=` query param (e.g. `?types=db_change`); default = all.
//
// We await `startup` first so the live-query watchers are running before a client
// subscribes (no missed early changes for a just-loaded page). The connection is
// Protection = the m0071 login gate (loopback bypasses it; external needs the signed SameSite=lax cookie), NOT the server bind.

import { sseStream, getEventBus, type EventType } from '$lib/server/events';
import { startup } from '../../../hooks.server';
import type { RequestHandler } from './$types';

/** SSE responses must never be buffered/cached by adapters or proxies. */
const SSE_HEADERS = {
	'content-type': 'text/event-stream',
	'cache-control': 'no-cache, no-transform',
	connection: 'keep-alive',
	// SvelteKit's Node adapter respects this to avoid response buffering.
	'x-accel-buffering': 'no'
} as const;

export const GET: RequestHandler = async ({ url }) => {
	await startup; // ensure watchers are live before this client subscribes

	const typesParam = url.searchParams.get('types');
	const wanted = typesParam
		? new Set(typesParam.split(',').map((s) => s.trim()).filter(Boolean) as EventType[])
		: null;

	const bus = getEventBus();
	const body = sseStream(bus, {
		filter: wanted ? (e) => wanted.has(e.type) : undefined
	});

	return new Response(body, { headers: SSE_HEADERS });
};
