// TASK 2.5 — memory store + ADD-only extraction (MEMORY-SPEC §3; D-028, D-026, D-015).
//
// Extraction is ADD-only (D-028): conflict resolution (dedup/supersession/contradiction)
// is a SEPARATE downstream deterministic/graph pass (the consolidator, loop.ts §5),
// never trusted to the extracting LLM in-place. This module owns the write side:
//
//   §3.4 phased batch add (one LLM call per turn; everything else batched):
//     1. extract()      — ONE LLM call → candidate set (injected runtime; mock in tests).
//     2. step 2.0 screen — gateCandidate() runs DO-NOT-CAPTURE + secret/PII BEFORE embed
//        (§3.1/§3.1b). Dropped candidates never persist; secret spans redacted /
//        quarantined; screen_status stamped. NOTHING reaches an embedding or insert
//        before this — the load-bearing ordering that closes the cache side channel.
//     3. batch embed (screened text only) + insert memory + memory_history audit row.
//     4. per-item fallback — one bad candidate never drops the rest.
//
// Boundary discipline (D-016): record-id links bind as StringRecordId; every value via
// $param; absent optionals OMITTED (§6.1). Quarantined rows are written (audit) but the
// recall/active-set filter excludes them (§3.1b, recall.ts).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { Embedder } from './embed';
import { gateCandidate, type ScreenStatus } from './screen';

export type MemoryKind = 'semantic' | 'episodic' | 'procedural';

/** One ADD-only extraction candidate (additive only — no update/delete decisioning). */
export interface MemoryCandidate {
	content: string;
	kind?: MemoryKind;
	namespace?: string;
	key?: string;
	tags?: string[];
	source?: string;
	importance?: number;
	project?: string; // table:id
	/**
	 * TASK 16.6 (WORKFORCE-SPEC §4.2) — the ORIGINATING session (table:id, m0033
	 * provenance). Set by transcript-derived write paths (launch-end extraction, the
	 * D-027 writer fork) so the D-029 recall filter can exclude rows born in
	 * kind='interview' sessions. Omit for non-session memories.
	 */
	session?: string;
}

/** A persisted memory row id + how it was screened (clean/redacted/quarantined). */
export interface StoredMemory {
	id: string;
	screenStatus: ScreenStatus;
	/** false when the candidate was dropped by the DO-NOT-CAPTURE gate (not persisted). */
	persisted: boolean;
	dropReason?: string;
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	return out;
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

// ── D-026 trust-boundary errors (untrusted extractor output) ────────────────────────
//
// The extracting LLM's return is untrusted DATA (D-026): it must be validated at THIS
// boundary with a NAMED, attributable error — never duck-typed downstream into an
// anonymous TypeError (the loop.ts sibling, ReviewForkShapeError, names the same class of
// failure one module over). Two distinct seams, two distinct named errors.

/** Describe an untrusted value for an error message without leaking its (possibly poisoned) body. */
function shapeOf(v: unknown): string {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	return typeof v;
}

/**
 * D-026 — the §3.2 extractor returned a value that is NOT the contracted shape: either the
 * whole return is a non-array, or an ELEMENT inside an otherwise-valid array is not a
 * {@link MemoryCandidate} (a plain object with a string `content`). A malformed element would
 * otherwise hit the downstream provenance spread (`{ ...c, project: c.project ?? … }`) and throw
 * an anonymous `TypeError: Cannot read properties of null (reading 'project')` — the exact symptom
 * this class exists to eliminate. `elementIndex` is set when the failure is a bad element.
 *
 * Names the trigger (which seam/element), the catcher (the boundary guard in extractAndStore),
 * and what the caller sees (a typed, attributable failure — never a fake-success swallow, F-008).
 */
export class MemoryCandidateShapeError extends Error {
	override readonly name = 'MemoryCandidateShapeError';
	constructor(
		public readonly received: string,
		/** Set when the failure is a malformed ELEMENT inside a valid array (vs a non-array return). */
		public readonly elementIndex?: number
	) {
		super(
			elementIndex === undefined
				? `extractor returned a non-array (${received}); extractor output is untrusted (D-026)`
				: `extractor returned a malformed element at [${elementIndex}] (${received}); extractor output is untrusted (D-026)`
		);
	}
}

/**
 * D-026 — a candidate's PROVENANCE field (`project` / `session`) survived the extract boundary
 * with a non-string SHAPE. The upstream `isMemoryCandidate` validates only `content`; a number/
 * object/array/boolean provenance field is NOT caught there and would either throw a generic
 * D-016 `IdentifierError` deep in the CONTENT build (after screen + embed) on a truthy non-string,
 * OR — for a FALSY non-string (`false`/`0`) — be silently treated as absent by the `c.project ?`
 * ternary and OMITTED, losing provenance with no error (F-008). Validate the shape at the store
 * boundary, BEFORE screen/embed/link, and fail NAMED here instead.
 */
export class MemoryProvenanceShapeError extends Error {
	override readonly name = 'MemoryProvenanceShapeError';
	constructor(
		public readonly field: 'project' | 'session',
		public readonly received: string
	) {
		super(
			`candidate provenance field \`${field}\` has a non-string shape (${received}); ` +
				`provenance is untrusted extractor output (D-026) — must be a string id or absent`
		);
	}
}

/** A {@link MemoryCandidate} is a plain object with a string `content` (the only field the screen relies on). */
function isMemoryCandidate(v: unknown): v is MemoryCandidate {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { content?: unknown }).content === 'string';
}

/**
 * D-026 provenance-shape boundary: each provenance field (`project`, `session`) must be a string
 * (a `table:id`, further validated by assertRecordId at link time) or absent (`undefined`). ANY
 * other type — including a FALSY non-string (`false`, `0`, `''` is a string so allowed) — fails
 * NAMED here, before the screen/embed/link, instead of throwing an anonymous IdentifierError mid-
 * pipeline (truthy) or being silently omitted (falsy non-string). Mutates nothing; throws or returns.
 */
function assertProvenanceShape(c: MemoryCandidate): void {
	for (const field of ['project', 'session'] as const) {
		const v = c[field];
		if (v !== undefined && typeof v !== 'string') {
			throw new MemoryProvenanceShapeError(field, shapeOf(v));
		}
	}
}

export interface StoreOptions {
	db: Db;
	embedder: Embedder;
}

/**
 * Persist ONE candidate through the §3.4 pipeline: DO-NOT-CAPTURE + secret/PII screen
 * (step 2.0, BEFORE embed) → embed screened text → insert memory + memory_history. A
 * dropped candidate returns persisted:false and writes nothing. A quarantined candidate
 * IS written (status excluded from recall) so the audit trail is complete, but its
 * embedding is computed over the REDACTED text — never a raw secret.
 */
export async function storeMemory(opts: StoreOptions, c: MemoryCandidate): Promise<StoredMemory> {
	const { db, embedder } = opts;

	// D-026 provenance-shape boundary — validate the (untrusted-extractor-sourced) `project` /
	// `session` field SHAPES BEFORE any screen/embed/link. A non-string provenance would otherwise
	// throw a generic IdentifierError deep in the CONTENT build (truthy) or be silently omitted
	// (falsy non-string); fail NAMED + attributable here, writing nothing.
	assertProvenanceShape(c);

	// Step 2.0 — screen BEFORE embed (§3.4). Both gates, in order.
	const gate = gateCandidate(c.content);
	if (!gate.capture) {
		return { id: '', screenStatus: 'clean', persisted: false, dropReason: gate.dropReason };
	}
	const scr = gate.screen!;

	// Embed the SCREENED text only (§3.1b / §7.1). Never the raw candidate.
	const embedding = await embedder.embed(scr.text, 'add');

	const content = omitUndefined({
		project: c.project ? link(c.project) : undefined,
		// m0033 provenance (16.6): the originating session, when known — the D-029
		// recall filter's input. Omitted (NONE) for non-session memories (§6.1).
		session: c.session ? link(c.session) : undefined,
		kind: c.kind ?? 'semantic',
		namespace: c.namespace ?? 'default',
		key: c.key,
		content: scr.text,
		embedding,
		tags: c.tags,
		source: c.source,
		importance: c.importance,
		screen_status: scr.status,
		// Pass a Date OBJECT — the SDK serializes it as a SurrealDB datetime. An ISO
		// STRING would be stored as a string and fail the option<datetime> ASSERT (§6.1).
		screened_at: new Date()
	});

	// Insert the memory (§3.4 step 3) — statement 0 returns the new row.
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE memory CONTENT $content RETURN AFTER;`,
		{ content }
	);
	const id = String(rows[0].id);
	// Audit row (mem0 three-table split, §6.9) referencing the now-known id. The `after`
	// snapshot holds ALREADY-SCREENED content (§6.9: never a raw secret in the audit log).
	await db.query(`CREATE memory_history CONTENT { memory: $m, op: "add", after: $after };`, {
		m: link(id),
		after: { content: scr.text, screen_status: scr.status }
	});
	return { id, screenStatus: scr.status, persisted: true };
}

/**
 * §3.4 phased BATCH add over a candidate set. One screen+embed+insert per candidate with
 * per-item fallback isolation: a throw on one candidate is captured and the rest proceed
 * (step 4). Returns one StoredMemory per input candidate (in order), including drops.
 */
export async function storeMemories(opts: StoreOptions, candidates: MemoryCandidate[]): Promise<StoredMemory[]> {
	const out: StoredMemory[] = [];
	for (const c of candidates) {
		try {
			out.push(await storeMemory(opts, c));
		} catch (err) {
			// Per-item fallback (§3.4 step 4) — one bad candidate never drops the rest. Attribute
			// the failure by its NAMED class (D-026 provenance-shape rejections surface as
			// MemoryProvenanceShapeError, not the misleading "insert-failed") — every error has a name.
			const e = err as Error;
			out.push({ id: '', screenStatus: 'quarantined', persisted: false, dropReason: `${e.name || 'insert-failed'}:${e.message}` });
		}
	}
	return out;
}

// ── §3.2 extraction (ADD-only, ONE LLM call per turn) ─────────────────────────────
//
// The extracting LLM produces additive candidates only; it does NOT decide update/
// delete (D-028). We model the LLM call behind an injected `ExtractFn` so the logic is
// verifiable against a scripted runtime (no live model, NO creds this wave). The real
// wiring drives the §2.1 review fork through the work_item queue (loop.ts). §3.3: when
// the call must reference existing rows, map ids → integer ordinals before the call and
// translate back host-side (anti-hallucination); the ordinal map is built here.

/** The transcript the extractor reasons over (raw turn text). */
export interface ExtractInput {
	/** The just-finished turn's messages (raw — D-029 keeps raw, no summary). */
	turnText: string;
	/** Existing rows the LLM may link/merge against — handed as ORDINALS, never ids (§3.3). */
	existing?: { id: string; content: string }[];
	project?: string;
	/** The transcript's session (table:id) — m0033 provenance onto every stored row (16.6). */
	session?: string;
}

/** The injected extraction call. Returns ADD-only candidates (no id references). */
export type ExtractFn = (prompt: string, ordinals: Map<number, string>) => Promise<MemoryCandidate[]>;

/**
 * Build the §3.3 ordinal map (1-based) for existing rows and the extraction prompt. The
 * prompt is the mem0-style ADD-only instruction (Observation-Date grounding, anti-echo,
 * preserve-specifics) — kept compact here; the worked-examples expansion is a follow-up
 * TODO (adapt mem0's 12 examples to the coding domain). Returns { prompt, ordinals }.
 */
export function buildExtraction(input: ExtractInput): { prompt: string; ordinals: Map<number, string> } {
	const ordinals = new Map<number, string>();
	const lines: string[] = [];
	(input.existing ?? []).forEach((row, i) => {
		const ord = i + 1;
		ordinals.set(ord, row.id);
		lines.push(`  [${ord}] ${row.content}`);
	});

	const prompt =
		`You extract durable, additive memories from a coding-agent turn.\n` +
		`Rules: ADD-only (never decide updates or deletions). Anchor facts to WHEN observed. ` +
		`Do NOT restate the user's words as a memory (anti-echo). Preserve exact identifiers, ` +
		`versions, and file paths. NEVER capture transient failures ("X is down", "API returns 500") ` +
		`— rewrite as a fix ("to do X, use Y") or omit. Refer to existing items by their [N] ordinal, ` +
		`never by id.\n` +
		(lines.length ? `Existing items:\n${lines.join('\n')}\n` : '') +
		`Turn:\n${input.turnText}`;

	return { prompt, ordinals };
}

/** Run extraction (ADD-only) then the §3.4 batch add. The ONE LLM call is `extract`. */
export async function extractAndStore(
	opts: StoreOptions & { extract: ExtractFn },
	input: ExtractInput
): Promise<StoredMemory[]> {
	const { prompt, ordinals } = buildExtraction(input);
	const raw = await opts.extract(prompt, ordinals);
	// D-026 trust boundary: the extractor return is untrusted. Validate the ARRAY shape BEFORE
	// touching .map (a non-array would otherwise throw an anonymous `TypeError: candidates.map is
	// not a function`). Fail NAMED + attributable here — no partial write.
	if (!Array.isArray(raw)) throw new MemoryCandidateShapeError(shapeOf(raw));
	// D-026 element-shape boundary: a valid array wrapper does NOT make each ELEMENT trusted. A
	// null/primitive/missing-content element would hit the provenance spread below (`c.project`)
	// and throw an anonymous `TypeError: Cannot read properties of null` (null) or silently spread
	// into a content-less garbage candidate (primitive). Validate every element at the boundary —
	// raise a NAMED error with its index — instead of duck-typing it downstream. One garbage
	// element fails NAMED with NO partial write (the guard runs fully before any storeMemory call).
	for (let i = 0; i < raw.length; i++) {
		if (!isMemoryCandidate(raw[i])) throw new MemoryCandidateShapeError(shapeOf(raw[i]), i);
	}
	// Carry the project + originating-session provenance through to each candidate.
	const withProject = raw.map((c) => ({
		...c,
		project: c.project ?? input.project,
		session: c.session ?? input.session
	}));
	return storeMemories(opts, withProject);
}
