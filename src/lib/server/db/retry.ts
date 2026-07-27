// Bounded retry for the ONE SurrealDB fault the database itself labels retryable.
//
// SurrealDB is optimistically concurrent: when two writers reach commit together, one loses
// with `The query was not executed due to a failed transaction. Failed to commit transaction
// due to a read or write conflict. This transaction can be retried`. That is not a defect in
// the losing caller — the DB is telling us to try again. Left unretried it surfaces as a
// ROTATING RED: whichever concurrent writer is unlucky on a given run explodes, so a
// different file fails each time and no single fix ever looks like the cause.
//
// House rule (CLAUDE.md §3, F-014/F-048): a conflict on a write path is absorbed as a
// no-op-retry, never a crash. This module is the single owner of that classification so the
// matcher cannot drift between call sites.
//
// SAFETY: retrying is only correct for an IDEMPOTENT operation (deterministic ids + UPSERT,
// or a DELETE). Callers must be idempotent-by-construction; the helper does not make them so.
// Bounded (F-014): a fixed attempt count with linear backoff, then the last error re-raises —
// never an unbounded spin.

/**
 * Is this the commit-race conflict SurrealDB itself says can be retried?
 *
 * Deliberately NARROW — only the phrases the DB emits for that specific fault (the same
 * matcher shape as the production ones in `memory/file-snapshot.ts` and `create/execute.ts`).
 * Anything else is a real error and must re-raise (F-008: never swallow a fault we cannot name).
 */
export function isRetryableConflict(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /failed transaction|read or write conflict|can be retried/i.test(msg);
}

/**
 * Run `fn`, retrying ONLY {@link isRetryableConflict} faults, at most `attempts` times with a
 * linear backoff (`baseDelayMs * attemptIndex`). Any other error propagates on the first throw.
 * When every attempt loses the race the LAST conflict is re-raised, so an exhausted retry is
 * still an honest, named failure rather than silence.
 */
export async function retryOnConflict<T>(
	fn: () => Promise<T>,
	attempts = 5,
	baseDelayMs = 25
): Promise<T> {
	if (attempts < 1) throw new Error(`retryOnConflict: attempts must be >= 1 (got ${attempts})`);
	let last: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			if (!isRetryableConflict(err)) throw err;
			last = err;
			if (attempt < attempts - 1) {
				await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
			}
		}
	}
	throw last;
}
