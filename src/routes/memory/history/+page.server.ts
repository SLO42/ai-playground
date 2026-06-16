// BL-8 — /memory/history: the brain History lens (BRAIN-OBSERVABILITY-SPEC §4 History).
//
// READ-ONLY (spec §2.1): surfaces the memory_history append-only audit trail (add/supersede/
// archive, before→after, screen_status, timestamp). A global recent-activity feed by default;
// a per-memory drill-down when ?memory=memory:… is passed (the existing /memory row links here).
// Every rendered snapshot is screened+fenced-inert for display (D-026) inside the lister. Degrades
// honestly (F-008/D-019): DB down → connected:false + empty; a failing read → honest error, never
// a fabricated entry. Live (§4): a memory_history row change re-invalidates this loader.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { listMemoryHistory, type MemoryHistoryRow } from '$lib/server/memory';
import type { PageServerLoad } from './$types';

/** A legal memory record-id link; anything else ⇒ the global feed (no per-memory scope). */
const MEMORY_ID = /^memory:[A-Za-z0-9_]+$/;

export interface HistoryData {
	connected: boolean;
	/** The memory id scope echoed back (null = global recent feed). */
	memoryId: string | null;
	entries: MemoryHistoryRow[];
	error?: string;
}

export const load: PageServerLoad = async ({ url, depends }): Promise<HistoryData> => {
	depends('app:memory-history');

	const raw = url.searchParams.get('memory');
	const memoryId = raw && MEMORY_ID.test(raw) ? raw : null;

	const db = tryGetDb();
	if (!db) return { connected: false, memoryId, entries: [] };
	try {
		const entries = await listMemoryHistory(db, memoryId ?? undefined, 150);
		return { connected: true, memoryId, entries };
	} catch (err) {
		return { connected: false, memoryId, entries: [], error: (err as Error).message };
	}
};
