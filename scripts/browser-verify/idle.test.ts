// Unit: idle monitor with an INJECTED clock (TASK 15.2 B3) — the quiet-period
// logic is exercised deterministically, no real timers (the gstack pattern of
// exporting idleCheckTick for tests, reimplemented as clock injection).

import { describe, it, expect } from 'vitest';
import { createIdleMonitor } from './idle.mjs';

function fakeClock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createIdleMonitor', () => {
	it('is not due before the quiet period elapses', () => {
		const clock = fakeClock();
		const idle = createIdleMonitor({ quietMs: 10_000, now: clock.now });
		clock.advance(9_999);
		expect(idle.due()).toBe(false);
		expect(idle.idleFor()).toBe(9_999);
	});

	it('becomes due exactly at the quiet period boundary', () => {
		const clock = fakeClock();
		const idle = createIdleMonitor({ quietMs: 10_000, now: clock.now });
		clock.advance(10_000);
		expect(idle.due()).toBe(true);
	});

	it('touch() resets the timer (timer reset on use)', () => {
		const clock = fakeClock();
		const idle = createIdleMonitor({ quietMs: 10_000, now: clock.now });
		clock.advance(9_000);
		idle.touch();
		clock.advance(9_000);
		expect(idle.due()).toBe(false); // 9s since last touch, not 18s
		expect(idle.idleFor()).toBe(9_000);
		clock.advance(1_000);
		expect(idle.due()).toBe(true);
	});

	it('lastUsedAt tracks the latest touch', () => {
		const clock = fakeClock(500);
		const idle = createIdleMonitor({ quietMs: 1_000, now: clock.now });
		expect(idle.lastUsedAt()).toBe(500);
		clock.advance(250);
		idle.touch();
		expect(idle.lastUsedAt()).toBe(750);
	});

	it('rejects a nonsense quiet period with a NAMED error (shadow paths: nil/zero/NaN)', () => {
		for (const bad of [0, -1, NaN, Infinity, undefined as unknown as number]) {
			expect(() => createIdleMonitor({ quietMs: bad })).toThrowError(/idle-quiet-invalid/);
		}
	});
});
