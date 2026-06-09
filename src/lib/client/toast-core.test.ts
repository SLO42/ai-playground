import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VISIBLE, ToastCore } from './toast-core';

describe('ToastCore', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('pushes a toast and assigns an incrementing id', () => {
		const core = new ToastCore();
		const a = core.push({ kind: 'info', title: 'one' });
		const b = core.push({ kind: 'info', title: 'two' });
		expect(b).toBe(a + 1);
		expect(core.items.map((t) => t.title)).toEqual(['one', 'two']);
	});

	it('notifies on every change', () => {
		const onChange = vi.fn();
		const core = new ToastCore(onChange);
		core.push({ kind: 'success', title: 'saved' });
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('auto-dismisses after the default duration', () => {
		const core = new ToastCore();
		core.push({ kind: 'success', title: 'Config saved' });
		expect(core.items).toHaveLength(1);
		vi.advanceTimersByTime(4500);
		expect(core.items).toHaveLength(0);
	});

	it('errors linger longer than success/info', () => {
		const core = new ToastCore();
		core.push({ kind: 'error', title: 'Failed' });
		vi.advanceTimersByTime(4500);
		expect(core.items).toHaveLength(1); // still up at the success-duration mark
		vi.advanceTimersByTime(3500);
		expect(core.items).toHaveLength(0); // gone by 8000ms
	});

	it('a sticky toast (duration 0) never auto-dismisses', () => {
		const core = new ToastCore();
		core.push({ kind: 'info', title: 'sticky', duration: 0 });
		vi.advanceTimersByTime(60_000);
		expect(core.items).toHaveLength(1);
	});

	it('manual dismiss removes the toast and is idempotent', () => {
		const core = new ToastCore();
		const id = core.push({ kind: 'info', title: 'x', duration: 0 });
		core.dismiss(id);
		expect(core.items).toHaveLength(0);
		expect(() => core.dismiss(id)).not.toThrow();
	});

	it('only notifies on dismiss when a toast was actually removed', () => {
		const onChange = vi.fn();
		const core = new ToastCore(onChange);
		core.dismiss(999); // nothing to remove
		expect(onChange).not.toHaveBeenCalled();
	});

	it('caps the visible stack, trimming the oldest', () => {
		const core = new ToastCore();
		for (let i = 0; i < MAX_VISIBLE + 3; i++) core.push({ kind: 'info', title: `t${i}`, duration: 0 });
		expect(core.items).toHaveLength(MAX_VISIBLE);
		// oldest (t0..t2) trimmed; newest retained
		expect(core.items[0].title).toBe('t3');
		expect(core.items.at(-1)?.title).toBe(`t${MAX_VISIBLE + 2}`);
	});

	it('clear() empties the stack and cancels timers', () => {
		const core = new ToastCore();
		core.push({ kind: 'info', title: 'a' });
		core.clear();
		expect(core.items).toHaveLength(0);
		// advancing past the duration must not resurrect or error
		vi.advanceTimersByTime(10_000);
		expect(core.items).toHaveLength(0);
	});
});
