import type { RequestHandler } from './$types.js';
import { subscribe } from '$lib/server/notifications.js';

export const GET: RequestHandler = async () => {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			// Send keepalive immediately
			controller.enqueue(encoder.encode(': keepalive\n\n'));

			unsubscribe = subscribe((notif) => {
				try {
					const data = JSON.stringify(notif);
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));
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
			}, 30000);
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
