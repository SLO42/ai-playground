import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus, getEventBus, resetEventBus, type BusEvent } from './bus';

const ev = (over: Partial<BusEvent> = {}): BusEvent => ({
	type: 'db_change',
	topic: 'task',
	data: { n: 1 },
	...over
});

describe('EventBus — fan-out + filtering', () => {
	let bus: EventBus;
	beforeEach(() => {
		bus = new EventBus();
	});

	it('delivers a published event to a subscriber exactly once', () => {
		const got: BusEvent[] = [];
		bus.subscribe((e) => got.push(e));
		bus.publish(ev());
		expect(got).toHaveLength(1);
		expect(got[0].topic).toBe('task');
	});

	it('fans out one event to every matching subscriber', () => {
		let a = 0;
		let b = 0;
		bus.subscribe(() => a++);
		bus.subscribe(() => b++);
		bus.publish(ev());
		expect(a).toBe(1);
		expect(b).toBe(1);
	});

	it('respects per-subscriber filters', () => {
		const tasks: BusEvent[] = [];
		const logs: BusEvent[] = [];
		bus.subscribe(
			(e) => tasks.push(e),
			(e) => e.topic === 'task'
		);
		bus.subscribe(
			(e) => logs.push(e),
			(e) => e.type === 'log'
		);
		bus.publish(ev({ topic: 'task' }));
		bus.publish(ev({ type: 'log', topic: 'session:1' }));
		expect(tasks).toHaveLength(1);
		expect(logs).toHaveLength(1);
		expect(logs[0].type).toBe('log');
	});

	it('unsubscribe stops further delivery (idempotent)', () => {
		let n = 0;
		const off = bus.subscribe(() => n++);
		bus.publish(ev());
		off();
		off(); // idempotent
		bus.publish(ev());
		expect(n).toBe(1);
		expect(bus.size).toBe(0);
	});
});

describe('EventBus — isolation (a slow/throwing consumer never breaks the bus)', () => {
	let bus: EventBus;
	beforeEach(() => {
		bus = new EventBus();
	});

	it('a throwing listener does not block delivery to others, and publish never throws', () => {
		let reached = 0;
		bus.subscribe(() => {
			throw new Error('boom');
		});
		bus.subscribe(() => reached++);
		expect(() => bus.publish(ev())).not.toThrow();
		expect(reached).toBe(1);
	});

	it('a throwing filter is treated as no-match and does not break others', () => {
		let reached = 0;
		bus.subscribe(
			() => reached++,
			() => {
				throw new Error('bad filter');
			}
		);
		bus.subscribe(() => reached++);
		bus.publish(ev());
		expect(reached).toBe(1); // only the good subscriber
	});

	it('subscribing during a publish does not disturb the in-flight fan-out', () => {
		let added = 0;
		bus.subscribe(() => {
			bus.subscribe(() => added++); // new sub mid-publish
		});
		bus.publish(ev());
		expect(added).toBe(0); // not delivered to the just-added sub for THIS publish
		bus.publish(ev());
		expect(added).toBe(1);
	});
});

describe('EventBus — singleton', () => {
	beforeEach(() => resetEventBus());
	it('getEventBus returns the same instance; reset clears it', () => {
		const a = getEventBus();
		const b = getEventBus();
		expect(a).toBe(b);
		resetEventBus();
		expect(getEventBus()).not.toBe(a);
	});
});
