// BL-8 — /memory/skills: the Learned-skills lens (BRAIN-OBSERVABILITY-SPEC §4 Learned-skills).
//
// READ-ONLY (spec §2.1): the graduated-skill list (title, graduation date, success/failure
// counts, last used, status) with the source causal_chain (trigger→outcome) on expand. All
// content fields (name/description/steps + chain trigger/outcome) are screened+fence-inert for
// display (D-026) in the listers. Honest "no skills graduated yet" when empty (F-008). Degrades
// honestly (D-019): DB down → connected:false + empty. Live (§4): a skill row change
// re-invalidates this loader.

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	listSkills,
	listCausalChainsByIds,
	type ObservabilitySkillRow,
	type CausalChainRow
} from '$lib/server/memory';
import type { PageServerLoad } from './$types';

export interface SkillsData {
	connected: boolean;
	skills: ObservabilitySkillRow[];
	/** sourceCausalChain id → its (screened) trigger→outcome chain, for the expand view. */
	chains: Record<string, CausalChainRow>;
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<SkillsData> => {
	depends('app:memory-skills');

	const db = tryGetDb();
	if (!db) return { connected: false, skills: [], chains: {} };
	try {
		const skills = await listSkills(db, 150);
		const chainIds = skills.map((s) => s.sourceCausalChain).filter((id): id is string => !!id);
		const chainMap = await listCausalChainsByIds(db, chainIds);
		const chains: Record<string, CausalChainRow> = {};
		for (const [id, row] of chainMap) chains[id] = row;
		return { connected: true, skills, chains };
	} catch (err) {
		return { connected: false, skills: [], chains: {}, error: (err as Error).message };
	}
};
