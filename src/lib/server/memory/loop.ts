// TASK 2.5 — two-tier learning loop + consolidator (MEMORY-SPEC §2, §5; D-027, D-021, D-031).
//
// D-027 two-tier loop:
//   • FAST tier (§2) — in-use writer fork. Every Nth user turn / Mth tool iteration, a
//     review subagent mines the just-finished turn and writes additively. In v2 this is
//     NOT an in-process thread (hermes' shape) — it is a `work_item` (D-021) drained by
//     the background queue, inheriting crash-safe claim tokens, daily caps, stale-GC. The
//     cadence is modulo-hydrated from PERSISTED session counters (§2.2) so it survives the
//     per-message agent rebuild. Tool-whitelisted to memory/skill writes only (§2.1).
//   • SLOW tier (§5) — periodic consolidator (curator). Inactivity-triggered batch merge
//     of near-dup families into umbrellas via `absorbed_into` forwarding (D-031 half 2),
//     archive-not-delete (D-015). The 3-signal classification accepts the model's
//     declaration UNLESS the deterministic guard overrides it for findings/pinned/Tier-0
//     (§5.2 security exception — a poisoned model must not "consolidate away" a finding).
//
// The fork ENQUEUE is the front half of D-022's self-improvement; this module owns the
// cadence + enqueue + the consolidator's deterministic forwarding. The actual review LLM
// call is drained by the orchestrator (shelling the host agent CLI, §9.3) — mocked here.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
// The F-048/F-026-proof deterministic-id enqueue (see enqueueReview below) — NOT a raw CREATE.
import { enqueue } from '../orchestrator/workqueue';
import type { Embedder } from './embed';
import { storeMemories, type MemoryCandidate, type StoredMemory, type ExtractFn, buildExtraction } from './store';
import {
	storeConcepts,
	isConceptCandidate,
	ConceptExtractShapeError,
	type ConceptCandidate,
	type StoredConcept,
	type ExtractConceptsFn
} from './concepts';
import { gateCandidate, captureGate, screen } from './screen';

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

// ── §2.2 two-cadence nudge (modulo-hydrated from persisted counters) ───────────────

export interface ReviewCadence {
	/** Fire memory review every N user turns. */
	memoryEveryNTurns: number;
	/** Fire skill review every M tool iterations. */
	skillEveryMTools: number;
}

export const DEFAULT_CADENCE: ReviewCadence = { memoryEveryNTurns: 5, skillEveryMTools: 10 };

export type ReviewKind = 'memory' | 'skill' | 'combined';

/**
 * Decide whether a review fork should fire given the PERSISTED, MONOTONIC counters
 * (§2.2). Returns the review kind, or null. `combined` when both trip on the same turn
 * (run one fork, not two). Counters are never reset mid-session, so `% N` is meaningful.
 */
export function dueReview(
	userTurnCount: number,
	toolIterCount: number,
	cadence: ReviewCadence = DEFAULT_CADENCE
): ReviewKind | null {
	const mem = userTurnCount > 0 && userTurnCount % cadence.memoryEveryNTurns === 0;
	const skill = toolIterCount > 0 && toolIterCount % cadence.skillEveryMTools === 0;
	if (mem && skill) return 'combined';
	if (mem) return 'memory';
	if (skill) return 'skill';
	return null;
}

/**
 * Increment the persisted session counters (§2.2). Monotonic — never reset mid-session.
 * Returns the new counts so the caller can immediately test `dueReview`.
 */
export async function bumpCounters(
	db: Db,
	sessionId: string,
	delta: { userTurns?: number; toolIters?: number }
): Promise<{ userTurnCount: number; toolIterCount: number }> {
	const sid = assertRecordId(sessionId);
	const [rows] = await db.query<[Array<{ user_turn_count: number; tool_iter_count: number }>]>(
		`UPDATE $sid SET
		   user_turn_count = (user_turn_count OR 0) + $ut,
		   tool_iter_count = (tool_iter_count OR 0) + $ti
		 RETURN AFTER;`,
		{ sid: link(sid), ut: delta.userTurns ?? 0, ti: delta.toolIters ?? 0 }
	);
	return { userTurnCount: rows[0].user_turn_count, toolIterCount: rows[0].tool_iter_count };
}

// ── §2.1 enqueue the review fork as a work_item (D-021 queue, NOT an in-proc thread) ─

export interface EnqueueReviewInput {
	session: string; // table:id
	kind: ReviewKind;
	project?: string;
	/** The raw turn text the fork will mine (D-029 — raw, no summary). */
	turnText: string;
}

/**
 * Enqueue a memory/skill review fork as a `work_item` (§2.1, D-021). The payload carries
 * the turn text + review kind; the orchestrator drains it (shelling the host agent CLI,
 * §9.3) under the daily-spend / PID-lock / spawn-depth caps that double as the
 * poisoned-self-reinjection circuit breaker (§9.3). The work_type is whitelisted to the
 * memory writer; the dedup_scope keys on the session so one review per session in the ACTIVE
 * window. Returns the work_item id, or null when an active review for that session already
 * exists (deduped) — and null too for the interview exclusion below.
 *
 * ── F-048 RESIDUE, CLOSED (BL-R3's written-down DEFERRED item) ──────────────────────────
 * This function used to `CREATE work_item` with a RANDOM id and lean on the m0012
 * `work_item_dedup` UNIQUE index over the computed `dedup_key` VALUE. That key is
 * `work_type|session|dedup_scope|status` — keyed on the MUTABLE `status`, which is precisely
 * the F-048 shape: it guards the INSERT but not the status TRANSITION. Concretely, the hole:
 *
 *   1. enqueueReview(S) → row A, dedup_key = `memory_review|S|S|pending`.
 *   2. The orchestrator CLAIMS A → status flips to `processing` → the VALUE RECOMPUTES to
 *      `memory_review|S|S|processing`, so the `…|pending` slot is now FREE.
 *   3. A second enqueueReview(S) collides with nothing and CREATEs a SECOND row while the
 *      first is still running → the session's turn is mined TWICE. Because the knowledge
 *      tables are append-only (D-015/D-028), that duplicate is not idempotent: it lands as
 *      duplicate memories, downstream of a paid LLM call.
 *
 * It was also exposed to F-026 on the insert itself: on this SurrealDB build a secondary
 * UNIQUE index over a computed VALUE does NOT hold under concurrent inserts.
 *
 * Both halves are now guarded by routing through `enqueue()`, whose unit key is a
 * DETERMINISTIC PRIMARY record id (`work_item:<sha(work_type|session|dedup_scope)>`) that is
 * STABLE across the pending→processing claim — so the `processing` twin is seen and deduped,
 * and the primary key is collision-atomic where the secondary index is not.
 *
 * NO MIGRATION IS NEEDED, for the same reason BL-R3 shipped none: the guard is the record id
 * computed in code, not schema. The m0012 index stays (harmless — the same unit is always the
 * same single row, so it never false-fires) and no existing row changes shape.
 */
export async function enqueueReview(db: Db, input: EnqueueReviewInput): Promise<string | null> {
	// TASK 16.6 (WORKFORCE-SPEC §4.2) — the D-027 FAST-WRITER EXCLUSION for gauntlet
	// interviews: a kind='interview' session is NEVER mined for memories (its transcript
	// contains fixture work — planted defects that must not re-enter any context). The
	// exclusion lives HERE in the memory engine (not in runner discipline) so no future
	// caller can enqueue an interview review by accident. Refusal is a null return (the
	// same shape as the dedup no-op): nothing enqueued, nothing thrown — the interview
	// path is not an error, it is out of scope for the writer fork by design.
	const [krows] = await db.query<[Array<{ kind?: string }>]>(`SELECT kind FROM $sid;`, {
		sid: link(input.session)
	});
	if (krows[0]?.kind === 'interview') return null;

	// One review per session in the active window (D-008). `enqueue()` owns the dedup: it
	// classifies the unit's deterministic row (active ⇒ dedup, terminal ⇒ guarded reuse,
	// absent ⇒ create) and raises only on a genuine write failure. That replaces the old
	// catch-and-string-match: no error-message pattern here can swallow a real fault (F-008).
	const { id, enqueued } = await enqueue(db, {
		workType: 'memory_review',
		payload: { kind: input.kind, turnText: input.turnText },
		priority: 5,
		sessionId: assertRecordId(input.session),
		// A completed review for this session must be re-queueable on the NEXT turn, so the unit
		// key is the session — the same discriminator the old dedup_scope carried.
		dedupScope: assertRecordId(input.session),
		...(input.project ? { projectId: assertRecordId(input.project) } : {})
	});
	// Deduped ⇒ an active review already holds this session: null no-op, exactly as before.
	return enqueued ? id : null;
}

// ── §2.1 the review-memory WRITER FORK — ADD-only, tool-whitelisted to memory/skill ──
//
// This is the WRITE half of the D-027 FAST tier (D-022's self-improvement front half).
// `enqueueReview` (above) puts a `memory_review` work_item on the D-021 queue; the
// orchestrator drains it (shelling the host agent CLI, §9.3 — the review LLM call is the
// injected `extract`/`proposeSkills` seam, mocked in tests). THIS function is what the
// drain runs: it mines the just-finished raw turn (D-029 — raw, no summary-LLM) and writes
// ADDITIVELY (D-028).
//
// ── THE TOOL WHITELIST (§2.1) IS STRUCTURAL, NOT ADVISORY ──
// The fork can call the memory-write and skill-write tools and NOTHING else — no file
// edits, no exec, no git, no raw DB. We enforce this by CAPABILITY, not by a denylist:
// the fork is handed ONE narrow object, `MemoryWriteSurface`, whose only methods are
// `writeMemories` (→ store.ts §3.4, screen-before-embed) and `writeSkill` (→ §5.4a
// synthesis screen, then a screened skill row). The fork closure never receives the `Db`,
// a process/exec handle, a git runner, or an fs handle — so there is no surface on which
// it COULD reach outside the whitelist. A denylist can be bypassed by a path nobody listed;
// a capability the closure was never given cannot be reached at all (D-026 runtime
// complement to the D-018 gates, scoped to the writer).
//
// EVERY fork-written candidate is transcript-derived ⇒ potentially POISONED (D-026), so it
// MUST pass the §3.1b screen-before-embed gate. The memory path inherits that gate from
// store.ts (`gateCandidate` runs inside `storeMemories` BEFORE any embed/insert). The skill
// path runs the SAME gate at synthesis (`screenSkillForGraduation` shape, inlined here to
// avoid an index.ts import cycle): a skill whose description or any step is quarantined does
// NOT graduate — a poisoned chain cannot launder injected instructions into a skill.

/** A skill candidate the review fork proposes (pre-screen, transcript-derived). */
export interface SkillCandidate {
	name: string;
	description: string;
	steps: string[];
	preconditions?: string;
	postconditions?: string;
	/** The causal_chain this skill graduates from (table:id), when known. Omit otherwise. */
	sourceChain?: string;
}

/** A persisted skill row id + the screened body, or a drop reason (quarantine/empty). */
export interface WrittenSkill {
	id: string;
	persisted: boolean;
	dropReason?: string;
}

/**
 * The ONLY capability the writer fork is given (§2.1 tool whitelist). Two methods, both
 * write-scoped to the knowledge stores; NO db/exec/git/fs is reachable through it. The
 * orchestrator constructs the real surface (over a Db + Embedder); tests can hand a fake.
 */
export interface MemoryWriteSurface {
	/** ADD-only memory write — each candidate passes screen-before-embed (store.ts §3.4). */
	writeMemories(candidates: MemoryCandidate[]): Promise<StoredMemory[]>;
	/** Skill write — screened at synthesis (§5.4a); a quarantined part blocks graduation. */
	writeSkill(skill: SkillCandidate): Promise<WrittenSkill>;
	/**
	 * S3 concept write — each candidate is screen-before-embed + embedding-deduped (concepts.ts).
	 * A near-duplicate reinforces the existing concept; a quarantined label/summary never lands.
	 * Same capability discipline as the rest of the surface: the fork never touches `db` directly.
	 */
	writeConcepts(candidates: ConceptCandidate[]): Promise<StoredConcept[]>;
}

/**
 * Build the real {@link MemoryWriteSurface} over a live Db + Embedder. This is the bridge
 * the orchestrator passes into {@link runReviewFork}. It is deliberately the ONLY place a
 * Db is bound for the fork — and even here the Db is captured in TWO closures
 * (`writeMemories`, `writeSkill`) that expose no raw-query escape hatch. The fork closure
 * receives the SURFACE, never `db` itself, so it cannot author an arbitrary query.
 */
export function makeWriteSurface(db: Db, embedder: Embedder): MemoryWriteSurface {
	return {
		writeMemories(candidates: MemoryCandidate[]): Promise<StoredMemory[]> {
			// store.ts runs gateCandidate (DO-NOT-CAPTURE + secret/PII screen) BEFORE embed
			// for every candidate — the screen-before-embed invariant the fork relies on.
			return storeMemories({ db, embedder }, candidates);
		},
		async writeSkill(skill: SkillCandidate): Promise<WrittenSkill> {
			// §5.4a synthesis screen: description + every step pass the SAME §3.1b gate before
			// graduation. A quarantined (or DO-NOT-CAPTURE-dropped) part ⇒ the skill does NOT
			// graduate raw — a poisoned causal_chain cannot launder injected text into a skill.
			const screened = screenSkill(skill);
			if (!screened) {
				return { id: '', persisted: false, dropReason: 'skill-quarantined-or-empty' };
			}
			// Embed the SCREENED skill body (description + steps) — never the raw candidate
			// (§3.1b: the same screen-before-embed invariant as memory; the skill_vec HNSW
			// index requires a 1024-dim vector, D-014). A raw secret in the body was already
			// redacted/blocked by screenSkill above, so this only ever embeds safe text.
			const embedBody = `${screened.description}\n${screened.steps.join('\n')}`;
			const embedding = await embedder.embed(embedBody, 'add');
			const content: Record<string, unknown> = {
				name: screened.name,
				description: screened.description,
				steps: screened.steps,
				embedding,
				status: 'active'
			};
			if (screened.preconditions !== undefined) content.preconditions = screened.preconditions;
			if (screened.postconditions !== undefined) content.postconditions = screened.postconditions;
			if (skill.sourceChain) content.source_causal_chain = link(skill.sourceChain);
			const [rows] = await db.query<[Array<{ id: unknown }>]>(
				`CREATE skill CONTENT $content RETURN AFTER;`,
				{ content }
			);
			return { id: String(rows[0].id), persisted: true };
		},
		writeConcepts(candidates: ConceptCandidate[]): Promise<StoredConcept[]> {
			// concepts.ts screens label+summary BEFORE embed and dedups by embedding cosine — the
			// same screen-before-embed invariant as memory, applied to the semantic concept layer.
			return storeConcepts({ db, embedder }, candidates);
		}
	};
}

/** A screened skill (every part passed §3.1b), or null when any part is dropped/quarantined. */
interface ScreenedSkill {
	name: string;
	description: string;
	steps: string[];
	preconditions?: string;
	postconditions?: string;
}

/**
 * §5.4a synthesis screen for a graduating skill (inlined from index.ts to avoid an import
 * cycle: index.ts imports loop.ts). The description + each step + the optional pre/post
 * conditions pass the DO-NOT-CAPTURE + secret/PII gate. Returns the SCREENED skill, or null
 * if any part is dropped or quarantined (the skill does not graduate raw, D-026).
 */
function screenSkill(skill: SkillCandidate): ScreenedSkill | null {
	const dgate = gateCandidate(skill.description);
	if (!dgate.capture || dgate.screen!.status === 'quarantined') return null;
	if (!skill.name.trim() || skill.steps.length === 0) return null;
	// D-026 — the NAME is an LLM-authored field too: an injected secret or DO-NOT-CAPTURE
	// payload in skill.name must NOT persist unredacted in the skill row (the prior code put
	// the raw name straight onto the output and into the skill_vec embed body). The secret/PII
	// §3.1b screen ALWAYS runs on the name: a quarantined name (e.g. a pasted private key)
	// blocks graduation; a redactable secret is redacted in place before the row is written.
	//
	// CORRECTNESS (wave-v2.2b-c LOW ledger): the DO-NOT-CAPTURE prose gate (captureGate) was
	// authored to screen PROSE memory claims ("the daemon is down", "connection refused") — its
	// single-word triggers (`down`, `timeout`, `unreachable`) over-fire on ordinary hyphenated
	// SKILL-NAME tokens (`down-detector`, `retry-on-timeout`, `recover-from-down-stream`), which
	// are legit kebab-case identifiers, not negative claims. A skill name is a single identifier
	// token (no internal whitespace) — the prose gate therefore applies ONLY when the name reads
	// like prose (contains whitespace, e.g. "the gateway is unreachable right now", which STILL
	// drops). The secret screen runs regardless, so a secret/injection embedded in a token-form
	// name (`sk-ant-…`) is STILL caught and redacted/quarantined.
	const nameIsProse = /\s/.test(skill.name.trim());
	if (nameIsProse && !captureGate(skill.name).capture) return null; // prose DO-NOT-CAPTURE drop
	const nameScreen = screen(skill.name); // §3.1b secret/PII — always, even for token names
	if (nameScreen.status === 'quarantined') return null;
	const screenedName = nameScreen.text;
	if (!screenedName.trim()) return null;
	const steps: string[] = [];
	for (const step of skill.steps) {
		const sgate = gateCandidate(step);
		if (!sgate.capture || sgate.screen!.status === 'quarantined') return null;
		steps.push(sgate.screen!.text);
	}
	const out: ScreenedSkill = { name: screenedName, description: dgate.screen!.text, steps };
	if (skill.preconditions !== undefined) {
		const pg = gateCandidate(skill.preconditions);
		if (!pg.capture || pg.screen!.status === 'quarantined') return null;
		out.preconditions = pg.screen!.text;
	}
	if (skill.postconditions !== undefined) {
		const pg = gateCandidate(skill.postconditions);
		if (!pg.capture || pg.screen!.status === 'quarantined') return null;
		out.postconditions = pg.screen!.text;
	}
	return out;
}

/** The `memory_review` work_item payload the orchestrator drains (shape from enqueueReview). */
export interface ReviewForkPayload {
	kind: ReviewKind;
	/** The raw turn text to mine (D-029 — raw, no summary). */
	turnText: string;
	/** The originating session (table:id) — stamped as m0033 provenance onto each row. */
	session?: string;
	project?: string;
}

/** The injected skill-proposal LLM call (skill/combined kinds). Mocked in tests, like ExtractFn. */
export type ProposeSkillsFn = (turnText: string) => Promise<SkillCandidate[]>;

/**
 * Raised when an injected LLM seam (`extract` / `proposeSkills`) returns a value that is not
 * the contracted shape (D-026: an LLM return is UNTRUSTED input crossing into the fork — it
 * must be shape-validated at the boundary, not duck-typed downstream). The OLD code passed the
 * raw return straight into `.length`/`.map`, so a non-array (the model returned an object, a
 * JSON string, null, or a bare error envelope) threw an anonymous `TypeError: candidates.map
 * is not a function` with no name for what triggered it.
 *
 * The boundary is BOTH halves of the shape: (1) the return must be an ARRAY, and (2) each
 * ELEMENT must be the contracted record (an object with a string `content`). A malformed
 * element — a `null`/`42`/`{}` inside an otherwise-valid array — would otherwise hit the
 * downstream provenance spread (`{ ...c, project: c.project ?? … }`) and throw the SAME
 * anonymous `TypeError: Cannot read properties of null (reading 'project')` this class exists
 * to eliminate. `elementIndex` is set when the failure is a bad element (vs the whole return).
 *
 * This names the trigger (which seam, which element), the catcher (this guard), and what the
 * caller sees (a typed, attributable failure the orchestrator marks the work_item failed on —
 * never a fake-success swallow, F-008).
 */
export class ReviewForkShapeError extends Error {
	constructor(
		public readonly seam: 'extract' | 'proposeSkills',
		public readonly received: string,
		/** Set when the failure is a malformed ELEMENT inside a valid array (vs a non-array return). */
		public readonly elementIndex?: number
	) {
		super(
			elementIndex === undefined
				? `review fork ${seam} returned a non-array (${received}); LLM output is untrusted (D-026)`
				: `review fork ${seam} returned a malformed element at [${elementIndex}] (${received}); LLM output is untrusted (D-026)`
		);
		this.name = 'ReviewForkShapeError';
	}
}

/** Describe an untrusted value for the error message without leaking its (possibly poisoned) body. */
function shapeOf(v: unknown): string {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	return typeof v;
}

/**
 * Element-shape guard for the extract seam (D-026). A {@link MemoryCandidate} MUST be a plain
 * object with a string `content` — that is the only field the downstream provenance spread and
 * the store.ts §3.1b screen rely on. A `null`/primitive/`{}`-missing-content element inside an
 * otherwise-valid array is NOT the contracted shape; it would throw an anonymous TypeError at
 * the spread (`c.project`) — the exact class {@link ReviewForkShapeError} eliminates. Validates
 * at the boundary; does NOT duck-type downstream.
 */
function isMemoryCandidate(v: unknown): v is MemoryCandidate {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { content?: unknown }).content === 'string';
}

export interface RunReviewForkInput {
	payload: ReviewForkPayload;
	/** The narrow write capability (§2.1) — the ONLY thing the fork may touch. */
	surface: MemoryWriteSurface;
	/** The review LLM call for memory candidates (ADD-only). Injected; mocked in tests. */
	extract: ExtractFn;
	/** The review LLM call for skill candidates. Injected; mocked in tests. Optional. */
	proposeSkills?: ProposeSkillsFn;
	/**
	 * S3 — the review LLM call that mines CONCEPTS (semantic nodes) from the turn. Injected;
	 * mocked in tests. Optional — when absent, no concept extraction runs (back-compat). Fires on
	 * the same memory|combined kinds as the memory extractor (concepts are the semantic distillate
	 * of the same turn).
	 */
	extractConcepts?: ExtractConceptsFn;
}

export interface RunReviewForkResult {
	stored: StoredMemory[];
	skills: WrittenSkill[];
	/** S3 — concepts written (or reinforced) this fork. */
	concepts: StoredConcept[];
	/** How many candidates the LLM proposed (memory) — for the explain/audit view. */
	memoryCandidates: number;
	/** How many skill candidates the LLM proposed. */
	skillCandidates: number;
	/** How many concept candidates the LLM proposed (S3). */
	conceptCandidates: number;
}

/**
 * Run the §2.1 review-memory writer fork over one drained `memory_review` work_item. This is
 * the WRITE-PATH the orchestrator invokes after it (the privileged side) makes the review LLM
 * call (§9.3) — passed in as `extract` / `proposeSkills` so this module stays creds-free and
 * deterministic under test. The fork:
 *
 *   1. (kind memory|combined) runs the ADD-only extractor over the RAW turn (D-029), then
 *      writes each candidate through the surface → screen-before-embed (D-028 + §3.1b).
 *   2. (kind skill|combined) runs the skill proposer, then writes each through the surface →
 *      synthesis screen (a quarantined part blocks graduation).
 *   3. Stamps m0033 provenance (originating session) onto every memory candidate so the D-029
 *      recall filter can exclude interview-born rows.
 *
 * The fork CANNOT write outside memory/skill (it only has `surface`) and CANNOT launder an
 * unscreened secret (every write routes through the §3.1b gate). Both are proven in tests.
 *
 * Shadow paths: nil/blank turnText ⇒ no extraction (returns empty, writes nothing); an
 * extractor returning [] ⇒ empty result; an extractor/proposer THROW propagates (the
 * orchestrator marks the work_item failed and the D-021 caps bound any retry) — the fork
 * does NOT swallow an LLM error into a fake-success, F-008.
 *
 * MISSED-DEFECT LEDGER (B2b) — NAMED SEAM, NOT BUILT. The fork is also the natural place to
 * record a "this turn missed defect X" signal for the slow-tier curator to learn from. Its
 * schema (table/columns) is a DEFERRED operator/DATA-MODEL decision (tracked as B2b); it is
 * deliberately NOT invented here. When it lands, it hooks in RIGHT HERE — after the writes,
 * over the same screened candidate set — through the SAME `surface` (no new capability): do
 * not add a Db/exec path to the fork to build it.
 */
export async function runReviewFork(input: RunReviewForkInput): Promise<RunReviewForkResult> {
	const { payload, surface, extract, proposeSkills, extractConcepts } = input;
	const result: RunReviewForkResult = {
		stored: [],
		skills: [],
		concepts: [],
		memoryCandidates: 0,
		skillCandidates: 0,
		conceptCandidates: 0
	};

	const turn = typeof payload.turnText === 'string' ? payload.turnText : '';
	const wantMemory = payload.kind === 'memory' || payload.kind === 'combined';
	const wantSkill = payload.kind === 'skill' || payload.kind === 'combined';

	// ── memory write path (ADD-only, screen-before-embed) ──
	if (wantMemory && turn.trim()) {
		// The ONE LLM call (mem0-style ADD-only prompt). buildExtraction owns the prompt +
		// ordinal map (§3.3); we pass no existing rows here (the fork is additive-only).
		const { prompt, ordinals } = buildExtraction({ turnText: turn, project: payload.project, session: payload.session });
		const raw = await extract(prompt, ordinals);
		// D-026 trust boundary: the LLM return is untrusted — validate the contracted array
		// shape BEFORE touching .length/.map (a non-array would otherwise throw an anonymous
		// TypeError). Fail with a NAMED, attributable error the orchestrator can act on.
		if (!Array.isArray(raw)) throw new ReviewForkShapeError('extract', shapeOf(raw));
		const candidates = raw;
		result.memoryCandidates = candidates.length;
		// D-026 element-shape boundary: the array wrapper being valid does NOT make each ELEMENT
		// trusted. A null/primitive/missing-content element would hit the provenance spread below
		// (`c.project`) and throw an anonymous `TypeError: Cannot read properties of null` — the
		// exact symptom ReviewForkShapeError exists to eliminate. Validate the shape of every
		// element at the boundary (raise a NAMED, attributable error the orchestrator can act on)
		// instead of duck-typing it downstream. One garbage element fails NAMED with its index.
		for (let i = 0; i < candidates.length; i++) {
			if (!isMemoryCandidate(candidates[i])) {
				throw new ReviewForkShapeError('extract', shapeOf(candidates[i]), i);
			}
		}
		// Carry project + originating-session provenance onto every candidate (m0033). store.ts
		// screens BEFORE embed, so a candidate carrying a secret is redacted/quarantined here.
		const withProvenance: MemoryCandidate[] = candidates.map((c) => ({
			...c,
			project: c.project ?? payload.project,
			session: c.session ?? payload.session
		}));
		result.stored = await surface.writeMemories(withProvenance);
	}

	// ── S3 concept mine path (semantic distillate of the same turn) ──
	if (wantMemory && extractConcepts && turn.trim()) {
		const rawC = await extractConcepts(turn);
		// D-026 trust boundary: the concept extractor return is untrusted — validate the array
		// shape AND each element BEFORE writing (a non-array / malformed element would otherwise
		// throw an anonymous TypeError in storeConcepts). Fail NAMED + attributable.
		if (!Array.isArray(rawC)) throw new ConceptExtractShapeError(shapeOf(rawC));
		for (let i = 0; i < rawC.length; i++) {
			if (!isConceptCandidate(rawC[i])) throw new ConceptExtractShapeError(shapeOf(rawC[i]), i);
		}
		result.conceptCandidates = rawC.length;
		// Carry the turn's project onto each candidate (concepts.ts dedups within project scope).
		const withProject: ConceptCandidate[] = rawC.map((c) => ({ ...c, project: c.project ?? payload.project }));
		result.concepts = await surface.writeConcepts(withProject);
	}

	// ── skill write path (synthesis-screened) ──
	if (wantSkill && proposeSkills && turn.trim()) {
		const proposed = await proposeSkills(turn);
		// Same D-026 trust boundary as `extract` above — the proposer is the identical
		// untrusted LLM seam; a non-array must fail NAMED, not anonymous-TypeError downstream.
		if (!Array.isArray(proposed)) throw new ReviewForkShapeError('proposeSkills', shapeOf(proposed));
		result.skillCandidates = proposed.length;
		for (const s of proposed) {
			// Per-item isolation — one un-graduatable (poisoned) skill never drops the rest.
			try {
				result.skills.push(await surface.writeSkill(s));
			} catch (err) {
				result.skills.push({ id: '', persisted: false, dropReason: `skill-write-failed:${(err as Error).message}` });
			}
		}
	}

	return result;
}

// ── §5 slow consolidator (curator) — archive-not-delete + absorbed_into forwarding ──

/** Classes the §5.2 security exception protects from model-declared consolidation. */
const PROTECTED_SOURCES = new Set(['finding', 'security_finding']);

export interface ConsolidateInput {
	/** The umbrella row the family is absorbed into (table:id). */
	umbrella: string;
	/** The member rows the model declared absorbed (table:id each). */
	members: string[];
	reason?: string;
}

export interface ConsolidateResult {
	absorbed: string[];
	/** Members the deterministic guard REFUSED to absorb (§5.2 security exception). */
	refused: string[];
	/** references edges rewritten to point at the umbrella (§5.1 forwarding). */
	rewiredEdges: number;
}

/**
 * Consolidate a near-dup family into an umbrella (§5.1, D-031 half 2). For each member:
 *   • The deterministic guard WINS over the model for findings/pinned/Tier-0 (§5.2): such
 *     a member is REFUSED — never buried — so a poisoned model can't consolidate away a
 *     security finding.
 *   • Otherwise the member is soft-archived (status="archived", NOT deleted — §5.3),
 *     stamped with `absorbed_into` + `superseded_by` = umbrella, and its inbound/outbound
 *     `references` edges are rewired to the umbrella so the graph stays traversable (no
 *     dangling edges, §5.1 forwarding).
 */
export async function consolidate(db: Db, input: ConsolidateInput): Promise<ConsolidateResult> {
	const umbrellaId = assertRecordId(input.umbrella);
	const absorbed: string[] = [];
	const refused: string[] = [];
	let rewiredEdges = 0;

	for (const memberRaw of input.members) {
		const memberId = assertRecordId(memberRaw);
		if (memberId === umbrellaId) continue;

		// §5.2 deterministic guard: refuse to absorb a protected class regardless of the
		// model's declaration. Check pinned (tier 0) + source-class.
		const [grows] = await db.query<[Array<{ tier?: number; source?: string }>]>(
			`SELECT tier, source FROM $m;`,
			{ m: link(memberId) }
		);
		const row = grows[0];
		const protectedClass =
			!!row && ((row.tier ?? 1) === 0 || (row.source ? PROTECTED_SOURCES.has(row.source) : false));
		if (protectedClass) {
			refused.push(memberId);
			continue;
		}

		// Rewire references edges pointing AT or FROM the member onto the umbrella (§5.1):
		// no dangling edges; the graph stays traversable. RETURN AFTER counts the rewired
		// edges per statement (one result entry per statement).
		const rewire = await db.query<[Array<unknown>, Array<unknown>]>(
			`UPDATE references SET out = $u WHERE out = $m RETURN AFTER;
			 UPDATE references SET in = $u WHERE in = $m RETURN AFTER;`,
			{ u: link(umbrellaId), m: link(memberId) }
		);
		rewiredEdges += (rewire[0]?.length ?? 0) + (rewire[1]?.length ?? 0);

		// Soft-archive the member (D-015) — never DELETE.
		await db.query(
			`UPDATE $m SET status = "archived", archived_at = time::now(),
			   archive_reason = $reason, absorbed_into = $u, superseded_by = $u;
			 CREATE memory_history CONTENT { memory: $m, op: "archive", after: { absorbed_into: $u } };`,
			{ m: link(memberId), u: link(umbrellaId), reason: input.reason ?? 'consolidated into umbrella' }
		);
		absorbed.push(memberId);
	}

	return { absorbed, refused, rewiredEdges };
}
