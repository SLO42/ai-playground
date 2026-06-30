// /agents/catalog — the "Available Agents" LIBRARY view (operator brain).
//
// Browse every specialist agent definition with its CONTEXT (when-to-use, capabilities,
// type/color/priority) + best-effort USAGE metrics (calls / last-used / success-fail / avg
// duration). Two independent sources, both honest (F-008):
//   • LISTING — read DIRECTLY off disk (agent-library): the .claude/agents/**/*.md definitions
//     in the platform repo's main worktree. This works even when the DB is down (the listing is
//     filesystem-authoritative); cc_agent is unsuitable (flat scanner + drops the md body — the
//     very "when-to-use" wanted here), so we read the files at request time.
//   • USAGE — joined from the DB by the ONLY honest bridge: agent name === role.slug ⋈ session
//     (session.agent is a SLOT id, never the specialist name — DATA-MODEL). A name with no
//     matching slug is UNMAPPED ("no runs yet"), never a fabricated zero.
//
// The full when-to-use body + raw file are lazy-loaded per agent via ./content (keeps THIS load
// bounded — F-014 — instead of shipping ~1.2MB of bodies on every navigation). Live: the SSE
// `session` watcher re-invalidates app:fleet so usage updates in place.

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	agentLibraryAgentsDir,
	listLibraryAgents,
	agentUsageBySlug,
	type LibraryAgent,
	type AgentUsage
} from '$lib/server/agent-library';
import type { PageServerLoad } from './$types';

/** One library agent enriched with its usage (null = no role.slug match / no runs yet). */
export interface CatalogAgentEntry extends LibraryAgent {
	usage: AgentUsage | null;
}

export interface CatalogPageData {
	/** DB connectivity — usage is null-degraded when false (the LISTING still renders from disk). */
	connected: boolean;
	/** Whether the library `.claude/agents` dir resolved on disk (honest "not found" when false). */
	libraryFound: boolean;
	/** The resolved agents dir (shown to the operator so an empty list is explainable). */
	libraryDir: string | null;
	agents: CatalogAgentEntry[];
	/** Distinct `type` values present, for the filter chips (sorted; excludes null). */
	types: string[];
	/** Bridge coverage — how many agents matched a role.slug vs not (mapping confidence). */
	mapped: number;
	unmapped: number;
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<CatalogPageData> => {
	depends('app:fleet'); // session-row changes refresh usage
	depends('app:workforce'); // role/role_version changes refresh the bridge

	// LISTING — filesystem-authoritative; independent of the DB.
	const libraryDir = agentLibraryAgentsDir();
	const libraryAgents = listLibraryAgents();
	const libraryFound = libraryDir != null;

	// USAGE — best-effort bridge; degrades to null per agent when the DB is down.
	let usageBySlug = new Map<string, AgentUsage>();
	let connected = false;
	let error: string | undefined;
	const db = tryGetDb();
	if (db) {
		connected = true;
		try {
			usageBySlug = await agentUsageBySlug(db);
		} catch (err) {
			connected = false;
			error = (err as Error).message;
		}
	}

	let mapped = 0;
	let unmapped = 0;
	const agents: CatalogAgentEntry[] = libraryAgents.map((a) => {
		const usage = usageBySlug.get(a.name) ?? null;
		if (usage) mapped++;
		else unmapped++;
		return { ...a, usage };
	});

	const types = [...new Set(agents.map((a) => a.type).filter((t): t is string => !!t))].sort();

	return {
		connected,
		libraryFound,
		libraryDir,
		agents,
		types,
		mapped,
		unmapped,
		...(error ? { error } : {})
	};
};
