// /atelier — G-C: the atelier-wide reasoning/actions/communications timeline
// (GLOBAL-TRANSCRIPT-SPEC §6.3). A READ-ONLY merged timeline across message / peer_message /
// panel_verdict / role_event, scoped GLOBAL or per-PROJECT, paginated (newest-first), live via
// the existing onDbChange SSE. Filters are SERVER-driven (read + validated from ?project=&size=)
// so the page reflects exactly the server's view. Degrades honestly (F-008 / D-019): DB down →
// connected:false + empty; a failing source → a PARTIAL timeline (complete:false), never zero-
// dressed-as-real and never a thrown page.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { readAtelierTimeline, type TimelinePage, type TimelineScope } from '$lib/server/atelier';
import { listProjects } from '$lib/server/projects/repo';
import type { PageServerLoad } from './$types';

/** Project option for the scope dropdown (id + display name). */
export interface ProjectOption {
	id: string;
	name: string;
}

export interface AtelierData {
	connected: boolean;
	/** The active scope echoed back (the UI reflects the server's view). */
	scope: TimelineScope;
	/** Project options for the scope toggle (real, from the DB). */
	projectOptions: ProjectOption[];
	/** The first (newest) page of the merged timeline. */
	page: TimelinePage;
	error?: string;
}

/** A legal project record-id link (mirrors /reports' guard). Anything else ⇒ global scope. */
const PROJECT_ID = /^project:[A-Za-z0-9_]+$/;

function emptyPage(scope: TimelineScope): TimelinePage {
	return { complete: true, scope, entries: [], nextBefore: null, failedSources: [] };
}

export const load: PageServerLoad = async ({ depends, url }): Promise<AtelierData> => {
	// Live re-invalidation key (one SSE stream re-runs this loader — UI-SPEC §1.2). The
	// contributing tables are watched (watched-tables.ts) and the page subscribes to each below.
	depends('app:atelier');

	// ── Server-driven scope (read + validate from the URL query). ─────────────────────
	const rawProject = url.searchParams.get('project');
	const scope: TimelineScope =
		rawProject && PROJECT_ID.test(rawProject)
			? { kind: 'project', project: rawProject }
			: { kind: 'global' };
	const rawSize = Number(url.searchParams.get('size'));
	const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : undefined;

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			scope,
			projectOptions: [],
			page: emptyPage(scope)
		};
	}
	try {
		const page = await readAtelierTimeline(db, { scope, ...(pageSize ? { pageSize } : {}) });
		const projectRows = await listProjects(db);
		const projectOptions: ProjectOption[] = projectRows.map((p) => ({ id: p.id, name: p.name }));
		return { connected: true, scope, projectOptions, page };
	} catch (err) {
		// A scope-id validation throw (malformed ?project=) or a DB fault: honest degraded page.
		return {
			connected: false,
			scope,
			projectOptions: [],
			page: emptyPage(scope),
			error: (err as Error).message
		};
	}
};
