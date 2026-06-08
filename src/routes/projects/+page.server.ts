// TASK 1.5 — /projects list, LIVE DB data (UI-SPEC §6 v0.1; F-008; D-019).
//
// Loads the `project` rows straight from the runtime DB singleton via the projects
// repo (listProjects). NO fabricated data (F-008): every card is a real row. The
// loader degrades honestly (D-019) — if the DB singleton isn't connected (server
// booted with SurrealDB down), it reports `connected:false` and an empty list
// rather than inventing projects. Live updates arrive client-side over the one SSE
// stream (the `project` table watcher), which re-invalidates this loader.

import { fail } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import { listProjects } from '$lib/server/projects/repo';
import { scanProject, PathConfinementError } from '$lib/server/scanner';
import type { Actions, PageServerLoad } from './$types';

/** Serializable project DTO the page renders (SDK datetime/RecordId objects are
 *  non-POJO and SvelteKit's load serializer rejects them — so we project to plain
 *  values at this boundary, keeping only what the card needs). */
export interface ProjectCard {
	id: string;
	name: string;
	root_path: string;
	ecosystem: string[];
	status: string;
	purpose?: string;
}

export const load: PageServerLoad = async ({ depends }) => {
	// Live re-invalidation key: the SSE `project` watcher calls invalidate('app:projects').
	depends('app:projects');

	const db = tryGetDb();
	if (!db) {
		return { connected: false, projects: [] as ProjectCard[] };
	}
	try {
		const rows = await listProjects(db);
		const projects: ProjectCard[] = rows.map((p) => ({
			id: String(p.id),
			name: p.name,
			root_path: p.root_path,
			ecosystem: p.ecosystem ?? [],
			status: p.status,
			...(p.plan?.purpose ? { purpose: p.plan.purpose } : {})
		}));
		return { connected: true, projects };
	} catch (err) {
		// A cached handle can be DEAD (server killed mid-session). Classify via the shared
		// classifier so this surface stays uniform with /workflows + home (D-019): a true
		// connection loss is reported with no error detail (plain DISCONNECTED), while a
		// genuine query failure (DB still up) degrades this panel with its honest reason.
		const error = classifyDbError(err) === 'disconnected' ? undefined : (err as Error).message;
		return {
			connected: false,
			projects: [] as ProjectCard[],
			...(error ? { error } : {})
		};
	}
};

/** Confinement root (CODE_ROOT) the scanner path-checks against (D-018). */
function codeRoot(): string {
	return process.env.CODE_ROOT?.trim() || 'F:/code';
}

export const actions: Actions = {
	/**
	 * Job-1 scan/register: path-confine the submitted directory under CODE_ROOT
	 * (D-018, fail-closed), detect its ecosystem, and UPSERT the `project` row via
	 * the existing scanner (scanProject). Returns the registered row so the form can
	 * report it; the page re-invalidates the live list on the SSE `project` change.
	 * Validation is at the boundary: empty/over-long input is rejected here, and the
	 * scanner itself confines + validates the record id (D-016) before any DB write.
	 */
	scan: async ({ request }) => {
		const form = await request.formData();
		const raw = form.get('path');
		const path = typeof raw === 'string' ? raw.trim() : '';

		if (!path) {
			return fail(400, { scan: { path, error: 'Enter a directory path under CODE_ROOT.' } });
		}
		// Boundary length guard — keep the value bounded before it hits the resolver.
		if (path.length > 4096) {
			return fail(400, { scan: { path: path.slice(0, 256), error: 'Path is too long.' } });
		}

		const db = tryGetDb();
		if (!db) {
			return fail(503, {
				scan: { path, error: 'Database not connected — start SurrealDB and retry.' }
			});
		}

		try {
			const row = await scanProject(db, path, { codeRoot: codeRoot() });
			return { scan: { ok: true as const, id: row.id, name: row.name, root_path: row.root_path } };
		} catch (err) {
			if (err instanceof PathConfinementError) {
				// Fail-closed boundary rejection — quote the real, blame-free reason (UI-SPEC §11).
				return fail(400, {
					scan: { path, error: `Path is not under CODE_ROOT (${codeRoot()}).` }
				});
			}
			return fail(500, { scan: { path, error: (err as Error).message } });
		}
	}
};
