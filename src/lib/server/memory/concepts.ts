// Stage S3 — concept graph CRUD + embedding-dedup + loop extraction (laqrumcode PATTERN as a
// LAYER over the existing brain; D-026, D-028, D-008, F-008).
//
// A `concept` is a SEMANTIC node (a durable idea/decision the agent reasons WITH), distinct
// from a `memory` (a specific observed fact). Concepts get their embedding through the SAME
// path as memory — screen BEFORE embed (D-026), 1024-dim via the injected `Embedder` — so
// there is NO second embedding system and NO second ns/db. The slow/extraction cadence is the
// existing loop.ts review fork; this module owns the concept WRITE side it calls into.
//
// ADD-then-dedup (D-028): the extracting LLM proposes additive concept candidates; dedup
// (an embedding KNN against existing active concepts) is a SEPARATE downstream pass here — a
// near-duplicate REINFORCES the existing concept (bumps access_count/importance/stability)
// rather than minting a twin. This mirrors the memory consolidator's "don't trust the LLM to
// merge in-place" discipline, but for concepts the dedup runs at write time (concepts are far
// fewer than memories, so a bounded cosine scan is cheap and deterministic for tests).
//
// Boundary discipline (D-016): record-id links bind as StringRecordId via assertRecordId;
// every value via $param; absent optionals OMITTED (§6.1). Datetimes are Date OBJECTS (the SDK
// serializes them as SurrealDB datetime — an ISO string would fail the option<datetime> ASSERT).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { Embedder } from './embed';
import { gateCandidate, screen, type ScreenStatus } from './screen';

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** Cosine similarity at/above which a candidate is treated as the SAME concept (dedup → reinforce). */
export const CONCEPT_DEDUP_COSINE = 0.92;

/** The episodic/hierarchy edge kinds (lock-step with the m0073 concept_edge ASSERT set). */
export type ConceptEdgeKind =
	| 'narrower'
	| 'broader'
	| 'related_to'
	| 'about_concept'
	| 'caused_by'
	| 'supports'
	| 'contradicts'
	| 'describes'
	| 'supersedes';

const CONCEPT_EDGE_KINDS: readonly ConceptEdgeKind[] = [
	'narrower',
	'broader',
	'related_to',
	'about_concept',
	'caused_by',
	'supports',
	'contradicts',
	'describes',
	'supersedes'
];

/**
 * One ADD-only concept candidate proposed by the (untrusted) extractor. `extractedFrom` are the
 * memory/session rows the concept was mined from → `about_concept` edges (the scene's
 * "extracted-from"). `supersedes` is an older memory/concept this concept replaces →
 * a `supersedes` edge (+ the superseded concept is soft-marked). `relatedTo`/`narrower`/`broader`
 * are sibling/hierarchy concept ids (table:id) → the matching hierarchy edges.
 */
export interface ConceptCandidate {
	label: string;
	summary: string;
	namespace?: string;
	project?: string;
	importance?: number;
	confidence?: number;
	stability?: number;
	/** memory|session ids this concept was extracted from → `about_concept` edges. */
	extractedFrom?: string[];
	/** an older memory|concept this concept supersedes → a `supersedes` edge. */
	supersedes?: string;
	/** sibling concept ids → `related_to` edges. */
	relatedTo?: string[];
}

/** Result of storing one concept candidate. `deduped` ⇒ it reinforced an existing concept. */
export interface StoredConcept {
	id: string;
	persisted: boolean;
	/** true when the candidate matched an existing concept (reinforced, not freshly created). */
	deduped: boolean;
	screenStatus: ScreenStatus;
	dropReason?: string;
}

const IMPORTANCE_MIN = 0;
const IMPORTANCE_MAX = 10;

/**
 * D-026 — a concept candidate field authored by the untrusted extractor violated the `concept`
 * schema contract. Named + attributable at the write boundary (BEFORE screen/embed/CREATE),
 * never a generic SurrealDB type error at CREATE (mirrors store.ts MemoryCandidateFieldError).
 */
export class ConceptCandidateError extends Error {
	override readonly name = 'ConceptCandidateError';
	constructor(
		public readonly field: string,
		public readonly received: string,
		public readonly expected: string
	) {
		super(
			`concept candidate field \`${field}\` violates its schema contract: received ${received}, ` +
				`expected ${expected}; extractor output is untrusted (D-026)`
		);
	}
}

function shapeOf(v: unknown): string {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	return typeof v;
}

/** A {@link ConceptCandidate} is a plain object with string `label` + `summary`. */
export function isConceptCandidate(v: unknown): v is ConceptCandidate {
	return (
		typeof v === 'object' &&
		v !== null &&
		!Array.isArray(v) &&
		typeof (v as { label?: unknown }).label === 'string' &&
		typeof (v as { summary?: unknown }).summary === 'string'
	);
}

/** Validate the FULL untrusted candidate against the concept schema contract (D-026), BEFORE any side effect. */
function assertConceptShape(c: ConceptCandidate): void {
	if (typeof c.label !== 'string' || c.label.trim() === '') {
		throw new ConceptCandidateError('label', typeof c.label === 'string' ? 'empty string' : shapeOf(c.label), 'non-empty string');
	}
	if (typeof c.summary !== 'string') {
		throw new ConceptCandidateError('summary', shapeOf(c.summary), 'string');
	}
	if (c.namespace !== undefined && (typeof c.namespace !== 'string' || c.namespace.trim() === '')) {
		throw new ConceptCandidateError('namespace', typeof c.namespace === 'string' ? 'empty string' : shapeOf(c.namespace), 'non-empty string or absent');
	}
	for (const field of ['project', 'supersedes'] as const) {
		const v = c[field];
		if (v !== undefined && typeof v !== 'string') {
			throw new ConceptCandidateError(field, shapeOf(v), 'record id string or absent');
		}
	}
	for (const field of ['extractedFrom', 'relatedTo'] as const) {
		const v = c[field];
		if (v === undefined) continue;
		if (!Array.isArray(v)) throw new ConceptCandidateError(field, shapeOf(v), 'array of record ids or absent');
		for (let i = 0; i < v.length; i++) {
			if (typeof v[i] !== 'string') throw new ConceptCandidateError(`${field}[${i}]`, shapeOf(v[i]), 'record id string');
		}
	}
	for (const field of ['importance', 'confidence', 'stability'] as const) {
		const v = c[field];
		if (v === undefined) continue;
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			throw new ConceptCandidateError(field, shapeOf(v), 'finite number or absent');
		}
		if (field === 'importance' && (v < IMPORTANCE_MIN || v > IMPORTANCE_MAX)) {
			throw new ConceptCandidateError('importance', `${v}`, `number in [${IMPORTANCE_MIN},${IMPORTANCE_MAX}]`);
		}
	}
}

export interface ConceptStoreOptions {
	db: Db;
	embedder: Embedder;
	/** Override the dedup cosine cut (tests). Default {@link CONCEPT_DEDUP_COSINE}. */
	dedupCosine?: number;
}

/** Write the typed edges for a stored concept (about_concept / supersedes / related_to). */
async function writeConceptEdges(db: Db, conceptId: string, c: ConceptCandidate): Promise<void> {
	const cid = link(conceptId);
	// about_concept: each source (memory|session) → THIS concept. The scene renders these as
	// "extracted-from". RELATE direction is IN(source)→OUT(concept).
	for (const src of c.extractedFrom ?? []) {
		await db.query(`RELATE $src->concept_edge->$c SET kind = "about_concept";`, { src: link(src), c: cid });
	}
	// related_to: THIS concept ↔ a sibling concept (hierarchy). Directed from this concept out.
	for (const sib of c.relatedTo ?? []) {
		await db.query(`RELATE $c->concept_edge->$sib SET kind = "related_to";`, { c: cid, sib: link(sib) });
	}
	// supersedes: THIS concept → the older memory|concept it replaces. If the target is a concept,
	// soft-mark it superseded (D-015: never delete) so the graph + recall stop treating it as live.
	if (c.supersedes) {
		const oldId = assertRecordId(c.supersedes);
		await db.query(`RELATE $c->concept_edge->$old SET kind = "supersedes";`, { c: cid, old: link(oldId) });
		if (oldId.startsWith('concept:')) {
			await db.query(`UPDATE $old SET status = "superseded", superseded_by = $c, updated_at = time::now();`, {
				old: link(oldId),
				c: cid
			});
		}
	}
}

/**
 * Find the nearest existing ACTIVE concept to a candidate embedding, scoped to the same project
 * (a global concept dedups against global; a project concept against that project). Returns the
 * match + its cosine when at/above the cut, else null. Deterministic cosine scan (not the HNSW
 * KNN operator) so dedup behaviour is reproducible in tests on tiny data; the concept_vec HNSW
 * index still serves recall. Bounded LIMIT keeps the scan cheap.
 */
async function nearestConcept(
	db: Db,
	embedding: number[],
	project: string | undefined,
	cut: number
): Promise<{ id: string; sim: number } | null> {
	const where = project ? 'status = "active" AND project = $project' : 'status = "active" AND project IS NONE';
	const [rows] = await db.query<[Array<{ id: unknown; sim: number }>]>(
		`SELECT id, vector::similarity::cosine(embedding, $v) AS sim FROM concept
		  WHERE ${where} ORDER BY sim DESC LIMIT 5;`,
		project ? { v: embedding, project: link(project) } : { v: embedding }
	);
	const top = rows[0];
	if (top && typeof top.sim === 'number' && top.sim >= cut) return { id: String(top.id), sim: top.sim };
	return null;
}

/**
 * Persist ONE concept candidate (S3): D-026 shape-validate → screen label+summary BEFORE embed
 * → embed the SCREENED body → DEDUP by embedding cosine. On a near-duplicate, REINFORCE the
 * existing concept (bump access_count/importance/stability, touch last_accessed) and attach the
 * candidate's edges to it; otherwise CREATE a fresh concept. A quarantined label/summary is NOT
 * persisted (a poisoned concept never lands). Returns the (existing or new) id + dedup flag.
 */
export async function storeConcept(opts: ConceptStoreOptions, c: ConceptCandidate): Promise<StoredConcept> {
	const { db, embedder } = opts;
	assertConceptShape(c);

	// Screen BEFORE embed (D-026). The label is the node's visible title; the summary is its body —
	// both must be clean before they reach an embedding or the row. A quarantined part drops it.
	const labelGate = gateCandidate(c.label);
	if (!labelGate.capture || labelGate.screen!.status === 'quarantined') {
		return { id: '', persisted: false, deduped: false, screenStatus: 'quarantined', dropReason: 'concept-label-quarantined-or-dropped' };
	}
	const screenedLabel = labelGate.screen!.text;
	// Summary may be empty (a concept can be label-only) — screen only when present.
	let screenedSummary = '';
	let summaryStatus: ScreenStatus = 'clean';
	if (c.summary.trim()) {
		const s = screen(c.summary);
		if (s.status === 'quarantined') {
			return { id: '', persisted: false, deduped: false, screenStatus: 'quarantined', dropReason: 'concept-summary-quarantined' };
		}
		screenedSummary = s.text;
		summaryStatus = s.status;
	}
	const screenStatus: ScreenStatus = labelGate.screen!.status === 'redacted' || summaryStatus === 'redacted' ? 'redacted' : 'clean';

	// Embed the SCREENED body only (§3.1b) — never the raw candidate. 1024-dim via the same path as memory.
	const embedding = await embedder.embed(`${screenedLabel}\n${screenedSummary}`.trim(), 'add');

	const cut = opts.dedupCosine ?? CONCEPT_DEDUP_COSINE;
	const match = await nearestConcept(db, embedding, c.project, cut);
	if (match) {
		// Reinforce the existing concept (the semantic analogue of resurfacing): a re-observation
		// raises its salience + settledness without minting a twin. importance is capped at 10.
		await db.query(
			`UPDATE $id SET
			   access_count = access_count + 1,
			   importance = math::min([10.0, importance + 0.5]),
			   stability = math::min([1.0, stability + 0.1]),
			   confidence = math::min([1.0, confidence + 0.05]),
			   last_accessed = time::now(),
			   updated_at = time::now();`,
			{ id: link(match.id) }
		);
		await writeConceptEdges(db, match.id, c);
		return { id: match.id, persisted: true, deduped: true, screenStatus };
	}

	const content: Record<string, unknown> = {
		label: screenedLabel,
		summary: screenedSummary,
		// ALWAYS SET namespace explicitly so the dedup_key VALUE never computes against a NONE
		// namespace (F-020) — never rely on the schema DEFAULT landing first.
		namespace: c.namespace ?? 'default',
		embedding,
		status: 'active',
		screen_status: screenStatus,
		last_accessed: new Date()
	};
	if (c.project) content.project = link(c.project);
	if (c.importance !== undefined) content.importance = c.importance;
	if (c.confidence !== undefined) content.confidence = c.confidence;
	if (c.stability !== undefined) content.stability = c.stability;

	const [rows] = await db.query<[Array<{ id: unknown }>]>(`CREATE concept CONTENT $content RETURN AFTER;`, { content });
	const id = String(rows[0].id);
	await writeConceptEdges(db, id, c);
	return { id, persisted: true, deduped: false, screenStatus };
}

/**
 * Batch concept write with per-item fallback isolation (one bad candidate never drops the rest) —
 * the §3.4 discipline, for concepts. Carries `project`/`namespace` defaults onto each candidate.
 */
export async function storeConcepts(
	opts: ConceptStoreOptions & { project?: string; namespace?: string },
	candidates: ConceptCandidate[]
): Promise<StoredConcept[]> {
	const out: StoredConcept[] = [];
	for (const raw of candidates) {
		const c: ConceptCandidate = {
			...raw,
			project: raw.project ?? opts.project,
			namespace: raw.namespace ?? opts.namespace
		};
		try {
			out.push(await storeConcept(opts, c));
		} catch (err) {
			const e = err as Error;
			out.push({ id: '', persisted: false, deduped: false, screenStatus: 'quarantined', dropReason: `${e.name || 'concept-write-failed'}:${e.message}` });
		}
	}
	return out;
}

/** The injected concept-extraction LLM call (untrusted return → shape-validated at the boundary). */
export type ExtractConceptsFn = (turnText: string) => Promise<ConceptCandidate[]>;

/**
 * D-026 — the concept extractor returned a value that is not the contracted shape (a non-array,
 * or a malformed element). Named + attributable; the orchestrator marks the work_item failed on
 * it rather than duck-typing a garbage candidate downstream (mirrors ReviewForkShapeError).
 */
export class ConceptExtractShapeError extends Error {
	override readonly name = 'ConceptExtractShapeError';
	constructor(
		public readonly received: string,
		public readonly elementIndex?: number
	) {
		super(
			elementIndex === undefined
				? `concept extractor returned a non-array (${received}); LLM output is untrusted (D-026)`
				: `concept extractor returned a malformed element at [${elementIndex}] (${received}); LLM output is untrusted (D-026)`
		);
	}
}

export { CONCEPT_EDGE_KINDS };
