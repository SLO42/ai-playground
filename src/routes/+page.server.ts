// TASK 1.5 — Home / portfolio overview, LIVE counts (UI-SPEC §6; F-008; D-019).
//
// At-a-glance portfolio health, served from real DB rows (F-008 — never a
// fabricated metric). Degrades honestly (D-019): when the DB singleton isn't
// connected, counts are reported as unknown (null), not zero-dressed-as-real.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import { listProjects } from '$lib/server/projects/repo';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
	depends('app:projects');

	const db = tryGetDb();
	if (!db) {
		return { connected: false, projectCount: null as number | null };
	}
	try {
		const projects = await listProjects(db);
		return { connected: true, projectCount: projects.length };
	} catch (err) {
		// Home shows only a connected/disconnected split — both a dead cached handle and
		// a live-DB query failure mean "counts unknown" here. Run through the shared
		// classifier anyway so this surface stays consistent with /workflows + /projects;
		// either kind degrades to honest connected:false (D-019), never a fabricated zero.
		void classifyDbError(err);
		return { connected: false, projectCount: null as number | null };
	}
};
