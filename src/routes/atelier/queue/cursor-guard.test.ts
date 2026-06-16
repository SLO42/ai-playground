// BL-8/BL-9 fix regression — /atelier/queue ?before= cursor guard (validCursor).
//
// DEFECT (live-reproduced): the cursor guard validated ISO SHAPE only, so a shape-valid but
// CALENDAR-INVALID date (e.g. 2024-99-99T00:00:00.000Z) passed the regex, reached the
// `<datetime>$before` cast in queue-monitor, and THREW inside SurrealDB. The loader's catch then
// painted the 'disconnected' error card with a raw engine 'Expected...' string on a HEALTHY DB —
// an F-008 honest-state lie. Fix: validCursor also drops the cursor when
// Number.isNaN(new Date(raw).getTime()) (mirrors the +page.svelte fmtTime guard).
//
// Offline/pure — no DB, no server. Asserts the guard returns undefined (⇒ no cursor ⇒ never
// reaches the cast) for the invalid-date hole, while real ISO timestamps still pass through.

import { describe, it, expect } from 'vitest';
import { _validCursor as validCursor } from './+page.server';

describe('validCursor — ?before= cursor guard', () => {
	it('drops a shape-valid but CALENDAR-INVALID date (the live-reproduced hole) ⇒ undefined', () => {
		// This exact value reached <datetime>$before and threw before the fix.
		expect(validCursor('2024-99-99T00:00:00.000Z')).toBeUndefined();
		expect(validCursor('2024-13-01T00:00:00.000Z')).toBeUndefined();
		expect(validCursor('2024-02-30T25:61:61.000Z')).toBeUndefined();
	});

	it('accepts a real ISO timestamp (with Z and with numeric offset)', () => {
		expect(validCursor('2024-06-16T12:34:56.000Z')).toBe('2024-06-16T12:34:56.000Z');
		expect(validCursor('2026-01-02T03:04:05.678+02:00')).toBe('2026-01-02T03:04:05.678+02:00');
	});

	it('rejects malformed / SQL-ish / empty input ⇒ undefined (shape regex)', () => {
		expect(validCursor(null)).toBeUndefined();
		expect(validCursor('')).toBeUndefined();
		expect(validCursor(';DROP TABLE work_item;')).toBeUndefined();
		expect(validCursor('not-a-date')).toBeUndefined();
		expect(validCursor('2024-06-16')).toBeUndefined(); // date only, no time component
	});
});
