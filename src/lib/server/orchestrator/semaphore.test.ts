import { describe, it, expect } from 'vitest';
import { Semaphore } from './semaphore';

// TASK 2.2 — the interactive concurrency cap (ARCHITECTURE §2.2a). A counting
// semaphore caps concurrent interactive spawns; waiters park FIFO (no busy loop,
// D-004); release is idempotent so a double-release can't over-grant permits.

describe('Semaphore — interactive concurrency cap (ARCHITECTURE §2.2a)', () => {
	it('rejects a non-positive max', () => {
		expect(() => new Semaphore(0)).toThrow();
		expect(() => new Semaphore(-1)).toThrow();
		expect(() => new Semaphore(1.5)).toThrow();
	});

	it('tryAcquire hands out up to max permits, then returns null (the cap)', () => {
		const s = new Semaphore(2);
		const a = s.tryAcquire();
		const b = s.tryAcquire();
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(s.inUse).toBe(2);
		expect(s.available).toBe(0);
		// Cap reached — no third permit.
		expect(s.tryAcquire()).toBeNull();
	});

	it('release frees a permit so the next tryAcquire succeeds', () => {
		const s = new Semaphore(1);
		const a = s.tryAcquire()!;
		expect(s.tryAcquire()).toBeNull();
		a.release();
		expect(s.available).toBe(1);
		expect(s.tryAcquire()).not.toBeNull();
	});

	it('a parked acquire() resolves FIFO when a permit is released (no spin)', async () => {
		const s = new Semaphore(1);
		const first = await s.acquire();
		const order: number[] = [];
		const p2 = s.acquire().then((p) => {
			order.push(2);
			return p;
		});
		const p3 = s.acquire().then((p) => {
			order.push(3);
			return p;
		});
		expect(s.waiting).toBe(2);
		// Release once → waiter #2 (FIFO) wakes; release again → waiter #3.
		first.release();
		const permit2 = await p2;
		permit2.release();
		await p3;
		expect(order).toEqual([2, 3]);
	});

	it('double-release is idempotent — it never inflates the permit count', () => {
		const s = new Semaphore(1);
		const a = s.tryAcquire()!;
		a.release();
		a.release(); // second release must be a no-op
		expect(s.inUse).toBe(0);
		// Only ONE permit exists despite the double-release.
		expect(s.tryAcquire()).not.toBeNull();
		expect(s.tryAcquire()).toBeNull();
	});
});
