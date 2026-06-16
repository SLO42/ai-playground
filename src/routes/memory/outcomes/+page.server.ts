// BL-8 — /memory/outcomes: the Utilization lens (BRAIN-OBSERVABILITY-SPEC §4 Utilization).
//
// READ-ONLY (spec §2.1): the D-030 retrieval signal per memory — times recalled vs cited vs
// utilized + mean rank/score — as a leaderboard, with the "recalled-but-never-cited" filter
// (the BL-7B low-value candidate view; view-only here). Pairs with BL-7A: does the cite loop
// actually produce citations? Honest (F-008): a recalled-never-cited memory reports exactly
// that, NOT a faked score. Memory content is screened for display (D-026). Degrades honestly
// (D-019): DB down → connected:false + empty. Live (§4): a retrieval_outcome row change
// re-invalidates this loader. Server-driven filter via ?filter= so the page reflects the
// server's view.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { listRetrievalOutcomes, type UtilizationRow } from '$lib/server/memory';
import type { PageServerLoad } from './$types';

export type UtilizationFilter = 'all' | 'uncited';

export interface OutcomesData {
	connected: boolean;
	/** The active filter echoed back (the UI reflects the server's view). */
	filter: UtilizationFilter;
	rows: UtilizationRow[];
	error?: string;
}

export const load: PageServerLoad = async ({ url, depends }): Promise<OutcomesData> => {
	depends('app:memory-outcomes');

	const filter: UtilizationFilter = url.searchParams.get('filter') === 'uncited' ? 'uncited' : 'all';

	const db = tryGetDb();
	if (!db) return { connected: false, filter, rows: [] };
	try {
		const rows = await listRetrievalOutcomes(db, {
			recalledNeverCitedOnly: filter === 'uncited',
			limit: 150
		});
		return { connected: true, filter, rows };
	} catch (err) {
		return { connected: false, filter, rows: [], error: (err as Error).message };
	}
};
