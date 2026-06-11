// TASK 2.5 — cross-session recall + retrieval ranking (MEMORY-SPEC §4; D-029, D-030, D-031).
//
// The `memory`-row recall path (ARCHITECTURE §2.6 staged pipeline expanded):
//   1. Vector KNN over the HNSW index (DATA-MODEL §4.5) — active, non-quarantined rows.
//   2. Graph-neighbor expansion — 1-hop along typed `references` edges (§4.3 step 2).
//   3. WMR / ACAN score — 0.50·cosine + 0.35·historical_utility + 0.15·recency_decay
//      (§4.3 step 3; weights are tunable starting points, not locked constants).
//   4. Hard novelty gate (§4.6, D-031) — cosine-band cut drops near-dup families.
//   5. Lineage dedup (§4.1 step 2) — one excerpt per session lineage.
//   6. FENCE every returned item (§10) — the recall path is one of the injection paths.
//
// historical_utility comes from `retrieval_outcome` (DATA-MODEL §4.13), defaulting to 0
// until that data exists. The outcome signal feeds RANKING ONLY (D-030 resolved) — the
// curator's prune (loop.ts §5) does NOT read it. After a turn, recordOutcomes() writes
// one retrieval_outcome row per injected item (the ranker's future input).
//
// CRITICAL: quarantined + archived/superseded rows are EXCLUDED via the shared active-set
// filter (§5.3) — the SAME way archived rows are filtered. A quarantined secret is never
// embedded (store.ts) AND never recalled (here) AND never exported.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { Embedder } from './embed';
import { distanceToSimilarity } from './embed';
import { fence, type FencedItem } from './fence';

/** WMR weights (§4.3) — tunable starting points (kongcode defaults), not locked. */
export const WMR_WEIGHTS = { cosine: 0.5, utility: 0.35, recency: 0.15 } as const;

/** Recency half-life (days) for the recency_decay term. */
const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Hard novelty-gate band (§4.6, D-031): if a candidate's cosine similarity to an
 * ALREADY-SELECTED item exceeds this, it is a near-dup and is dropped. Tunable.
 */
export const NOVELTY_COSINE_CUT = 0.97;

/** A scored, ranked recall candidate (internal). */
interface ScoredCandidate {
	id: string;
	content: string;
	embedding: number[];
	cosine: number;
	utility: number;
	recency: number;
	score: number;
	sessionLineage?: string;
	wasNeighbor: boolean;
}

/** One recalled item as returned to the caller — already FENCED (§10). */
export interface RecallItem {
	id: string;
	/** Citation id ([#N]) so retrieval-outcome parsing can tie usage back (§4.5). */
	citationId: string;
	score: number;
	wasNeighbor: boolean;
	/** Explain-mode breakdown (§4.4) for the /memory recall-explain view. */
	explain: { cosine: number; utility: number; recency: number };
	/** The FENCED block ready to splice into context (§10). */
	fenced: FencedItem;
}

export interface RecallResult {
	items: RecallItem[];
	/** The assembled, fenced context string (all items joined). */
	contextText: string;
}

export interface RecallOptions {
	db: Db;
	embedder: Embedder;
	/** KNN budget — how many vector neighbours to pull before scoring. Default 20. */
	k?: number;
	/** Max items returned after ranking + novelty gate. Default 6. */
	limit?: number;
	/** Restrict to a project (table:id). Omitted ⇒ global recall. */
	project?: string;
	/** Include 1-hop graph neighbours of the top vector hits (§4.3 step 2). Default true. */
	expandGraph?: boolean;
}

/** cosine of two equal-length vectors (both already unit-normalized by the embedder). */
function cosine(a: number[], b: number[]): number {
	let dot = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) dot += a[i] * b[i];
	if (dot < -1) return -1;
	if (dot > 1) return 1;
	return dot;
}

function recencyDecay(updatedAt: string | undefined): number {
	if (!updatedAt) return 0;
	const ageMs = Date.now() - new Date(updatedAt).getTime();
	if (!Number.isFinite(ageMs) || ageMs < 0) return 1;
	const ageDays = ageMs / 86_400_000;
	return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

interface MemoryRow {
	id: unknown;
	content: string;
	embedding: number[];
	updated_at?: string;
	dist?: number;
}

/**
 * Staged recall over the `memory` table. Returns ranked, novelty-gated, lineage-deduped,
 * FENCED items. Excludes quarantined + archived/superseded rows via the active-set
 * filter (§5.3). No LLM in the loop (D-029) — pure vector + graph + deterministic score.
 */
export async function recall(opts: RecallOptions, query: string): Promise<RecallResult> {
	const { db, embedder } = opts;
	const k = opts.k ?? 20;
	const limit = opts.limit ?? 6;

	// Embed the QUERY (role=search, §7.2). Screened text only — a query is operator/agent
	// input that already passed the boundary; we still treat it as search-role.
	const qvec = await embedder.embed(query, 'search');

	// Step 1 — vector KNN. Active-set filter (§5.3): status active|NONE AND screen clean/
	// redacted (NEVER quarantined). The HNSW <|K,COSINE|> exact form keeps the test
	// deterministic; production may switch to <|K,EF|> by budget. dist → similarity at
	// the §7.2 boundary (the scorer never sees a raw distance).
	//
	// TASK 16.6 (WORKFORCE-SPEC §4.2) — the D-029 RECALL EXCLUSION for gauntlet
	// interviews: a memory row whose originating session (m0033 provenance) is
	// kind='interview' is NEVER recalled — second rail behind the D-027 writer
	// exclusion, so even a row that somehow got written from an interview transcript
	// cannot re-enter context. Provenance-less rows (session NONE) recall unchanged.
	const interviewFilter = `AND (session IS NONE OR session.kind != "interview")`;
	const projFilter = opts.project ? `AND project = $project` : '';
	const [vrows] = await db.query<[MemoryRow[]]>(
		`SELECT id, content, embedding, updated_at,
		        vector::distance::knn() AS dist
		   FROM memory
		  WHERE embedding <|${k},COSINE|> $qvec
		    AND (status = "active" OR status IS NONE)
		    AND screen_status != "quarantined"
		    ${interviewFilter}
		    ${projFilter}
		  ORDER BY dist ASC;`,
		opts.project ? { qvec, project: link(opts.project) } : { qvec }
	);

	// Build initial candidates from vector hits.
	const byId = new Map<string, ScoredCandidate>();
	for (const r of vrows) {
		const id = String(r.id);
		const cos = r.dist != null ? distanceToSimilarity(r.dist) : cosine(qvec, r.embedding);
		byId.set(id, {
			id,
			content: r.content,
			embedding: r.embedding,
			cosine: cos,
			utility: 0,
			recency: recencyDecay(r.updated_at),
			score: 0,
			wasNeighbor: false
		});
	}

	// Step 2 — graph-neighbour expansion (1 hop along references edges).
	if ((opts.expandGraph ?? true) && byId.size) {
		const seedIds = [...byId.keys()].slice(0, 5).map(link);
		const [nrows] = await db.query<[MemoryRow[]]>(
			`SELECT id, content, embedding, updated_at FROM memory
			  WHERE (status = "active" OR status IS NONE)
			    AND screen_status != "quarantined"
			    AND (session IS NONE OR session.kind != "interview")
			    AND id IN (
			      SELECT VALUE ->references->memory FROM $seeds
			    );`,
			{ seeds: seedIds }
		);
		for (const r of nrows) {
			const id = String(r.id);
			if (byId.has(id)) continue;
			byId.set(id, {
				id,
				content: r.content,
				embedding: r.embedding,
				cosine: cosine(qvec, r.embedding),
				utility: 0,
				recency: recencyDecay(r.updated_at),
				score: 0,
				wasNeighbor: true
			});
		}
	}

	const candidates = [...byId.values()];
	if (!candidates.length) return { items: [], contextText: '' };

	// historical_utility from retrieval_outcome (§4.5, D-030 — ranking input only).
	// Count UTILIZED outcome rows per memory. NB: SurrealDB 2.x `math::sum(<bool>)` does NOT
	// coerce bool→int (it errors / yields 0 — engine truth, surfaced by 2.16), so we count
	// rows matching `utilized = true` via a WHERE-filtered count() instead.
	const idList = candidates.map((c) => link(c.id));
	const [orows] = await db.query<[Array<{ memory: unknown; util: number }>]>(
		`SELECT memory, count() AS util FROM retrieval_outcome
		  WHERE memory IN $ids AND utilized = true GROUP BY memory;`,
		{ ids: idList }
	);
	const utilByMem = new Map<string, number>();
	for (const o of orows) {
		// Normalize a raw count into [0,1] with a gentle saturating curve.
		const raw = Number(o.util) || 0;
		utilByMem.set(String(o.memory), raw / (raw + 3));
	}

	// Step 3 — WMR score.
	for (const c of candidates) {
		c.utility = utilByMem.get(c.id) ?? 0;
		c.score =
			WMR_WEIGHTS.cosine * c.cosine +
			WMR_WEIGHTS.utility * c.utility +
			WMR_WEIGHTS.recency * c.recency;
	}
	candidates.sort((a, b) => b.score - a.score);

	// Steps 4+5 — novelty gate (drop near-dups vs already-selected) + lineage dedup.
	const selected: ScoredCandidate[] = [];
	const seenLineage = new Set<string>();
	for (const c of candidates) {
		if (selected.length >= limit) break;
		// §4.6 hard novelty gate: skip a near-duplicate of something already chosen.
		const dup = selected.some((s) => cosine(s.embedding, c.embedding) >= NOVELTY_COSINE_CUT);
		if (dup) continue;
		// §4.1 lineage dedup: one excerpt per session lineage (when known).
		if (c.sessionLineage) {
			if (seenLineage.has(c.sessionLineage)) continue;
			seenLineage.add(c.sessionLineage);
		}
		selected.push(c);
	}

	// Step 6 — FENCE every returned item (§10). citationId = 1-based position.
	const items: RecallItem[] = selected.map((c, i) => {
		const citationId = String(i + 1);
		return {
			id: c.id,
			citationId,
			score: c.score,
			wasNeighbor: c.wasNeighbor,
			explain: { cosine: c.cosine, utility: c.utility, recency: c.recency },
			fenced: fence({ source: 'recall', body: c.content, citationId })
		};
	});

	const contextText = items.map((i) => i.fenced.text).join('\n\n');
	return { items, contextText };
}

// ── §4.5 retrieval-outcome recording (D-030 — ranking input only, NOT pruning) ─────

export interface OutcomeInput {
	session?: string; // table:id
	queryTurn?: string; // message table:id
	/** The model's response text — scanned for [#N] citation markers (§4.5). */
	responseText: string;
	/** The items that were injected this turn (recall result). */
	injected: RecallItem[];
	/** Whether a downstream tool call succeeded after this context (§4.5 signal). */
	toolSuccess?: boolean;
}

/** Parse explicit [#N] citation markers out of a model response (§4.5). */
export function parseCitations(text: string): Set<string> {
	const out = new Set<string>();
	const re = /\[#(\d+)\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) out.add(m[1]);
	return out;
}

/**
 * Record one `retrieval_outcome` row per injected item (DATA-MODEL §4.13). Marks `cited`
 * from [#N] parsing and `utilized` from cited-OR-implicit-path-hit. This is the RANKER's
 * future input ONLY (D-030) — it never drives pruning. Records rows even when nothing was
 * cited (a zero-utility row is still signal). Returns the created row ids.
 */
export async function recordOutcomes(db: Db, input: OutcomeInput): Promise<string[]> {
	const cited = parseCitations(input.responseText);
	const ids: string[] = [];
	for (const item of input.injected) {
		const isCited = cited.has(item.citationId);
		// Implicit-path-hit rescue (§4.5): a high-scoring neighbour that clearly shaped the
		// answer is credited as utilized even without a formal citation. Conservative proxy:
		// strong score + a successful downstream tool call.
		const implicit = !isCited && input.toolSuccess === true && item.score >= 0.6;
		const utilized = isCited || implicit;
		const content: Record<string, unknown> = {
			memory: link(item.id),
			cited: isCited,
			utilized,
			was_neighbor: item.wasNeighbor,
			score: item.score
		};
		if (input.session) content.session = link(input.session);
		if (input.queryTurn) content.query_turn = link(input.queryTurn);
		if (input.toolSuccess != null) content.tool_success = input.toolSuccess;
		if (isCited) content.citation_id = item.citationId;
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE retrieval_outcome CONTENT $content RETURN AFTER;`,
			{ content }
		);
		ids.push(String(rows[0].id));
	}
	return ids;
}
