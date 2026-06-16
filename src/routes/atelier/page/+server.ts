// GET /atelier/page — G-C pagination endpoint (GLOBAL-TRANSCRIPT-SPEC §6.3). Returns ONE older
// page of the merged atelier timeline for the client's "load older" scrollback (bounded — never
// an unbounded scan). Query: ?project=<id>&before=<iso>&size=<n>. Honest: DB down → 503; a bad
// scope id → 400 (named, not a masked 500); a per-source failure → a PARTIAL page (complete:false,
// failedSources named) with HTTP 200 (the page still loaded what it could — F-008).
//
// Read-only; the body content is already screened+fenced at the source (D-026) — this endpoint
// does not unscreen or re-introduce raw bodies.

import { json, error } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { IdentifierError } from '$lib/server/db/validate';
import { readAtelierTimeline, readInbox, isInboxStatus, type TimelineScope } from '$lib/server/atelier';
import type { RequestHandler } from './$types';

const PROJECT_ID = /^project:[A-Za-z0-9_]+$/;

export const GET: RequestHandler = async ({ url }) => {
	const db = tryGetDb();
	if (!db) throw error(503, 'database not connected');

	const lens = url.searchParams.get('lens') === 'inbox' ? 'inbox' : 'timeline';
	const rawProject = url.searchParams.get('project');
	const scope: TimelineScope =
		rawProject && PROJECT_ID.test(rawProject)
			? { kind: 'project', project: rawProject }
			: { kind: 'global' };
	// A non-empty `project` that is NOT a legal id is a client bug — 400, never a silent global page.
	if (rawProject && rawProject.length > 0 && scope.kind === 'global') {
		throw error(400, 'invalid project scope id');
	}

	const before = url.searchParams.get('before');
	const rawSize = Number(url.searchParams.get('size'));
	const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : undefined;

	try {
		if (lens === 'inbox') {
			const rawStatus = url.searchParams.get('status');
			const status = isInboxStatus(rawStatus) ? rawStatus : null;
			const inbox = await readInbox(db, {
				scope,
				status,
				...(before ? { before } : {}),
				...(pageSize ? { pageSize } : {})
			});
			return json(inbox);
		}
		const page = await readAtelierTimeline(db, {
			scope,
			...(before ? { before } : {}),
			...(pageSize ? { pageSize } : {})
		});
		return json(page);
	} catch (err) {
		if (err instanceof IdentifierError) throw error(400, 'invalid scope id');
		if (err && typeof err === 'object' && 'status' in err) throw err;
		throw error(500, (err as Error).message);
	}
};
