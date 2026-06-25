import { describe, expect, it } from 'vitest';
import { relativeTime, elapsed, absoluteTime } from './time-format';

// A fixed clock so every assertion is deterministic (no Date.now() drift).
const NOW = Date.parse('2026-06-25T12:00:00.000Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('relativeTime', () => {
	it('formats sub-minute as Ns ago', () => {
		expect(relativeTime(at(3_000), NOW)).toBe('3s ago');
		expect(relativeTime(at(45_000), NOW)).toBe('45s ago');
	});
	it('formats minutes / hours / days', () => {
		expect(relativeTime(at(5 * 60_000), NOW)).toBe('5m ago');
		expect(relativeTime(at(2 * 3_600_000), NOW)).toBe('2h ago');
		expect(relativeTime(at(4 * 86_400_000), NOW)).toBe('4d ago');
	});
	it("renders 'now' for the current instant", () => {
		expect(relativeTime(at(0), NOW)).toBe('now');
	});
	it('handles clock-skew future timestamps as "in Ns"', () => {
		expect(relativeTime(new Date(NOW + 5_000).toISOString(), NOW)).toBe('in 5s');
	});
	// SHADOW PATHS — nil / empty / unparseable all collapse to the honest dash (F-013).
	it("returns '—' for nil, empty, or unparseable input", () => {
		expect(relativeTime(null, NOW)).toBe('—');
		expect(relativeTime(undefined, NOW)).toBe('—');
		expect(relativeTime('', NOW)).toBe('—');
		expect(relativeTime('   ', NOW)).toBe('—');
		expect(relativeTime('not-a-date', NOW)).toBe('—');
	});
});

describe('elapsed', () => {
	it('shows a RUNNING session live elapsed (end null → measured to now)', () => {
		// started 90s before now, still running → 1m 30s.
		expect(elapsed(at(90_000), null, NOW)).toBe('1m 30s');
	});
	it('ticks with a later now for a running session', () => {
		const start = at(60_000);
		expect(elapsed(start, null, NOW)).toBe('1m');
		expect(elapsed(start, null, NOW + 5_000)).toBe('1m 5s');
	});
	it('shows a DONE session final elapsed (start→end, frozen, independent of now)', () => {
		const start = new Date(NOW - 600_000).toISOString(); // 10m before now
		const end = new Date(NOW - 300_000).toISOString(); // 5m before now → span 5m
		expect(elapsed(start, end, NOW)).toBe('5m');
		// A later now does NOT change a terminal session's elapsed.
		expect(elapsed(start, end, NOW + 999_999)).toBe('5m');
	});
	it('formats sub-minute, minute+second, and hour+minute spans', () => {
		expect(elapsed(at(42_000), null, NOW)).toBe('42s');
		expect(elapsed(at(125_000), null, NOW)).toBe('2m 5s');
		expect(elapsed(new Date(NOW - 3 * 3_600_000 - 12 * 60_000).toISOString(), null, NOW)).toBe(
			'3h 12m'
		);
	});
	// SHADOW PATHS.
	it("returns '—' when the start time is absent or unparseable", () => {
		expect(elapsed(null, null, NOW)).toBe('—');
		expect(elapsed(undefined, null, NOW)).toBe('—');
		expect(elapsed('', null, NOW)).toBe('—');
		expect(elapsed('bad', null, NOW)).toBe('—');
	});
	it("clamps a negative span (end before start, or bad end) to '0s'", () => {
		const start = at(0);
		expect(elapsed(start, new Date(NOW - 10_000).toISOString(), NOW)).toBe('0s');
		// A bad end on a row that HAS one falls back to now (honest "still open") → 0s here.
		expect(elapsed(at(0), 'bad-end', NOW)).toBe('0s');
	});
});

describe('absoluteTime', () => {
	it('returns a non-empty locale string for a valid timestamp', () => {
		expect(absoluteTime(at(0))).not.toBe('');
	});
	it("returns '' (omit the title) for nil / empty / unparseable input", () => {
		expect(absoluteTime(null)).toBe('');
		expect(absoluteTime(undefined)).toBe('');
		expect(absoluteTime('')).toBe('');
		expect(absoluteTime('nope')).toBe('');
	});
});
