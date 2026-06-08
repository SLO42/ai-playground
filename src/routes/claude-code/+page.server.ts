// TASK 1.8 — /claude-code read-only catalog (UI-SPEC §313 v0.1; D-010).
//
// Reads the LIVE Claude Code config mirror (cc_* tables, DATA-MODEL §4.10) and
// lists hooks / skills / agents / MCP servers per scope, with each scope's
// synced / out-of-sync state (UI-SPEC §214). NO fabricated data (F-008): every
// row comes from the DB mirror, and the sync status is computed live against disk.
//
// v0.1 is READ-ONLY (UI-SPEC §313: "read-only catalog"); editing config files is
// deferred (D-010 diff-and-confirm writes land later). The loader degrades
// honestly when the DB singleton isn't wired yet (app-shell DB init is a later
// task) — it reports `connected: false` rather than inventing rows.

import { getDb, type Db } from '$lib/server/db/client';
import { readCatalog, syncState, type CatalogScope } from '$lib/server/cc-config';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	let db: Db;
	try {
		db = getDb();
	} catch {
		// DB singleton not initialised (no startup wiring yet) — honest empty state.
		return { connected: false, scopes: [] as CatalogScope[] };
	}

	const scopes = await readCatalog(db);

	// Overlay the LIVE disk-vs-mirror status per scope (the mirror alone can only
	// say "synced if a digest exists"; the real check needs disk access). A scope
	// whose path is unreadable keeps its mirror-derived status.
	const withStatus = await Promise.all(
		scopes.map(async (sc) => {
			if (sc.kind !== 'project' && sc.kind !== 'global') return sc;
			try {
				const st = await syncState(db, {
					kind: sc.kind,
					// cc_scope.path is the abs path to the .claude dir.
					claudeDir: sc.path,
					...(sc.project ? { project: sc.project } : {})
				});
				return { ...sc, status: st.status };
			} catch {
				return sc;
			}
		})
	);

	return { connected: true, scopes: withStatus };
};
