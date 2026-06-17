import { describe, it, expect } from 'vitest';
import {
	BANNED_SYCOPHANCY_PHRASES,
	scanForSycophancy,
	hasSycophancy,
	assertNoSycophancy,
	SycophancyError
} from './anti-sycophancy';

// CA-1 (CREATE-SPEC §3) — the anti-sycophancy banned-phrase SINGLE SOURCE + detector. Pure
// module, no DB. Covers: the canonical list, the four shadow paths (nil/empty/clean/dirty),
// case + apostrophe + whitespace tolerance, multi-hit reporting, and the named assert error.

describe('BANNED_SYCOPHANCY_PHRASES — the single source', () => {
	it('contains the five CREATE-SPEC §3 phrases and is frozen', () => {
		expect(BANNED_SYCOPHANCY_PHRASES).toContain('that is an interesting approach');
		expect(BANNED_SYCOPHANCY_PHRASES).toContain('there are many ways to think about this');
		expect(BANNED_SYCOPHANCY_PHRASES).toContain('you might want to consider');
		expect(BANNED_SYCOPHANCY_PHRASES).toContain('that could work');
		expect(BANNED_SYCOPHANCY_PHRASES).toContain('i can see why you would think that');
		expect(BANNED_SYCOPHANCY_PHRASES.length).toBe(5);
		expect(Object.isFrozen(BANNED_SYCOPHANCY_PHRASES)).toBe(true);
	});
});

describe('scanForSycophancy — shadow paths', () => {
	it('nil input → clean (no throw)', () => {
		expect(scanForSycophancy(undefined)).toEqual({ clean: true, hits: [] });
		expect(scanForSycophancy(null)).toEqual({ clean: true, hits: [] });
	});
	it('empty / whitespace-only → clean', () => {
		expect(scanForSycophancy('').clean).toBe(true);
		expect(scanForSycophancy('   \n\t ').clean).toBe(true);
	});
	it('a position-taking sentence with no banned phrase → clean', () => {
		const ok =
			'A single package will not work if you expect independent release cadences — split then.';
		expect(scanForSycophancy(ok).clean).toBe(true);
		expect(hasSycophancy(ok)).toBe(false);
	});
});

describe('scanForSycophancy — detection', () => {
	it('catches a banned phrase regardless of case', () => {
		const scan = scanForSycophancy('That Is An Interesting Approach, but consider the tradeoffs.');
		expect(scan.clean).toBe(false);
		expect(scan.hits[0].phrase).toBe('that is an interesting approach');
	});

	it('tolerates curly apostrophes and contractions ("you’d" / "that’s")', () => {
		expect(hasSycophancy('I can see why you’d think that')).toBe(true);
		expect(hasSycophancy("I can see why you'd think that")).toBe(true);
	});

	it('is insensitive to internal whitespace runs and newlines', () => {
		expect(hasSycophancy('you   might\n want  to   consider X')).toBe(true);
	});

	it('reports EVERY hit, in stable position order', () => {
		const text = 'You might want to consider X. That could work. You might want to consider Y.';
		const scan = scanForSycophancy(text);
		expect(scan.hits.length).toBe(3);
		// positions strictly increasing.
		expect(scan.hits[0].index).toBeLessThan(scan.hits[1].index);
		expect(scan.hits[1].index).toBeLessThan(scan.hits[2].index);
		const phrases = scan.hits.map((h) => h.phrase);
		expect(phrases).toContain('you might want to consider');
		expect(phrases).toContain('that could work');
	});
});

describe('assertNoSycophancy', () => {
	it('empty array → no-op (vacuously clean)', () => {
		expect(() => assertNoSycophancy([])).not.toThrow();
	});
	it('nil / empty members → skipped', () => {
		expect(() => assertNoSycophancy([undefined, null, '', 'this is fine'])).not.toThrow();
	});
	it('throws a NAMED SycophancyError listing the distinct offending phrases', () => {
		let err: unknown;
		try {
			assertNoSycophancy(['that could work', 'clean text', 'you might want to consider Z']);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(SycophancyError);
		const se = err as SycophancyError;
		expect(se.name).toBe('SycophancyError');
		expect(se.hits.length).toBe(2);
		expect(se.message).toContain('that could work');
		expect(se.message).toContain('you might want to consider');
	});
});
