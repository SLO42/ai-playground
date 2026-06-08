import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus, type BusEvent } from './bus';
import { SseClient, formatFrame, sseStream } from './sse';

const ev = (over: Partial<BusEvent> = {}): BusEvent => ({
	type: 'db_change',
	topic: 'task',
	data: { n: 1 },
	...over
});

describe('SseClient — per-client subscription off the bus', () => {
	let bus: EventBus;
	beforeEach(() => {
		bus = new EventBus();
	});

	it('only queues events that pass the client filter', () => {
		const client = SseClient.from(bus, { filter: (e) => e.topic === 'task' });
		bus.publish(ev({ topic: 'task' }));
		bus.publish(ev({ topic: 'session:1', type: 'log' }));
		expect(client.queued).toBe(1);
		client.close();
	});

	it('drains queued events as SSE wire frames, in order', async () => {
		const client = SseClient.from(bus);
		bus.publish(ev({ data: { n: 1 } }));
		bus.publish(ev({ data: { n: 2 } }));
		const frames: string[] = [];
		const it = client[Symbol.asyncIterator]();
		frames.push((await it.next()).value as string);
		frames.push((await it.next()).value as string);
		client.close();
		expect(frames[0]).toMatch(/^id: \d+\nevent: db_change\ndata: /);
		expect(JSON.parse(frames[0].match(/data: (.*)\n\n$/)![1]).data.n).toBe(1);
		expect(JSON.parse(frames[1].match(/data: (.*)\n\n$/)![1]).data.n).toBe(2);
	});

	it('closing ends the iterator', async () => {
		const client = SseClient.from(bus);
		const it = client[Symbol.asyncIterator]();
		client.close();
		expect((await it.next()).done).toBe(true);
	});
});

describe('SseClient — backpressure', () => {
	let bus: EventBus;
	beforeEach(() => {
		bus = new EventBus();
	});

	it('coalesces high-frequency token_usage latest-wins (slow client gets newest only)', () => {
		const client = SseClient.from(bus);
		// Same stream (type|topic|key) → should collapse to ONE queued slot.
		for (let i = 1; i <= 50; i++) {
			bus.publish({ type: 'token_usage', topic: 'session:1', key: 'session:1', data: { tokens: i } });
		}
		expect(client.queued).toBe(1);
		client.close();
	});

	it('does not coalesce across different streams', () => {
		const client = SseClient.from(bus);
		bus.publish({ type: 'token_usage', topic: 's:1', key: 's:1', data: { t: 1 } });
		bus.publish({ type: 'token_usage', topic: 's:2', key: 's:2', data: { t: 1 } });
		expect(client.queued).toBe(2);
		client.close();
	});

	it('drains the LATEST coalesced value', async () => {
		const client = SseClient.from(bus);
		for (let i = 1; i <= 10; i++) {
			bus.publish({ type: 'token_usage', topic: 's:1', key: 's:1', data: { t: i } });
		}
		const it = client[Symbol.asyncIterator]();
		const frame = (await it.next()).value as string;
		expect(JSON.parse(frame.match(/data: (.*)\n\n$/)![1]).data.t).toBe(10);
		client.close();
	});

	it('drops oldest non-coalesced events past the queue cap, never buffering unboundedly', () => {
		const client = SseClient.from(bus, { maxQueue: 5 });
		for (let i = 0; i < 100; i++) bus.publish(ev({ type: 'log', data: { i } }));
		expect(client.queued).toBe(5); // bounded — newest 5 retained
		client.close();
	});

	it('stays bounded under SUSTAINED token_usage backpressure (latest-wins, no unbounded buffer)', () => {
		// Production scenario: a slow client never drains while a session streams tens of
		// thousands of token_usage updates on ONE stream. The coalescing slot must collapse
		// them to a single queued entry regardless of volume — no O(n) reindex blowup, no
		// unbounded buffer. This is the core TASK 2.1 verify against sustained pressure.
		const client = SseClient.from(bus);
		for (let i = 1; i <= 10_000; i++) {
			bus.publish({ type: 'token_usage', topic: 's:1', key: 's:1', data: { t: i } });
		}
		expect(client.queued).toBe(1);
		client.close();
	});

	it('coalesces correctly ACROSS a partial drain (no stale-index overwrite of a flushed slot)', async () => {
		// Hardening: enqueue, drain one frame (flushing the coalesced slot), then publish
		// MORE same-key events. The post-drain events must start a FRESH slot and still be
		// delivered latest-wins — never silently dropped by a dangling index pointing at an
		// already-flushed position.
		const client = SseClient.from(bus);
		bus.publish({ type: 'token_usage', topic: 's:1', key: 's:1', data: { t: 1 } });
		const it = client[Symbol.asyncIterator]();
		const first = (await it.next()).value as string;
		expect(JSON.parse(first.match(/data: (.*)\n\n$/)![1]).data.t).toBe(1);
		// queue now empty; the coalesce slot for s:1 was flushed.
		expect(client.queued).toBe(0);
		bus.publish({ type: 'token_usage', topic: 's:1', key: 's:1', data: { t: 2 } });
		bus.publish({ type: 'token_usage', topic: 's:1', key: 's:1', data: { t: 3 } });
		expect(client.queued).toBe(1); // fresh slot, coalesced
		const second = (await it.next()).value as string;
		expect(JSON.parse(second.match(/data: (.*)\n\n$/)![1]).data.t).toBe(3); // latest wins
		client.close();
	});

	it('coalesces token_usage WITHOUT dropping interleaved non-coalesced transcript frames (FIFO)', async () => {
		// A real session interleaves high-frequency token_usage with transcript messages
		// that MUST NOT be lost. token_usage collapses latest-wins; every transcript frame
		// survives and keeps FIFO order relative to other transcripts.
		const client = SseClient.from(bus);
		bus.publish({ type: 'transcript', topic: 's:1', key: 's:1:0', data: { seq: 0 } });
		bus.publish({ type: 'token_usage', topic: 's:1', key: 's:1', data: { t: 1 } });
		bus.publish({ type: 'transcript', topic: 's:1', key: 's:1:1', data: { seq: 1 } });
		bus.publish({ type: 'token_usage', topic: 's:1', key: 's:1', data: { t: 2 } });
		bus.publish({ type: 'transcript', topic: 's:1', key: 's:1:2', data: { seq: 2 } });
		// 3 transcripts kept + 1 coalesced token_usage = 4 queued.
		expect(client.queued).toBe(4);
		const it = client[Symbol.asyncIterator]();
		const drained: Array<{ type: string; payload: Record<string, unknown> }> = [];
		for (let i = 0; i < 4; i++) {
			const f = (await it.next()).value as string;
			const type = f.match(/event: (\w+)\n/)![1];
			const payload = JSON.parse(f.match(/data: (.*)\n\n$/)![1]).data;
			drained.push({ type, payload });
		}
		const transcripts = drained.filter((d) => d.type === 'transcript');
		expect(transcripts.map((t) => t.payload.seq)).toEqual([0, 1, 2]); // FIFO, none lost
		const usage = drained.filter((d) => d.type === 'token_usage');
		expect(usage).toHaveLength(1);
		expect(usage[0].payload.t).toBe(2); // latest-wins
		client.close();
	});

	it('a slow client never blocks the bus or other clients', () => {
		// "Slow" client: never drains. "Fast" client: drains immediately.
		const slow = SseClient.from(bus, { maxQueue: 3 });
		let fastSeen = 0;
		bus.subscribe(() => fastSeen++); // a fast consumer reading synchronously
		for (let i = 0; i < 20; i++) bus.publish(ev({ type: 'log', data: { i } }));
		expect(fastSeen).toBe(20); // bus delivered all to the fast consumer
		expect(slow.queued).toBe(3); // slow client bounded, did not stall anyone
		slow.close();
	});
});

describe('sseStream — ReadableStream body for the one SSE endpoint', () => {
	it('emits encoded frames and cancel() unsubscribes from the bus', async () => {
		const bus = new EventBus();
		const stream = sseStream(bus, { heartbeatMs: 0 });
		expect(bus.size).toBe(1); // exactly one per-client subscription
		bus.publish(ev({ data: { hi: true } }));
		const reader = stream.getReader();
		// First frame is the prime comment (see below); the event follows.
		await reader.read();
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value!);
		expect(text).toContain('event: db_change');
		await reader.cancel();
		expect(bus.size).toBe(0); // cancel unsubscribed
	});

	it('primes with a `: ready` comment on open BEFORE any bus event (so onopen fires immediately)', async () => {
		const bus = new EventBus();
		const stream = sseStream(bus, { heartbeatMs: 0 });
		// NOTHING published yet — the first readable chunk must already be available.
		const reader = stream.getReader();
		const { value, done } = await reader.read();
		expect(done).toBe(false);
		const text = new TextDecoder().decode(value!);
		expect(text).toBe(': ready\n\n'); // SSE comment frame — flushes the head, ignored as data
		await reader.cancel();
	});

	it('emits a periodic heartbeat comment to keep the connection warm', async () => {
		vi.useFakeTimers();
		try {
			const bus = new EventBus();
			const stream = sseStream(bus, { heartbeatMs: 50 });
			const reader = stream.getReader();
			// Drain the prime frame first.
			expect(new TextDecoder().decode((await reader.read()).value!)).toBe(': ready\n\n');
			// Advance past one heartbeat interval — a heartbeat comment must arrive.
			await vi.advanceTimersByTimeAsync(60);
			const { value } = await reader.read();
			expect(new TextDecoder().decode(value!)).toBe(': heartbeat\n\n');
			await reader.cancel();
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops the heartbeat timer on cancel (no leak)', async () => {
		vi.useFakeTimers();
		try {
			const clearSpy = vi.spyOn(globalThis, 'clearInterval');
			const bus = new EventBus();
			const stream = sseStream(bus, { heartbeatMs: 50 });
			const reader = stream.getReader();
			await reader.read(); // prime
			await reader.cancel();
			expect(clearSpy).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('formatFrame', () => {
	it('produces a well-formed SSE frame with id/event/data', () => {
		const f = formatFrame(ev({ type: 'notification', topic: 'x', data: { a: 1 } }));
		expect(f).toMatch(/^id: \d+\nevent: notification\ndata: \{.*\}\n\n$/);
	});
});
