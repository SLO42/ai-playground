// /atelier — G-C: the atelier-wide reasoning/actions/communications timeline
// (GLOBAL-TRANSCRIPT-SPEC §6.3). A READ-ONLY merged timeline across message / peer_message /
// panel_verdict / role_event, scoped GLOBAL or per-PROJECT, paginated (newest-first), live via
// the existing onDbChange SSE. Filters are SERVER-driven (read + validated from ?project=&size=)
// so the page reflects exactly the server's view. Degrades honestly (F-008 / D-019): DB down →
// connected:false + empty; a failing source → a PARTIAL timeline (complete:false), never zero-
// dressed-as-real and never a thrown page.

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	readAtelierTimeline,
	readInbox,
	isInboxStatus,
	type InboxPage,
	type TimelinePage,
	type TimelineScope
} from '$lib/server/atelier';
import type { PeerStatus } from '$lib/server/peer/repo';
import { listProjects } from '$lib/server/projects/repo';
import type { PageServerLoad } from './$types';

/** Project option for the scope dropdown (id + display name). */
export interface ProjectOption {
	id: string;
	name: string;
}

/** Which lens the page shows. 'timeline' = the merged reasoning/actions/comms feed (a); 'inbox'
 *  = the §5b peer_message comms lens (b). Server-driven via ?lens= so the loader does the work
 *  for exactly the active lens (no fetching the inbox when the timeline is shown, and vice-versa).
 */
export type AtelierLens = 'timeline' | 'inbox';

export interface AtelierData {
	connected: boolean;
	/** The active lens echoed back (the UI reflects the server's view). */
	lens: AtelierLens;
	/** The active scope echoed back (the UI reflects the server's view). */
	scope: TimelineScope;
	/** Project options for the scope toggle (real, from the DB). */
	projectOptions: ProjectOption[];
	/** The first (newest) page of the merged timeline — present when lens='timeline'. */
	page: TimelinePage;
	/** The active inbox status filter echoed back (null = all) — relevant when lens='inbox'. */
	inboxStatus: PeerStatus | null;
	/** The first (newest) page of the inbox lens — present when lens='inbox'. */
	inbox: InboxPage;
	error?: string;
}

/** A legal project record-id link (mirrors /reports' guard). Anything else ⇒ global scope. */
const PROJECT_ID = /^project:[A-Za-z0-9_]+$/;

function emptyPage(scope: TimelineScope): TimelinePage {
	return { complete: true, scope, entries: [], nextBefore: null, failedSources: [] };
}

function emptyInbox(scope: TimelineScope, status: PeerStatus | null): InboxPage {
	return {
		scope,
		status,
		items: [],
		nextBefore: null,
		counts: { pending: 0, delivered: 0, expired: 0, quarantined: 0 }
	};
}

export const load: PageServerLoad = async ({ depends, url }): Promise<AtelierData> => {
	// Live re-invalidation key (one SSE stream re-runs this loader — UI-SPEC §1.2). The
	// contributing tables are watched (watched-tables.ts) and the page subscribes to each below.
	depends('app:atelier');

	// ── Server-driven lens + scope + status (read + validate from the URL query). ─────────
	const lens: AtelierLens = url.searchParams.get('lens') === 'inbox' ? 'inbox' : 'timeline';
	const rawProject = url.searchParams.get('project');
	const scope: TimelineScope =
		rawProject && PROJECT_ID.test(rawProject)
			? { kind: 'project', project: rawProject }
			: { kind: 'global' };
	const rawSize = Number(url.searchParams.get('size'));
	const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : undefined;
	const rawStatus = url.searchParams.get('status');
	const inboxStatus: PeerStatus | null = isInboxStatus(rawStatus) ? rawStatus : null;

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			lens,
			scope,
			projectOptions: [],
			page: emptyPage(scope),
			inboxStatus,
			inbox: emptyInbox(scope, inboxStatus)
		};
	}
	try {
		const projectRows = await listProjects(db);
		const projectOptions: ProjectOption[] = projectRows.map((p) => ({ id: p.id, name: p.name }));
		// Do the work only for the ACTIVE lens; the inactive lens gets an empty first page (the
		// client swaps via ?lens= which re-runs this loader). Bounded either way (F-014).
		if (lens === 'inbox') {
			const inbox = await readInbox(db, {
				scope,
				status: inboxStatus,
				...(pageSize ? { pageSize } : {})
			});
			return {
				connected: true,
				lens,
				scope,
				projectOptions,
				page: emptyPage(scope),
				inboxStatus,
				inbox
			};
		}
		const page = await readAtelierTimeline(db, { scope, ...(pageSize ? { pageSize } : {}) });
		return {
			connected: true,
			lens,
			scope,
			projectOptions,
			page,
			inboxStatus,
			inbox: emptyInbox(scope, inboxStatus)
		};
	} catch (err) {
		// A scope-id validation throw (malformed ?project=) or a DB fault: honest degraded page.
		return {
			connected: false,
			lens,
			scope,
			projectOptions: [],
			page: emptyPage(scope),
			inboxStatus,
			inbox: emptyInbox(scope, inboxStatus),
			error: (err as Error).message
		};
	}
};
