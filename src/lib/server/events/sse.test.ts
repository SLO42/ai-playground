import { describe, it, expect, beforeEach } from 'vitest';
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
		const stream = sseStream(bus, {});
		expect(bus.size).toBe(1); // exactly one per-client subscription
		bus.publish(ev({ data: { hi: true } }));
		const reader = stream.getReader();
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value!);
		expect(text).toContain('event: db_change');
		await reader.cancel();
		expect(bus.size).toBe(0); // cancel unsubscribed
	});
});

describe('formatFrame', () => {
	it('produces a well-formed SSE frame with id/event/data', () => {
		const f = formatFrame(ev({ type: 'notification', topic: 'x', data: { a: 1 } }));
		expect(f).toMatch(/^id: \d+\nevent: notification\ndata: \{.*\}\n\n$/);
	});
});
