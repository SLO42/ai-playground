// TASK 3.1 — security_finding repo (db-backed; DATA-MODEL §4.9; D-015 soft-archive, D-016).
//
// THIS module owns the persistence + read path for `security_finding`: it runs the
// pure scanSecurity() detector over a path-confined project dir (reusing scanner/
// registry confineToRoot — D-018) and writes one row per finding, then serves them
// back grouped by severity for the Maintain surface (UI-SPEC §162/§190/§207).
//
// Boundary discipline (D-016): every VALUE binds via $param — never interpolated; the
// only interpolated tokens are validated record ids / table names. The `project` field
// is a `record<project>` link → bound as StringRecordId (a bare string in CONTENT would
// be rejected by the SCHEMAFULL field). Optional fields are OMITTED, never NULL (§6.1).
//
// Append-only soft-archive (D-015): findings are never DELETEd — re-scanning a project
// archives the stale active rows (status="archived"), then inserts the fresh ones, so
// history is preserved and live reads filter `(status = "active" OR status IS NONE)`.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { confineToRoot } from './registry';
import { scanSecurity, type SecurityFinding, type Severity } from './security';
import { withScanLock } from './scan-lock';

/** A persisted `security_finding` row (SDK RecordId/Date coerced to plain JSON). */
export interface FindingRow {
	id: string;
	project?: string;
	rule: string;
	severity: Severity;
	file?: string;
	line?: number;
	detail?: string;
	status: string;
	at: string;
}

/** Validate a `table:id` link string at the D-016 chokepoint, wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** Coerce SDK RecordId/Date shapes into plain JSON for loaders + tests. */
function normFinding(row: FindingRow & { id: unknown; project?: unknown; at?: unknown }): FindingRow {
	return {
		...row,
		id: String(row.id),
		project: row.project != null ? String(row.project) : undefined,
		at: row.at != null ? String(row.at) : ''
	};
}

/**
 * Persist a batch of findings for a project. Each row links to `projectId` and defaults
 * to status="active" (the SCHEMAFULL DEFAULT fires). Optional fields are omitted so the
 * `option<…>` columns stay NONE rather than being rejected as NULL (§6.1). Returns the
 * persisted rows. NO secret value is stored (the detector already redacts `detail`).
 */
export async function writeFindings(
	db: Db,
	projectId: string,
	findings: SecurityFinding[]
): Promise<FindingRow[]> {
	const project = link(projectId); // validates project:<slug> at the chokepoint
	const out: FindingRow[] = [];
	for (const f of findings) {
		const content = {
			project,
			rule: f.rule,
			severity: f.severity,
			...(f.file ? { file: f.file } : {}),
			...(Number.isFinite(f.line) ? { line: f.line } : {}),
			...(f.detail ? { detail: f.detail } : {})
		};
		const [rows] = await db.query<[(FindingRow & { id: unknown })[]]>(
			`CREATE security_finding CONTENT $content RETURN AFTER;`,
			{ content }
		);
		if (rows[0]) out.push(normFinding(rows[0]));
	}
	return out;
}

/**
 * Soft-archive (D-015) every ACTIVE finding for a project — never DELETE. Used before a
 * re-scan so superseded findings drop off the live view while history survives. The
 * `at`/status semantics mirror the `memory` soft-archive (DATA-MODEL §4.9 note).
 */
export async function archiveActiveFindings(
	db: Db,
	projectId: string,
	reason = 're-scanned'
): Promise<number> {
	const project = link(projectId);
	const [rows] = await db.query<[unknown[]]>(
		`UPDATE security_finding
		   SET status = "archived", archived_at = time::now(), archive_reason = $reason
		 WHERE project = $project AND (status = "active" OR status IS NONE)
		 RETURN BEFORE;`,
		{ project, reason }
	);
	return rows.length;
}

/**
 * List the LIVE (active) findings for one project, sorted critical→low then file/line.
 * Applies the D-015 soft-archive read-guard `(status = "active" OR status IS NONE)` so
 * archived/superseded rows never surface on the Maintain panel.
 */
export async function listFindings(db: Db, projectId: string): Promise<FindingRow[]> {
	const project = link(projectId);
	const [rows] = await db.query<[(FindingRow & { id: unknown })[]]>(
		`SELECT * FROM security_finding
		 WHERE project = $project AND (status = "active" OR status IS NONE)
		 ORDER BY at DESC;`,
		{ project }
	);
	return rows.map(normFinding).sort(bySeverityThenLocation);
}

/**
 * List ALL live findings across every project (the global Maintain rollup — UI-SPEC §207
 * / §315). Same D-015 read-guard. Sorted critical→low then file/line.
 */
export async function listAllFindings(db: Db): Promise<FindingRow[]> {
	const [rows] = await db.query<[(FindingRow & { id: unknown })[]]>(
		`SELECT * FROM security_finding
		 WHERE (status = "active" OR status IS NONE)
		 ORDER BY at DESC;`
	);
	return rows.map(normFinding).sort(bySeverityThenLocation);
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

function bySeverityThenLocation(a: FindingRow, b: FindingRow): number {
	const sv = (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
	if (sv !== 0) return sv;
	const f = (a.file ?? '').localeCompare(b.file ?? '');
	return f !== 0 ? f : (a.line ?? 0) - (b.line ?? 0);
}

export interface ScanSecurityOptions {
	/** Confinement root (CODE_ROOT). The scan target must resolve under this (D-018). */
	codeRoot: string;
}

/**
 * The one orchestrating entry: path-confine `dir` under CODE_ROOT (reusing the scanner's
 * confineToRoot — symlink + `..` resolved BEFORE the prefix check, fail-closed, D-018),
 * run the pure detector, soft-archive any stale active findings, and persist the fresh
 * batch linked to `projectId`. Idempotent: re-scanning replaces the live set without
 * losing history. Returns the freshly-written rows. (F-008: every row is a real scan
 * result — nothing fabricated.)
 *
 * SCN-1: the scan+persist runs under the per-(project,'security') single-flight lock so two
 * concurrent security scans of the same project cannot both archive-then-insert into ONE active
 * set — the second serializes behind the first (withScanLock). Path confinement (D-018) runs
 * BEFORE the lock so a bad path fails fast without queuing.
 */
export async function scanProjectSecurity(
	db: Db,
	projectId: string,
	dir: string,
	opts: ScanSecurityOptions
): Promise<FindingRow[]> {
	const rootPath = confineToRoot(dir, opts.codeRoot);
	return withScanLock('security', projectId, async () => {
		const findings = scanSecurity(rootPath);
		await archiveActiveFindings(db, projectId);
		return writeFindings(db, projectId, findings);
	});
}
