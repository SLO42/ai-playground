import type { RequestHandler } from './$types.js';
import { subscribe, type BusEvent } from '$lib/server/event-bus.js';

export const GET: RequestHandler = async ({ request }) => {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			// Send keepalive immediately so the client knows the connection is open
			controller.enqueue(encoder.encode(': keepalive\n\n'));

			unsubscribe = subscribe((event: BusEvent) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {
					// Client disconnected
					cleanup();
				}
			});

			// Keepalive every 30s
			keepalive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
				} catch {
					cleanup();
				}
			}, 30_000);

			// Cleanup on abort
			request.signal.addEventListener('abort', () => {
				cleanup();
			});
		},
		cancel() {
			cleanup();
		}
	});

	function cleanup() {
		unsubscribe?.();
		unsubscribe = null;
		if (keepalive) {
			clearInterval(keepalive);
			keepalive = null;
		}
	}

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
