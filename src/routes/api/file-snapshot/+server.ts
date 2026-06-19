// FILE-SNAPSHOT-SPEC §4 (FS-3) — the view-file READ endpoint.
//
// GET /api/file-snapshot?id=file_snapshot:<id>
// GET /api/file-snapshot?path=<project-relative>&project=project:<slug>
//
// The FileSnapshotViewer fetches HERE to resolve a file reference (a finding's file:line, a
// transcript turn's path, a project tree entry) to its stored point-in-time snapshot. Read-only,
// loopback (D-025); every value binds via the server-side query module's $params (D-016 — the path
// is normalized/confined, the ids validated). Returns:
//
//   • 200 { snapshot }            — the F-013-normalized row (datetime → ISO; a marker body is
//                                   returned AS the stored marker, never un-withheld, D-026).
//   • 200 { snapshot: null }      — HONEST EMPTY: a well-formed reference with nothing captured yet
//                                   (the viewer shows "no snapshot captured"). A miss is NOT a 404 —
//                                   the reference is valid, there simply is no snapshot (F-008).
//   • 400                         — a malformed/escaping path or a malformed id (NAMED, pre-DB).
//   • 503                         — the DB is not connected (honest, never a fabricated body).
//
// EVERY ERROR HAS A NAME: a path that fails D-016 (SnapshotPathError) and a malformed id
// (IdentifierError) are caught and surfaced as a 400 with the concrete reason — never a 500 silence.

import { json, error } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { IdentifierError } from '$lib/server/db/validate';
import {
	getLatestSnapshotByPath,
	getSnapshotById
} from '$lib/server/memory/file-snapshot-query';
import { SnapshotPathError } from '$lib/server/memory/file-snapshot';
import { getProject } from '$lib/server/projects';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const db = tryGetDb();
	if (!db) throw error(503, 'database not connected');

	const id = url.searchParams.get('id');
	const path = url.searchParams.get('path');
	const project = url.searchParams.get('project') ?? undefined;

	// Exactly one of (id) | (path) must be supplied — an honest 400 otherwise.
	if (id && path) {
		throw error(400, 'supply either id or path, not both');
	}
	if (!id && !path) {
		throw error(400, 'a snapshot id or a file path is required');
	}

	try {
		if (id) {
			const snapshot = await getSnapshotById(db, id);
			return json({ snapshot });
		}
		// A project-scoped lookup resolves the project's on-disk root so an ABSOLUTE path (a
		// transcript tool turn) relativizes to the stored project-relative key. A bad/foreign project
		// id throws IdentifierError below → a NAMED 400; an unknown project → no root → an absolute
		// path is an honest miss (a relative path still resolves project-scoped).
		let projectRoot: string | undefined;
		if (project) {
			const proj = await getProject(db, project);
			projectRoot = proj?.root_path ?? undefined;
		}
		const snapshot = await getLatestSnapshotByPath(db, {
			path: path as string,
			project,
			projectRoot
		});
		return json({ snapshot });
	} catch (err) {
		// NAMED boundary errors → 400 (the reference is malformed, not the server). D-016: a path
		// that escapes the project root or a foreign-table id is a client mistake, surfaced honestly.
		if (err instanceof SnapshotPathError || err instanceof IdentifierError) {
			throw error(400, err.message);
		}
		// Anything else (a real DB fault) propagates as a 500 with its own name — never masked.
		throw err;
	}
};
