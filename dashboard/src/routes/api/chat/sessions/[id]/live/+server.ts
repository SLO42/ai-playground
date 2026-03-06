import type { RequestHandler } from './$types.js';
import { subscribe, getSessionStatus } from '$lib/server/session-manager.js';

export const GET: RequestHandler = async ({ params }) => {
	const sessionId = params.id;
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			// Send initial status
			const status = getSessionStatus(sessionId);
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'status', status })}\n\n`));

			const unsub = subscribe(sessionId, (event) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {
					unsub();
				}
			});

			// Keep-alive ping every 30s
			const ping = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: ping\n\n`));
				} catch {
					clearInterval(ping);
					unsub();
				}
			}, 30_000);

			// Clean up when client disconnects
			const cleanup = () => {
				clearInterval(ping);
				unsub();
			};

			// Store cleanup for cancel
			(controller as any).__cleanup = cleanup;
		},
		cancel(controller) {
			(controller as any)?.__cleanup?.();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
