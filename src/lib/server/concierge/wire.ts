// CONCIERGE — production wiring for the Stage-1 event trigger.
//
// Assembles the LIVE deps for handleAtelierMessages from the real platform seams:
//   • recall     — the live MemoryService (S0 grounding). Ollama-offline ⇒ HONEST empty grounding.
//   • listAgents — the real on-disk agent library (listLibraryAgents), scored on cheap metadata
//                  (no when-to-use body read — bounded per-trigger cost; recommend.ts supports it).
//   • send       — the peer_message repo writer (default inside handleAtelierMessages).
//
// Split from concierge.ts so the core stays dependency-light + purely unit-testable (no harness /
// no disk); this module is the ONLY concierge code that touches the harness + the disk library.

import type { Db } from '../db/client';
import { getMemoryService } from '../harness';
import { listLibraryAgents } from '../agent-library/library';
import { asRecommendAgentInput, type RecommendAgentInput } from '../agent-library/recommend';
import {
	handleAtelierMessages,
	type AtelierTriggerResult,
	type ConciergeGroundingItem,
	type ConciergeRecallFn
} from './concierge';

/** Build the S0 grounding recall fn over the live MemoryService. When Ollama / the embedding model
 *  is unavailable, recall degrades to an HONEST empty grounding ([]) — never a fabricated memory. */
async function buildRecallFn(db: Db, limit: number): Promise<ConciergeRecallFn> {
	const mem = await getMemoryService(db);
	if (!mem.available) {
		return async () => [];
	}
	return async (query: string): Promise<ConciergeGroundingItem[]> => {
		// Global recall (project OMITTED — the atelier reads across the whole brain, §11).
		const res = await mem.memory.recall(query, { limit });
		return res.items.map((it) => ({ citationId: it.citationId, body: it.body, score: it.score }));
	};
}

/** Read the on-disk library specialists as recommender inputs (metadata-only — bounded). */
function listAgents(): RecommendAgentInput[] {
	return listLibraryAgents().map((a) => asRecommendAgentInput(a));
}

/**
 * Fire the Stage-1 concierge for a landed `to_kind:'atelier'` message (best-effort, event-driven).
 * NEVER throws to the caller — a fault is caught + logged so it can never break the peer-send
 * response path (the send already succeeded; this is the async advisory follow-up).
 */
export async function triggerConcierge(db: Db): Promise<AtelierTriggerResult | null> {
	try {
		const recallLimit = 5;
		const recall = await buildRecallFn(db, recallLimit);
		return await handleAtelierMessages({ db, recall, listAgents, recallLimit });
	} catch (err) {
		console.warn(`[concierge] trigger failed (best-effort): ${(err as Error).message}`);
		return null;
	}
}
