// BL-8 — brain observability READ-ONLY listers (BRAIN-OBSERVABILITY-SPEC §3/§6).
//
// Three currently-dark tables get thin read-only projections for the Memory-cluster lenses:
//   • memory_history    — the append-only add/supersede/archive audit trail (§5.2, D-015).
//   • skill + causal_chain — the learned-skill graduation pipeline (§4.14).
//   • retrieval_outcome — the D-030 recall→cite→utilize signal (§4.13, BL-7A).
//
// LOCKED INVARIANTS (spec §2):
//   1. READ-ONLY. Every query here is a SELECT. No CREATE/UPDATE/DELETE/MERGE on any table.
//      A GC/reaper/mutator is NEVER invoked from this module (it only reads).
//   2. NO new schema. All three tables exist (schema.ts m0005/m0014/m0013); these are pure
//      read projections + page loaders. No DEFINE.
//   3. D-026 on display. memory_history before/after snapshots and skill bodies are memory
//      CONTENT — every rendered text field is screen()'d (secret/PII redact-or-quarantine)
//      AND has fence sentinels stripped (scrubComplete) so a stored body can never forge a
//      fence boundary or surface a raw secret. We render the SCREENED text, never the raw.
//   4. Honest states (F-008). Empty → []; an un-cited memory is reported as recalled-not-cited,
//      never a fabricated score.
//   5. F-013. Every datetime is ISO-coerced in the normalizer; absent → undefined (UI → '—'),
//      never str(undefined).
//
// Boundary discipline (D-016): record-id links bind via $param (assertRecordId chokepoint);
// no interpolated ids. Reads are bounded by an explicit LIMIT (F-014).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screen, type ScreenStatus } from './screen';
import { scrubComplete } from './fence';

/** Validate a `table:id` link string at the D-016 chokepoint, wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Coerce a SurrealDB datetime (or any value) to an ISO string, or undefined when absent
 * (F-013/F-015). NEVER returns the literal string "undefined" — an absent datetime is
 * `undefined` so the UI renders '—'.
 */
function isoOrUndef(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (v instanceof Date) return v.toISOString();
	const s = String(v);
	return s && s !== 'undefined' && s !== 'null' ? s : undefined;
}

/**
 * D-026 display screen: run the §3.1b secret/PII screen over a to-be-rendered body AND strip
 * any embedded fence sentinel, then return the SAFE text + screen status. This is the single
 * chokepoint every rendered content/snapshot/skill-body field passes through — a stored body
 * carrying a smuggled secret or a forged `⎆END_REFERENCE⎆` sentinel renders as inert DATA, not
 * a raw secret and not at an instruction position. Non-string / nil → '' (honest blank).
 */
export function screenForDisplay(body: unknown): { text: string; status: ScreenStatus; reasons: string[] } {
	if (typeof body !== 'string' || body.length === 0) {
		return { text: '', status: 'clean', reasons: [] };
	}
	const scr = screen(body);
	// Strip fence sentinels AFTER screening so a body that embeds `⎆END_REFERENCE⎆ SYSTEM: …`
	// cannot render a second close-sentinel (the D-026 fence-forgery vector) — it lands as
	// plain inert text. scrubComplete is a pure string strip (no straddle concern on a
	// complete body).
	return { text: scrubComplete(scr.text), status: scr.status, reasons: scr.reasons };
}

// ── (1) memory_history lens ─────────────────────────────────────────────────────────

/** One memory_history audit entry, projected + screened for display. */
export interface MemoryHistoryRow {
	id: string;
	/** The memory row this entry audits (record id), or undefined if the link was NONE. */
	memory?: string;
	op: 'add' | 'supersede' | 'archive';
	/** Screened before-snapshot content (the prior body), '' when absent. */
	before?: string;
	/** Screened after-snapshot content (the new body), '' when absent. */
	after?: string;
	/** The screen status stamped on the after-snapshot at write (clean/redacted/quarantined). */
	screenStatus?: string;
	/** The screen status our DISPLAY screen computed (defence-in-depth — may differ if a body
	 *  was written before a screen rule existed). */
	displayStatus: ScreenStatus;
	/** ISO timestamp (F-013), undefined → UI '—'. */
	at?: string;
}

interface RawHistory {
	id: unknown;
	memory?: unknown;
	op: string;
	before?: { content?: unknown; screen_status?: unknown } | null;
	after?: { content?: unknown; screen_status?: unknown } | null;
	at?: unknown;
}

function normHistory(r: RawHistory): MemoryHistoryRow {
	const beforeScr = screenForDisplay(r.before?.content);
	const afterScr = screenForDisplay(r.after?.content);
	// The display status is the most-severe of the two snapshots (quarantined > redacted > clean).
	const sev = (s: ScreenStatus) => (s === 'quarantined' ? 2 : s === 'redacted' ? 1 : 0);
	const displayStatus = sev(afterScr.status) >= sev(beforeScr.status) ? afterScr.status : beforeScr.status;
	const writeStatus = isoOrUndef(r.after?.screen_status) ?? (r.after?.screen_status != null ? String(r.after.screen_status) : undefined);
	return {
		id: String(r.id),
		...(r.memory != null ? { memory: String(r.memory) } : {}),
		op: (['add', 'supersede', 'archive'].includes(r.op) ? r.op : 'add') as MemoryHistoryRow['op'],
		...(beforeScr.text ? { before: beforeScr.text } : {}),
		...(afterScr.text ? { after: afterScr.text } : {}),
		...(writeStatus ? { screenStatus: writeStatus } : {}),
		displayStatus,
		...(isoOrUndef(r.at) ? { at: isoOrUndef(r.at) } : {})
	};
}

/**
 * List memory_history audit entries, newest-first, screened for display. When `memoryId` is
 * given, scoped to that memory's trail (per-memory drill-down, spec §4 D2); otherwise the
 * global recent-activity feed. Bounded by LIMIT (F-014). Returns [] when empty (F-008).
 */
export async function listMemoryHistory(
	db: Db,
	memoryId?: string,
	limit = 100
): Promise<MemoryHistoryRow[]> {
	const where = memoryId ? `WHERE memory = $memory` : '';
	const params: Record<string, unknown> = { limit };
	if (memoryId) params.memory = link(memoryId);
	const [rows] = await db.query<[RawHistory[]]>(
		`SELECT id, memory, op, before, after, at
		   FROM memory_history
		   ${where}
		  ORDER BY at DESC
		  LIMIT $limit;`,
		params
	);
	return (rows ?? []).map(normHistory);
}

// ── (2) learned-skills + causal-chain lens ──────────────────────────────────────────

/** A graduated/learned skill, projected + screened for display. */
export interface SkillRow {
	id: string;
	/** Screened skill name. */
	name: string;
	/** Screened skill description (the body — D-026 screened/fenced-inert). */
	description: string;
	/** Screened ordered steps. */
	steps: string[];
	successCount: number;
	failureCount: number;
	status: 'active' | 'archived' | 'superseded';
	/** ISO graduation date (F-013), undefined → '—'. */
	graduatedAt?: string;
	/** ISO last-used (F-013), undefined → '—' / "not yet used". */
	lastUsed?: string;
	/** The causal_chain this skill graduated from (record id), for the expand-to-chain view. */
	sourceCausalChain?: string;
	/** Our display screen status over the body (defence-in-depth). */
	displayStatus: ScreenStatus;
}

interface RawSkill {
	id: unknown;
	name?: unknown;
	description?: unknown;
	steps?: unknown;
	success_count?: unknown;
	failure_count?: unknown;
	status?: unknown;
	graduated_at?: unknown;
	last_used?: unknown;
	source_causal_chain?: unknown;
}

function normSkill(r: RawSkill): SkillRow {
	const nameScr = screenForDisplay(r.name);
	const descScr = screenForDisplay(r.description);
	const rawSteps = Array.isArray(r.steps) ? r.steps : [];
	const stepScrs = rawSteps.map((s) => screenForDisplay(s));
	const sev = (s: ScreenStatus) => (s === 'quarantined' ? 2 : s === 'redacted' ? 1 : 0);
	const displayStatus = [nameScr, descScr, ...stepScrs]
		.map((s) => s.status)
		.reduce<ScreenStatus>((acc, s) => (sev(s) > sev(acc) ? s : acc), 'clean');
	const status = (['active', 'archived', 'superseded'].includes(String(r.status)) ? String(r.status) : 'active') as SkillRow['status'];
	return {
		id: String(r.id),
		name: nameScr.text,
		description: descScr.text,
		steps: stepScrs.map((s) => s.text),
		successCount: Number(r.success_count ?? 0),
		failureCount: Number(r.failure_count ?? 0),
		status,
		...(isoOrUndef(r.graduated_at) ? { graduatedAt: isoOrUndef(r.graduated_at) } : {}),
		...(isoOrUndef(r.last_used) ? { lastUsed: isoOrUndef(r.last_used) } : {}),
		...(r.source_causal_chain != null ? { sourceCausalChain: String(r.source_causal_chain) } : {}),
		displayStatus
	};
}

/**
 * List learned skills, graduated-first then most-used, screened for display. Bounded by LIMIT
 * (F-014). Returns [] when no skill graduated yet (the UI shows the honest "no skills graduated
 * yet" empty state, F-008). All content fields are display-screened (D-026).
 */
export async function listSkills(db: Db, limit = 100): Promise<SkillRow[]> {
	const [rows] = await db.query<[RawSkill[]]>(
		`SELECT id, name, description, steps, success_count, failure_count, status,
		        graduated_at, last_used, source_causal_chain
		   FROM skill
		  ORDER BY graduated_at DESC, success_count DESC
		  LIMIT $limit;`,
		{ limit }
	);
	return (rows ?? []).map(normSkill);
}

/** A causal_chain (trigger→outcome) row, screened for display. */
export interface CausalChainRow {
	id: string;
	/** Screened trigger text (the situation that fired). */
	trigger: string;
	/** Screened outcome text (what worked). */
	outcome: string;
	kind: 'debug' | 'refactor' | 'feature' | 'fix';
	success: boolean;
	confidence: number;
	/** ISO graduation date (F-013), undefined → '—'. */
	graduatedAt?: string;
	/** ISO created date (F-013). */
	createdAt?: string;
	/** Our display screen status over trigger+outcome. */
	displayStatus: ScreenStatus;
}

interface RawChain {
	id: unknown;
	trigger?: unknown;
	outcome?: unknown;
	kind?: unknown;
	success?: unknown;
	confidence?: unknown;
	graduated_at?: unknown;
	created_at?: unknown;
}

function normChain(r: RawChain): CausalChainRow {
	const trigScr = screenForDisplay(r.trigger);
	const outScr = screenForDisplay(r.outcome);
	const sev = (s: ScreenStatus) => (s === 'quarantined' ? 2 : s === 'redacted' ? 1 : 0);
	const displayStatus = sev(trigScr.status) >= sev(outScr.status) ? trigScr.status : outScr.status;
	const kind = (['debug', 'refactor', 'feature', 'fix'].includes(String(r.kind)) ? String(r.kind) : 'feature') as CausalChainRow['kind'];
	return {
		id: String(r.id),
		trigger: trigScr.text,
		outcome: outScr.text,
		kind,
		success: r.success === true,
		confidence: Number(r.confidence ?? 0),
		...(isoOrUndef(r.graduated_at) ? { graduatedAt: isoOrUndef(r.graduated_at) } : {}),
		...(isoOrUndef(r.created_at) ? { createdAt: isoOrUndef(r.created_at) } : {}),
		displayStatus
	};
}

/**
 * List causal_chains. When `skillId` is given, returns the source chain that produced that
 * skill (the expand-to-chain drill-down, spec §4); otherwise the recent chains feed. Bounded.
 * Screened for display (D-026). Returns [] when empty (F-008).
 */
export async function listCausalChains(db: Db, skillId?: string, limit = 100): Promise<CausalChainRow[]> {
	if (skillId) {
		// The chain a skill graduated FROM (follow skill.source_causal_chain). One read,
		// $param-bound id (D-016). Empty array when the skill has no recorded source chain.
		const [rows] = await db.query<[RawChain[]]>(
			`SELECT id, trigger, outcome, kind, success, confidence, graduated_at, created_at
			   FROM causal_chain
			  WHERE id IN (SELECT VALUE source_causal_chain FROM $skill WHERE source_causal_chain != NONE)
			  LIMIT $limit;`,
			{ skill: link(skillId), limit }
		);
		return (rows ?? []).map(normChain);
	}
	const [rows] = await db.query<[RawChain[]]>(
		`SELECT id, trigger, outcome, kind, success, confidence, graduated_at, created_at
		   FROM causal_chain
		  ORDER BY created_at DESC
		  LIMIT $limit;`,
		{ limit }
	);
	return (rows ?? []).map(normChain);
}

/**
 * Resolve a set of causal_chain rows by id in ONE bounded read (the skills lens expands each
 * skill to its source chain; this avoids an N+1). Screened for display (D-026). Ids are bound
 * via $param (D-016). Returns a Map chainId→row; ids with no live chain are simply absent.
 */
export async function listCausalChainsByIds(db: Db, ids: string[]): Promise<Map<string, CausalChainRow>> {
	const map = new Map<string, CausalChainRow>();
	const valid = Array.from(new Set(ids.filter(Boolean)));
	if (valid.length === 0) return map;
	const links = valid.map((id) => link(id));
	const [rows] = await db.query<[RawChain[]]>(
		`SELECT id, trigger, outcome, kind, success, confidence, graduated_at, created_at
		   FROM causal_chain WHERE id IN $ids;`,
		{ ids: links }
	);
	for (const r of rows ?? []) {
		const norm = normChain(r);
		map.set(norm.id, norm);
	}
	return map;
}

// ── (3) retrieval_outcome utilization lens (D-030 signal) ────────────────────────────

/** Per-memory utilization aggregate: recalled vs cited vs utilized (the D-030 signal). */
export interface UtilizationRow {
	/** The memory record id this aggregate is for. */
	memory: string;
	/** Screened memory content (a short label for the row), '' when the memory is gone. */
	content: string;
	/** Total retrieval_outcome rows (times this memory was RECALLED/injected). */
	recalled: number;
	/** How many of those were CITED ([#N] parsed). */
	cited: number;
	/** How many were UTILIZED (cited-or-implicit-path-hit). */
	utilized: number;
	/** Mean rank/score input across the outcome rows (the ranker's signal). */
	avgScore: number;
	/** Convenience flag: recalled at least once but never cited (the BL-7A "is the loop
	 *  working" / BL-7B low-value candidate filter). HONEST — derived from real counts. */
	recalledNeverCited: boolean;
	/** ISO timestamp of the most recent recall (F-013). */
	lastRecalledAt?: string;
}

interface RawUtil {
	memory: unknown;
	recalled?: unknown;
	cited?: unknown;
	utilized?: unknown;
	avg_score?: unknown;
	last_at?: unknown;
}

/**
 * Per-memory utilization leaderboard from retrieval_outcome (the D-030 signal, spec §4 Util
 * lens). Aggregates recalled (row count) / cited (sum) / utilized (sum) / mean score per memory.
 * Ordered most-recalled-first by default. Honest (F-008): a memory recalled but never cited
 * shows recalledNeverCited=true — NOT a fabricated score. The memory content is screened for
 * display (D-026) and may be '' if the memory row was archived/removed (the outcome rows
 * persist; we report the id honestly).
 *
 * `recalledNeverCitedOnly` filters to the low-value candidates (BL-7B view-only surface).
 * Bounded by LIMIT (F-014).
 */
export async function listRetrievalOutcomes(
	db: Db,
	opts: { memoryId?: string; recalledNeverCitedOnly?: boolean; limit?: number } = {}
): Promise<UtilizationRow[]> {
	const limit = opts.limit ?? 100;
	const where = opts.memoryId ? `WHERE memory = $memory` : `WHERE memory != NONE`;
	const params: Record<string, unknown> = { limit };
	if (opts.memoryId) params.memory = link(opts.memoryId);
	// One GROUP BY aggregate over retrieval_outcome. `cited`/`utilized` are bools; SUM over a
	// bool counts the true rows. count() is total recalls. ORDER BY recalled DESC (leaderboard).
	// Bool→1/0 in the projection so math::sum counts the true rows. SurrealDB's math::sum over a
	// raw bool yields 0, and `<int>false` is a hard cast error — an IF…THEN…ELSE…END expression
	// is the portable form. count() is the total recalls (every outcome row = one recall event).
	const [rows] = await db.query<[RawUtil[]]>(
		`SELECT memory,
		        count() AS recalled,
		        math::sum(IF cited = true THEN 1 ELSE 0 END) AS cited,
		        math::sum(IF utilized = true THEN 1 ELSE 0 END) AS utilized,
		        math::mean(score) AS avg_score,
		        time::max(created_at) AS last_at
		   FROM retrieval_outcome
		   ${where}
		  GROUP BY memory;`,
		params
	);
	// Resolve the memory content for the surfaced ids (one bounded read; screened for display).
	const ids = (rows ?? []).map((r) => String(r.memory)).filter(Boolean);
	const contentById = await loadMemoryContent(db, ids);

	let out: UtilizationRow[] = (rows ?? []).map((r) => {
		const recalled = Number(r.recalled ?? 0);
		const cited = Number(r.cited ?? 0);
		const utilized = Number(r.utilized ?? 0);
		const memId = String(r.memory);
		return {
			memory: memId,
			content: contentById.get(memId) ?? '',
			recalled,
			cited,
			utilized,
			avgScore: Number(r.avg_score ?? 0),
			recalledNeverCited: recalled > 0 && cited === 0,
			...(isoOrUndef(r.last_at) ? { lastRecalledAt: isoOrUndef(r.last_at) } : {})
		};
	});

	if (opts.recalledNeverCitedOnly) out = out.filter((r) => r.recalledNeverCited);
	// Leaderboard order: most-recalled first, then least-cited (surfaces low-value candidates).
	out.sort((a, b) => b.recalled - a.recalled || a.cited - b.cited);
	return out.slice(0, limit);
}

/**
 * Resolve screened display content for a set of memory ids (one bounded read). Quarantined
 * rows are EXCLUDED from recall elsewhere but their outcome rows persist; here we screen the
 * stored content for display anyway (defence-in-depth) so no raw secret surfaces (D-026).
 * Returns a Map id→screened-content; ids with no matching live memory are simply absent.
 */
async function loadMemoryContent(db: Db, ids: string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (ids.length === 0) return map;
	const links = ids.map((id) => link(id));
	const [rows] = await db.query<[Array<{ id: unknown; content: unknown }>]>(
		`SELECT id, content FROM memory WHERE id IN $ids;`,
		{ ids: links }
	);
	for (const r of rows ?? []) {
		map.set(String(r.id), screenForDisplay(r.content).text);
	}
	return map;
}
