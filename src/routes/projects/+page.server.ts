// TASK 1.5 — /projects list, LIVE DB data (UI-SPEC §6 v0.1; F-008; D-019).
//
// Loads the `project` rows straight from the runtime DB singleton via the projects
// repo (listProjects). NO fabricated data (F-008): every card is a real row. The
// loader degrades honestly (D-019) — if the DB singleton isn't connected (server
// booted with SurrealDB down), it reports `connected:false` and an empty list
// rather than inventing projects. Live updates arrive client-side over the one SSE
// stream (the `project` table watcher), which re-invalidates this loader.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { listProjects } from '$lib/server/projects/repo';
import type { PageServerLoad } from './$types';

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
		// DB reachable at boot but the query failed now — degrade this panel, stay honest.
		return {
			connected: false,
			projects: [] as ProjectCard[],
			error: (err as Error).message
		};
	}
};
