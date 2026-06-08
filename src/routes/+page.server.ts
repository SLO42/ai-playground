// TASK 1.5 — Home / portfolio overview, LIVE counts (UI-SPEC §6; F-008; D-019).
//
// At-a-glance portfolio health, served from real DB rows (F-008 — never a
// fabricated metric). Degrades honestly (D-019): when the DB singleton isn't
// connected, counts are reported as unknown (null), not zero-dressed-as-real.

import { tryGetDb } from '$lib/server/db/runtime-init';
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
	} catch {
		return { connected: false, projectCount: null as number | null };
	}
};
