// TASK 3.3 — UX-inspection repo (db-backed; reuses the §4.9 security_finding table;
// D-015 soft-archive, D-016). OPT-IN + NON-BLOCKING.
//
// UX-inspection findings ARE security findings on the Maintain surface, so they share the
// `security_finding` table (UI-SPEC §207 rollup) — exactly like dependency findings. THIS
// module owns the persist + read path: it runs the pure inspectUx() detector over an
// injected UxInspectionSource (a real Playwright run, or a mocked snapshot in tests — the
// detector never touches the browser/network), then writes one row per finding via the SAME
// writeFindings() the security + dependency scans use, namespaced under the `ux.` rule
// family so the §4.9 schema is unchanged.
//
// OPT-IN (D-004 / ARCHITECTURE §2.7 "opt-in, periodic"): inspection only runs when the
// caller explicitly enables it via `opts.enabled` — disabled is the default and a no-op.
//
// NON-BLOCKING: `inspectProjectUx` returns IMMEDIATELY with a handle; the actual
// inspect+persist runs as a detached background job (fire-and-forget, mirrors the D-017
// maintenance trigger). The active Claude Code session is NEVER awaited on or stalled by an
// inspection — periodic UX inspection is best-effort background hygiene, not a gate. Callers
// who want to observe completion (tests, a manual run) await the returned `done` promise.
//
// Scoped soft-archive (D-015): re-inspecting a project archives only the stale ACTIVE
// `ux.*` findings (NOT the security or dependency findings), then inserts the fresh batch —
// so a UX re-run, a dep re-scan, and a security re-scan never clobber each other.
//
// Boundary discipline (D-016): every VALUE binds via $param (StringRecordId for the
// `project` record link); the rule prefix is a server-owned constant, never user input.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { inspectUx, type UxInspectionSource, type UxFinding } from './ux-inspect';
import { writeFindings, type FindingRow } from './findings-repo';
import { withScanLock } from './scan-lock';

/** Validate a `table:id` link string at the D-016 chokepoint, wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Soft-archive (D-015) every ACTIVE *ux* finding for a project — never DELETE, and never
 * touch the security or dependency findings. Used before a re-inspection so superseded UX
 * rows drop off the live view while history (and the other finding families) survive. The
 * `string::starts_with` predicate scopes the archive to the `ux.` rule family.
 */
export async function archiveActiveUxFindings(
	db: Db,
	projectId: string,
	reason = 're-inspected'
): Promise<number> {
	const project = link(projectId);
	const [rows] = await db.query<[unknown[]]>(
		`UPDATE security_finding
		   SET status = "archived", archived_at = time::now(), archive_reason = $reason
		 WHERE project = $project
		   AND string::starts_with(rule, "ux.")
		   AND (status = "active" OR status IS NONE)
		 RETURN BEFORE;`,
		{ project, reason }
	);
	return rows.length;
}

export interface InspectUxOptions {
	/**
	 * OPT-IN switch (D-004): inspection runs ONLY when true. Default/false = no-op (the
	 * background job resolves immediately with `[]`, writing nothing). This is what makes
	 * UX inspection opt-in + periodic rather than always-on.
	 */
	enabled: boolean;
	/** The inspection seam — a real Playwright run, or a mocked snapshot source in tests. */
	source: UxInspectionSource;
}

/** Handle returned by the non-blocking entry: `done` resolves when the bg job finishes. */
export interface InspectUxHandle {
	/** True if inspection was opted-in (else it was a no-op). */
	started: boolean;
	/** Resolves with the persisted rows (or `[]` if not started). NEVER rejects. */
	done: Promise<FindingRow[]>;
}

/**
 * Run the inspect+archive+persist work for one project. Awaitable; used internally by the
 * non-blocking entry and directly by callers that genuinely want to block (e.g. a manual
 * "inspect now" action). Scoped-soft-archives stale active `ux.*` findings, then persists
 * the fresh batch via the shared writeFindings(). F-008: every row is a real check of a
 * real inspector snapshot.
 *
 * SCN-1: the inspect+persist runs under the per-(project,'ux') single-flight lock so two
 * concurrent UX inspections of the same project (e.g. two page loads racing the detached
 * background job) cannot both archive-then-insert into ONE active set — the second serializes
 * behind the first (withScanLock). The lock key is family-scoped, so a concurrent security or
 * dependency scan of the same project is UNAFFECTED.
 */
export async function runUxInspection(
	db: Db,
	projectId: string,
	source: UxInspectionSource
): Promise<FindingRow[]> {
	return withScanLock('ux', projectId, async () => {
		const findings: UxFinding[] = inspectUx(source);
		await archiveActiveUxFindings(db, projectId);
		// UxFinding extends SecurityFinding — writeFindings persists the shared columns
		// (rule/severity/file/line/detail). The route rides in `file`; the §4.9 schema is
		// unchanged (UX findings are security findings on the surface).
		return writeFindings(db, projectId, findings);
	});
}

/**
 * The OPT-IN, NON-BLOCKING entry. Returns IMMEDIATELY with a handle; if `opts.enabled` the
 * inspect+persist runs as a detached background job so the active session is never stalled
 * (periodic UX inspection is best-effort background hygiene — never a gate). If disabled it
 * is a pure no-op. The background job swallows its own errors (it must never crash the
 * server or surface into a session), resolving `[]` on failure. Await `handle.done` only
 * when you specifically want completion (tests / a manual run).
 */
export function inspectProjectUx(
	db: Db,
	projectId: string,
	opts: InspectUxOptions
): InspectUxHandle {
	if (!opts.enabled) {
		return { started: false, done: Promise.resolve([]) };
	}
	// Fire-and-forget: defer the ENTIRE job (including the synchronous inspectUx snapshot
	// read) to a microtask so this function returns to the caller FIRST — the active session
	// keeps running and is never stalled by the inspection, browser, or DB writes. Errors are
	// contained: a failed background inspection must never throw into the caller or the session.
	const done = Promise.resolve()
		.then(() => runUxInspection(db, projectId, opts.source))
		.catch((err) => {
			console.error(`[ux-inspect] background inspection failed for ${projectId}:`, err);
			return [] as FindingRow[];
		});
	return { started: true, done };
}
