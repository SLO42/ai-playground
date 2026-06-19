// FILE-SNAPSHOT-SPEC §4 (FS-3) — the read side of the view-file surface.
//
// FS-1 captured + content-addressed file_snapshot rows; FS-2 linked them at the three capture
// points (scaffold / transcript turn / finding). This module is the single server-side READER the
// FS-3 surface (the /api/file-snapshot endpoint + the FileSnapshotViewer) goes through to RESOLVE a
// file reference to its stored snapshot. It owns two honest lookups + reuses the FS-1 normalizer so
// every row that reaches the client is the F-013-safe shape (datetime → ISO, no str(undefined)):
//
//   • getLatestSnapshotByPath(db, {path, project?}) — the primary surface lookup: given a file
//     REFERENCE (a finding's `file`, a transcript turn's project-relative path), return the MOST
//     RECENT snapshot captured for that (project, path). "Most recent" = newest captured_at: a file
//     read 50× dedups to one row, but an EDITED file has several content-addressed rows over time —
//     we show the latest as-of, the honest "what it most recently was" (F-008; the surface still
//     labels it may-be-stale, disk is truth). Returns null when nothing was ever captured (honest
//     empty — "no snapshot captured yet", never a fabricated body).
//   • getSnapshotById(db, id) — exact-row lookup by `file_snapshot:<id>` (a caller that already holds
//     the linked row id, e.g. a future captured_by-keyed surface). Returns null on a miss.
//
// Rails: D-016 — the `path` is normalized + confined through the SAME normalizeSnapshotPath the
// capture side uses (a hostile/escaping path is rejected BEFORE any query, SnapshotPathError); the
// `project`/`id` are validated record ids bound as $params (never interpolated). F-008 — a miss is
// an honest null, never an invented row. The body is whatever was STORED (a marker for a
// quarantined/oversize/binary snapshot — the reader never un-withholds content, D-026).

import { isAbsolute } from 'node:path';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordIdOfTable } from '../db/validate';
import { projectRelativePath } from './file-snapshot-capture';
import {
	normalizeSnapshotPath,
	normFileSnapshot,
	type FileSnapshotRow
} from './file-snapshot';

/** Inputs for the path-based surface lookup (the finding/transcript reference resolver). */
export interface SnapshotByPathInput {
	/** The file path referenced. A project-relative path (a finding's `file`) is used as-is; an
	 *  ABSOLUTE path (a transcript tool turn) is relativized against {@link projectRoot} first. */
	path: string;
	/** The owning `project:<slug>` id when the reference is project-scoped (most are). Optional. */
	project?: string;
	/** The project's on-disk root — supplied so an ABSOLUTE `path` can be relativized to the stored
	 *  project-relative dedup key (mirrors the FS-2 capture side). Optional; a relative path ignores
	 *  it. When an absolute path is NOT under this root, the lookup is an honest miss (null), not an
	 *  escaping query (D-016). */
	projectRoot?: string;
}

/**
 * Resolve a file REFERENCE to its most-recently-captured snapshot (FILE-SNAPSHOT-SPEC §4).
 *
 * Sequence: (1) D-016 — normalize + confine the path (throws SnapshotPathError on an absolute/
 * escaping path, BEFORE any DB touch); (2) bind the optional project as a validated record link;
 * (3) SELECT the newest captured_at row for (path, project) — ORDER BY captured_at DESC LIMIT 1.
 *
 * The project split mirrors the capture-side dedup: a project-less reference matches `project IS
 * NONE` (a NULL bind would never equal a NONE column). Returns the F-013-normalized row, or null
 * when no snapshot was ever captured for this reference (honest empty — the surface shows "no
 * snapshot captured yet", NEVER a fabricated body, F-008).
 *
 * Shadow paths: nil/empty path → SnapshotPathError (named, pre-DB); an escaping path → same;
 * no row → null (honest); an upstream DB error → propagates with its own name (never swallowed).
 */
export async function getLatestSnapshotByPath(
	db: Db,
	input: SnapshotByPathInput
): Promise<FileSnapshotRow | null> {
	// 0. An ABSOLUTE path (a transcript tool turn) is relativized against the project root FIRST —
	// the SAME coercion FS-2 used on capture, so the dedup key matches. A path outside the root →
	// projectRelativePath returns null → an honest miss (no escaping query, D-016). A relative path
	// is left as-is for normalizeSnapshotPath to confine.
	let refPath = input.path;
	if (typeof refPath === 'string' && isAbsolute(refPath)) {
		if (!input.projectRoot) return null; // an absolute ref with no root cannot be resolved — honest miss.
		const rel = projectRelativePath(refPath, input.projectRoot);
		if (rel == null) return null; // outside the project root — honest "no snapshot" (never escape).
		refPath = rel;
	}

	// 1. D-016 — normalize + confine (SnapshotPathError on escape, before any query).
	const path = normalizeSnapshotPath(refPath);

	// 2. Optional project → a validated `project:<slug>` record link bound as a $param.
	const projectRid =
		input.project != null && input.project !== ''
			? new StringRecordId(assertRecordIdOfTable(input.project, 'project'))
			: null;

	// 3. Newest snapshot for (path, project). The IS NONE / = $project split keeps the match exact.
	const surql = projectRid
		? `SELECT * FROM file_snapshot
			 WHERE path = $path AND project = $project
			 ORDER BY captured_at DESC LIMIT 1;`
		: `SELECT * FROM file_snapshot
			 WHERE path = $path AND project IS NONE
			 ORDER BY captured_at DESC LIMIT 1;`;

	const [rows] = await db.query<[Record<string, unknown>[]]>(surql, {
		path,
		...(projectRid ? { project: projectRid } : {})
	});
	if (!rows || rows.length === 0) return null;
	return normFileSnapshot(rows[0]);
}

/**
 * Resolve a `file_snapshot:<id>` to its exact stored row (FILE-SNAPSHOT-SPEC §4) — for a caller that
 * already holds the linked row id. The id is validated to the file_snapshot table at the boundary
 * (D-016) and bound as a record link. Returns the F-013-normalized row, or null on a miss (honest;
 * a stale/dangling link reads as "no snapshot", never an invented one).
 *
 * Shadow paths: a malformed/foreign-table id → throws at assertRecordIdOfTable (named, pre-DB);
 * no row → null; an upstream DB error → propagates with its own name.
 */
export async function getSnapshotById(db: Db, id: string): Promise<FileSnapshotRow | null> {
	const rid = new StringRecordId(assertRecordIdOfTable(id, 'file_snapshot'));
	const [rows] = await db.query<[Record<string, unknown>[]]>(
		`SELECT * FROM file_snapshot WHERE id = $id LIMIT 1;`,
		{ id: rid }
	);
	if (!rows || rows.length === 0) return null;
	return normFileSnapshot(rows[0]);
}
