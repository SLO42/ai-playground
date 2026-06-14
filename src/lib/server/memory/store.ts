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
 * Sanitize a per-item drop reason for the audit trail: a SurrealDB CREATE error (e.g. a UNIQUE
 * index clash) can embed the un-persisted row's internal record id `memory:<id>` into its message.
 * The audit reason should name the FAILURE (field/class), not a transient internal id — replace any
 * `memory:<id>` token with the bare table name (`memory:<redacted>`). Keeps the named class + message
 * meaning while never persisting a record id that was never committed.
 */
function sanitizeDropReason(reason: string): string {
	return reason.replace(/\bmemory:[A-Za-z0-9_⟨⟩-]+/g, 'memory:<redacted>');
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
 * D-026 — a candidate field authored by the untrusted extractor violated the `memory` table's
 * schema contract for that field's TYPE/ASSERT. This is the ONE error for the WHOLE
 * untrusted-extractor-output shape class (not a field-by-field family): {@link assertCandidateShape}
 * checks every schema-constrained candidate field at the store boundary and raises THIS — naming the
 * offending `field` and its `received` shape (via {@link shapeOf}, never the possibly-poisoned body) —
 * BEFORE screen/embed/link/CREATE.
 *
 * Why one validator, not one guard per field (error-learning architectural-smell escalation): each
 * prior wave guarded SOME fields (content, then project/session); the red-team immediately reproduced
 * the SAME class on the NEXT schema field (`kind` → "Found 42 for field kind … expected a string`;
 * `tags` → "expected option<array<string>>") as a generic SurrealDB type error at CREATE. The fix is
 * the LAYER: validate the candidate against the FULL schema contract ONCE, so a malformed value in ANY
 * constrained field is a NAMED D-026 rejection at the boundary — the class is CLOSED, not the next field.
 *
 * Names the trigger (which schema-constrained field + its received shape), the catcher (assertCandidateShape
 * in storeMemory, before any side effect), and what the caller sees (a typed, attributable failure —
 * surfaced by name in the storeMemories per-item dropReason; never a fake-success swallow, F-008).
 */
export class MemoryCandidateFieldError extends Error {
	override readonly name = 'MemoryCandidateFieldError';
	constructor(
		/** The schema-constrained candidate field that violated its contract. */
		public readonly field: string,
		/** The received shape (shapeOf — type/array/null), or a contract descriptor; never the raw body. */
		public readonly received: string,
		/** The schema contract the value failed (e.g. `non-empty string`, `option<array<string>>`). */
		public readonly expected: string
	) {
		super(
			`candidate field \`${field}\` violates its schema contract: received ${received}, ` +
				`expected ${expected}; extractor output is untrusted (D-026)`
		);
	}
}

/** A {@link MemoryCandidate} is a plain object with a string `content` (the only field the screen relies on). */
function isMemoryCandidate(v: unknown): v is MemoryCandidate {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { content?: unknown }).content === 'string';
}

/** The `kind` ASSERT set from the `memory` schema (m0005). Keep in lock-step with schema.ts. */
const MEMORY_KINDS: readonly MemoryKind[] = ['semantic', 'episodic', 'procedural'];
/** `importance` documented range (DATA-MODEL §4.5: 0..10; schema DEFAULT 5.0). */
const IMPORTANCE_MIN = 0;
const IMPORTANCE_MAX = 10;

/**
 * D-026 FULL-shape boundary: validate the COMPLETE untrusted-extractor candidate against the `memory`
 * table's schema contract (m0005 + m0033) ONCE, BEFORE any screen/embed/link/CREATE. Every LLM-authored
 * field the schema constrains is checked here so a malformed value in ANY of them fails NAMED at the
 * boundary ({@link MemoryCandidateFieldError}) instead of as a generic SurrealDB type error at CREATE.
 *
 * Contract (offending field → schema constraint):
 *   - content     non-empty string                          (TYPE string; screen/embed depend on it)
 *   - project     string id or absent                       (option<record<project>>; format → assertRecordId at link)
 *   - session     string id or absent                       (option<record<session>>; format → assertRecordId at link)
 *   - kind        one of MEMORY_KINDS or absent             (string ASSERT IN [...])
 *   - namespace   non-empty string or absent                (string DEFAULT "default")
 *   - key         string or absent                          (option<string>)
 *   - tags        array of strings or absent                (option<array<string>>)
 *   - source      string or absent                          (option<string>)
 *   - importance  finite number in [0,10] or absent         (float; DATA-MODEL §4.5 range)
 *
 * A falsy non-string (`false`/`0`) is rejected too (never silently treated as absent — F-008). The
 * empty string `''` is a valid string shape but rejected for content/namespace as non-empty is required.
 * Mutates nothing; throws {@link MemoryCandidateFieldError} or returns.
 */
function assertCandidateShape(c: MemoryCandidate): void {
	// content — required non-empty string (the screen + embed read it; an empty row is useless).
	// A non-string reports its shape; a string that is empty or whitespace-only reports "empty string".
	if (typeof c.content !== 'string') {
		throw new MemoryCandidateFieldError('content', shapeOf(c.content), 'non-empty string');
	}
	if (c.content.trim() === '') {
		throw new MemoryCandidateFieldError('content', 'empty string', 'non-empty string');
	}

	// provenance links — string id (format validated at link()) or absent. A non-string (incl. a
	// FALSY non-string) is NAMED here, never an anonymous IdentifierError mid-pipeline nor a silent omit.
	for (const field of ['project', 'session'] as const) {
		const v = c[field];
		if (v !== undefined && typeof v !== 'string') {
			throw new MemoryCandidateFieldError(field, shapeOf(v), 'string record id or absent');
		}
	}

	// kind — must be in the schema ASSERT set when present (else SurrealDB rejects at CREATE).
	if (c.kind !== undefined && (typeof c.kind !== 'string' || !MEMORY_KINDS.includes(c.kind as MemoryKind))) {
		throw new MemoryCandidateFieldError(
			'kind',
			typeof c.kind === 'string' ? `"${c.kind}"` : shapeOf(c.kind),
			`one of ${JSON.stringify(MEMORY_KINDS)} or absent`
		);
	}

	// namespace — non-empty string or absent (it feeds the dedup_key VALUE; an empty/non-string breaks it).
	if (c.namespace !== undefined) {
		if (typeof c.namespace !== 'string') {
			throw new MemoryCandidateFieldError('namespace', shapeOf(c.namespace), 'non-empty string or absent');
		}
		if (c.namespace.trim() === '') {
			throw new MemoryCandidateFieldError('namespace', 'empty string', 'non-empty string or absent');
		}
	}

	// key / source — option<string>: a string or absent.
	for (const field of ['key', 'source'] as const) {
		const v = c[field];
		if (v !== undefined && typeof v !== 'string') {
			throw new MemoryCandidateFieldError(field, shapeOf(v), 'string or absent');
		}
	}

	// tags — option<array<string>>: an array whose every element is a string, or absent.
	if (c.tags !== undefined) {
		if (!Array.isArray(c.tags)) {
			throw new MemoryCandidateFieldError('tags', shapeOf(c.tags), 'option<array<string>> (array or absent)');
		}
		for (let i = 0; i < c.tags.length; i++) {
			if (typeof c.tags[i] !== 'string') {
				throw new MemoryCandidateFieldError(`tags[${i}]`, shapeOf(c.tags[i]), 'string (every tags element)');
			}
		}
	}

	// importance — float in the documented 0..10 range, or absent. Non-number / NaN / Infinity / out-of-range
	// all fail NAMED here rather than as a SurrealDB type error (non-number) or a silent bad score (out-of-range).
	if (c.importance !== undefined) {
		if (typeof c.importance !== 'number' || !Number.isFinite(c.importance)) {
			throw new MemoryCandidateFieldError('importance', shapeOf(c.importance), `finite number in [${IMPORTANCE_MIN},${IMPORTANCE_MAX}] or absent`);
		}
		if (c.importance < IMPORTANCE_MIN || c.importance > IMPORTANCE_MAX) {
			throw new MemoryCandidateFieldError('importance', `${c.importance}`, `number in [${IMPORTANCE_MIN},${IMPORTANCE_MAX}]`);
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

	// D-026 FULL-shape boundary — validate the WHOLE untrusted-extractor candidate against the
	// `memory` schema contract (every constrained field, not just provenance) BEFORE any
	// screen/embed/link/CREATE. A malformed value in ANY field fails NAMED + attributable here,
	// writing nothing — never a generic SurrealDB type error at CREATE (the closed shape class).
	assertCandidateShape(c);

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
			// the failure by its NAMED class (D-026 full-shape rejections surface as
			// MemoryCandidateFieldError, not the misleading "insert-failed") — every error has a name.
			// Sanitize the reason: a SurrealDB CREATE error can embed the un-persisted row's internal
			// `memory:<id>` — strip it (field/class name only, never a never-committed record id).
			const e = err as Error;
			out.push({
				id: '',
				screenStatus: 'quarantined',
				persisted: false,
				dropReason: sanitizeDropReason(`${e.name || 'insert-failed'}:${e.message}`)
			});
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
