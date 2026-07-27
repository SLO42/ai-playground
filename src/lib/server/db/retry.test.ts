// REGRESSION — the rotating-red class: a SurrealDB commit-race conflict that the DATABASE
// itself labels retryable was left unretried on write paths, so whichever concurrent writer
// lost the race on a given run exploded and killed a (different, each run) test file.
//
// The fault text below is the VERBATIM message SurrealDB raised in the failing runs — the
// deterministic repro the live race can never be. No test DB is needed: the contract under
// test is "retry THIS fault, re-raise everything else, stay bounded".

import { describe, it, expect } from 'vitest';
import { isRetryableConflict, retryOnConflict } from './retry';
import { clearTable } from './testserver';

/** Verbatim from the observed failures (surrealdb createServerError → InternalError). */
const CONFLICT =
	'The query was not executed due to a failed transaction. Failed to commit transaction ' +
	'due to a read or write conflict. This transaction can be retried';

describe('isRetryableConflict — narrow by design', () => {
	it('matches the exact commit-race message SurrealDB raised', () => {
		expect(isRetryableConflict(new Error(CONFLICT))).toBe(true);
	});

	it('matches when the driver hands back a non-Error value', () => {
		expect(isRetryableConflict(CONFLICT)).toBe(true);
	});

	it('does NOT match an unrelated failure (never swallow a fault we cannot name)', () => {
		expect(isRetryableConflict(new Error('Parse error: unexpected token at line 1'))).toBe(false);
		expect(isRetryableConflict(new Error('IAM error: Not enough permissions'))).toBe(false);
		expect(isRetryableConflict(new Error('There was a problem with the database: down'))).toBe(
			false
		);
	});
});

describe('retryOnConflict — bounded absorption of the retryable conflict', () => {
	it('retries past a conflict and returns the eventual value', async () => {
		let calls = 0;
		const out = await retryOnConflict(
			async () => {
				calls++;
				if (calls < 3) throw new Error(CONFLICT);
				return 'ok';
			},
			5,
			1
		);
		expect(out).toBe('ok');
		expect(calls).toBe(3);
	});

	it('does not retry at all when the first attempt succeeds', async () => {
		let calls = 0;
		await retryOnConflict(async () => void calls++, 5, 1);
		expect(calls).toBe(1);
	});

	it('re-raises a NON-retryable error immediately — no retry, no masking', async () => {
		let calls = 0;
		await expect(
			retryOnConflict(
				async () => {
					calls++;
					throw new Error('Parse error: unexpected token');
				},
				5,
				1
			)
		).rejects.toThrow(/Parse error/);
		expect(calls).toBe(1);
	});

	it('is BOUNDED (F-014): it gives up after `attempts` and re-raises the LAST conflict', async () => {
		let calls = 0;
		await expect(
			retryOnConflict(
				async () => {
					calls++;
					throw new Error(CONFLICT);
				},
				4,
				1
			)
		).rejects.toThrow(/can be retried/);
		expect(calls).toBe(4); // exactly the cap — never an unbounded spin
	});

	it('rejects a nonsensical attempt count instead of silently never running', async () => {
		await expect(retryOnConflict(async () => 1, 0)).rejects.toThrow(/attempts must be >= 1/);
	});
});

describe('clearTable — the suite-setup DELETE that used to lose the race', () => {
	it('absorbs a conflict and still clears the table', async () => {
		const seen: string[] = [];
		let calls = 0;
		const db = {
			query: async (sql: string) => {
				calls++;
				seen.push(sql);
				if (calls === 1) throw new Error(CONFLICT);
				return [];
			}
		};
		await clearTable(db, 'work_item', 5);
		expect(calls).toBe(2);
		expect(seen.every((s) => s === 'DELETE work_item;')).toBe(true);
	});

	it('re-raises a non-retryable error (a real bug is never hidden by the retry)', async () => {
		const db = {
			query: async () => {
				throw new Error('IAM error: Not enough permissions');
			}
		};
		await expect(clearTable(db, 'work_item', 3)).rejects.toThrow(/Not enough permissions/);
	});

	it('refuses an unsafe table identifier rather than interpolating it (D-016)', async () => {
		let called = false;
		const db = {
			query: async () => {
				called = true;
				return [];
			}
		};
		await expect(clearTable(db, 'work_item; DELETE session')).rejects.toThrow(
			/unsafe table identifier/
		);
		expect(called).toBe(false);
	});
});
