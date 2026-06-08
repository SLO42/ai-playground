// TASK 3.2 — dependency_finding repo (db-backed; reuses the §4.9 security_finding table;
// D-015 soft-archive, D-016, D-018).
//
// Dependency-health findings ARE security findings on the Maintain surface, so they share
// the `security_finding` table (UI-SPEC §207 rollup). THIS module owns the persist + read
// path: it runs the pure scanDependencies() detector over a path-confined project dir
// (reusing scanner/registry confineToRoot — D-018) against an injected AdvisorySource
// (offline/local, or a mocked registry in tests — the detector never touches the network),
// then writes one row per finding via the SAME writeFindings() the security scan uses.
//
// Scoped soft-archive (D-015): re-scanning a project archives only the stale ACTIVE
// `dependency.*` findings (NOT the security findings), then inserts the fresh batch — so a
// dep re-scan and a security re-scan don't clobber each other, history is preserved, and
// live reads filter `(status = "active" OR status IS NONE)`.
//
// Boundary discipline (D-016): every VALUE binds via $param (StringRecordId for the
// `project` record link); the rule prefix is a server-owned constant, never user input.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { confineToRoot } from './registry';
import { scanDependencies, type AdvisorySource, type DependencyFinding } from './dependencies';
import { writeFindings, type FindingRow } from './findings-repo';

/** Validate a `table:id` link string at the D-016 chokepoint, wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Soft-archive (D-015) every ACTIVE *dependency* finding for a project — never DELETE, and
 * never touch the security findings. Used before a re-scan so superseded dependency rows
 * drop off the live view while history (and the project's security findings) survive. The
 * `string::starts_with` predicate scopes the archive to the `dependency.` rule family.
 */
export async function archiveActiveDependencyFindings(
	db: Db,
	projectId: string,
	reason = 're-scanned'
): Promise<number> {
	const project = link(projectId);
	const [rows] = await db.query<[unknown[]]>(
		`UPDATE security_finding
		   SET status = "archived", archived_at = time::now(), archive_reason = $reason
		 WHERE project = $project
		   AND string::starts_with(rule, "dependency.")
		   AND (status = "active" OR status IS NONE)
		 RETURN BEFORE;`,
		{ project, reason }
	);
	return rows.length;
}

export interface ScanDependencyOptions {
	/** Confinement root (CODE_ROOT). The scan target must resolve under this (D-018). */
	codeRoot: string;
	/** Advisory lookup source (offline/local DB, or a mocked registry response in tests). */
	source: AdvisorySource;
}

/**
 * The one orchestrating entry: path-confine `dir` under CODE_ROOT (reusing the scanner's
 * confineToRoot — symlink + `..` resolved BEFORE the prefix check, fail-closed, D-018),
 * run the pure dependency detector against `opts.source`, scoped-soft-archive any stale
 * active dependency findings, and persist the fresh batch linked to `projectId` via the
 * shared writeFindings(). Idempotent: re-scanning replaces the live dependency set without
 * losing history or affecting security findings. Returns the freshly-written rows. The
 * advisory rides along in each row's `detail` (F-008: every row is a real comparison).
 */
export async function scanProjectDependencies(
	db: Db,
	projectId: string,
	dir: string,
	opts: ScanDependencyOptions
): Promise<FindingRow[]> {
	const rootPath = confineToRoot(dir, opts.codeRoot);
	const findings: DependencyFinding[] = scanDependencies(rootPath, opts.source);
	await archiveActiveDependencyFindings(db, projectId);
	// DependencyFinding extends SecurityFinding — writeFindings persists the shared columns
	// (rule/severity/file/line/detail). The advisory id/package live inside `detail`, so the
	// §4.9 schema is unchanged (dependency findings are security findings on the surface).
	return writeFindings(db, projectId, findings);
}
