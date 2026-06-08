// server/db — DB error classifier (TASK 6.11; D-019 honesty).
//
// A cached runtime Db handle can go DEAD mid-session (the SurrealDB process is
// killed, the socket drops). The SDK still hands back the handle, so `tryGetDb()`
// returns non-null, and any subsequent query throws a CONNECTION-LOSS error rather
// than a real query failure. Loaders that distinguish "disconnected" from "query
// failed" must classify that thrown error correctly — otherwise a genuine
// connection loss is mislabeled as "connected / query failed" (the 6.11 defect).
//
// This is the SINGLE shared place that decision lives, so every surface
// (/workflows, /projects, home) behaves uniformly (D-019).

/** What a thrown DB error actually means for the UI's connected/disconnected split. */
export type DbErrorKind = 'disconnected' | 'query-error';

// Connection-loss fingerprints the surrealdb 2.x SDK / the OS surface when the
// underlying socket is gone. Matches the SDK's own "must be connected" guard,
// Windows connect-timeout (os error 10060), socket/closed wording, and the common
// node econn/reset families. Everything else is a true query/parse/validation error.
const DISCONNECTED_RE =
	/must be connected|not connected|connection (?:closed|lost|refused)|os error 10060|socket (?:closed|hang ?up)|\bECONN(?:REFUSED|RESET|ABORTED)?\b|\bclosed\b/i;

/**
 * Classify a thrown DB error as connection-loss vs a true query error.
 *
 * @returns `'disconnected'` for a dead/lost connection (treat as DISCONNECTED, the
 *   same honest state as a server that booted with the DB down), or `'query-error'`
 *   for any genuine query/parse/validation failure while the connection is live.
 */
export function classifyDbError(err: unknown): DbErrorKind {
	const message =
		err instanceof Error
			? err.message
			: typeof err === 'string'
				? err
				: String((err as { message?: unknown })?.message ?? err ?? '');
	return DISCONNECTED_RE.test(message) ? 'disconnected' : 'query-error';
}

/** Convenience predicate: true when the thrown error is a connection loss. */
export function isDisconnectError(err: unknown): boolean {
	return classifyDbError(err) === 'disconnected';
}
