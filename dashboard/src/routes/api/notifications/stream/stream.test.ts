import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock notifications module ─────────────────────────────────────────

type Subscriber = (notif: any) => void;
let capturedSubscriber: Subscriber | null = null;
const mockUnsubscribe = vi.fn();

vi.mock('$lib/server/notifications.js', () => ({
	subscribe: vi.fn((fn: Subscriber) => {
		capturedSubscriber = fn;
		return mockUnsubscribe;
	})
}));

// ── Import after mocks ───────────────────────────────────────────────

import { GET } from './+server.js';
import { subscribe } from '$lib/server/notifications.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeNotification(overrides: Record<string, unknown> = {}) {
	return {
		id: 'notif-001',
		timestamp: '2026-03-06T12:00:00.000Z',
		severity: 'info',
		category: 'task',
		title: 'Test Notification',
		message: 'Something happened',
		read: false,
		...overrides
	};
}

/** Read all currently available chunks from the stream as text */
async function readChunks(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<string[]> {
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	for (let i = 0; i < count; i++) {
		const { value, done } = await reader.read();
		if (done) break;
		chunks.push(decoder.decode(value));
	}
	return chunks;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/notifications/stream', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		capturedSubscriber = null;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns SSE response with correct headers', async () => {
		const response = await GET({} as any);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/event-stream');
		expect(response.headers.get('Cache-Control')).toBe('no-cache');
		expect(response.headers.get('Connection')).toBe('keep-alive');

		// Cleanup: cancel the stream
		response.body?.cancel();
	});

	it('sends initial keepalive comment', async () => {
		const response = await GET({} as any);
		const reader = response.body!.getReader();

		const chunks = await readChunks(reader, 1);
		expect(chunks[0]).toBe(': keepalive\n\n');

		reader.cancel();
	});

	it('subscribes to notification events', async () => {
		const response = await GET({} as any);
		const reader = response.body!.getReader();

		// Read the initial keepalive
		await reader.read();

		expect(subscribe).toHaveBeenCalledOnce();
		expect(capturedSubscriber).toBeTypeOf('function');

		reader.cancel();
	});

	it('streams notification data as SSE events', async () => {
		const response = await GET({} as any);
		const reader = response.body!.getReader();

		// Read initial keepalive
		await reader.read();

		// Push a notification through the subscriber
		const notif = makeNotification();
		capturedSubscriber!(notif);

		const chunks = await readChunks(reader, 1);
		expect(chunks[0]).toBe(`data: ${JSON.stringify(notif)}\n\n`);

		reader.cancel();
	});

	it('streams multiple notifications sequentially', async () => {
		const response = await GET({} as any);
		const reader = response.body!.getReader();

		// Read initial keepalive
		await reader.read();

		const notif1 = makeNotification({ id: 'n1', title: 'First' });
		const notif2 = makeNotification({ id: 'n2', title: 'Second', severity: 'warning' });

		capturedSubscriber!(notif1);
		capturedSubscriber!(notif2);

		const chunks = await readChunks(reader, 2);
		expect(chunks[0]).toBe(`data: ${JSON.stringify(notif1)}\n\n`);
		expect(chunks[1]).toBe(`data: ${JSON.stringify(notif2)}\n\n`);

		reader.cancel();
	});

	it('sends periodic keepalive every 30 seconds', async () => {
		const response = await GET({} as any);
		const reader = response.body!.getReader();

		// Read initial keepalive
		await reader.read();

		// Advance timer by 30 seconds
		vi.advanceTimersByTime(30000);

		const chunks = await readChunks(reader, 1);
		expect(chunks[0]).toBe(': keepalive\n\n');

		reader.cancel();
	});

	it('cleans up subscription on stream cancel', async () => {
		const response = await GET({} as any);
		const reader = response.body!.getReader();

		// Read initial keepalive
		await reader.read();

		expect(subscribe).toHaveBeenCalledOnce();

		// Cancel the stream — triggers cleanup
		await reader.cancel();

		expect(mockUnsubscribe).toHaveBeenCalledOnce();
	});

	it('cleans up keepalive interval on cancel', async () => {
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

		const response = await GET({} as any);
		const reader = response.body!.getReader();
		await reader.read();

		await reader.cancel();

		expect(clearIntervalSpy).toHaveBeenCalled();
		clearIntervalSpy.mockRestore();
	});

	it('handles notification with all optional fields', async () => {
		const response = await GET({} as any);
		const reader = response.body!.getReader();
		await reader.read();

		const notif = makeNotification({
			source: 'heartbeat',
			link: '/tasks/123',
			linkLabel: 'View Task',
			stackCount: 3
		});

		capturedSubscriber!(notif);

		const chunks = await readChunks(reader, 1);
		const parsed = JSON.parse(chunks[0].replace('data: ', '').trim());
		expect(parsed.source).toBe('heartbeat');
		expect(parsed.link).toBe('/tasks/123');
		expect(parsed.linkLabel).toBe('View Task');
		expect(parsed.stackCount).toBe(3);

		reader.cancel();
	});

	it('handles critical severity notifications', async () => {
		const response = await GET({} as any);
		const reader = response.body!.getReader();
		await reader.read();

		const notif = makeNotification({ severity: 'critical', title: 'System Down' });
		capturedSubscriber!(notif);

		const chunks = await readChunks(reader, 1);
		const parsed = JSON.parse(chunks[0].replace('data: ', '').trim());
		expect(parsed.severity).toBe('critical');
		expect(parsed.title).toBe('System Down');

		reader.cancel();
	});
});
