// TASK 16.6 (W-D7b) — FIXTURE ACTIVATION + the SENTINEL leak tripwire
// (WORKFORCE-SPEC §3.7, §4.2).
//
// ACTIVATION is the operator act that makes a proposed fixture part of the live pool
// (the diff+confirm ceremony is W-D7c UI; this is its engine). Server-side, atomic:
//   • the fixture's sentinel ULID is INJECTED MECHANICALLY into the work content HERE
//     — at activation, AFTER all agent authoring, so an authoring transcript can never
//     trip its own sweep (§4.2);
//   • content_sha is recomputed and the answer key (if present) is RE-BOUND in the
//     same transaction (the key is content-addressed to the work it answers — §2.1);
//   • affected passing interview_runs flip stale=true (honest flag, NOT revocation —
//     §3.7: the certification stays valid, the version stays deployable);
//   • ONE batched re-interview proposal queues as a pending work_item, dedup-keyed on
//     the role — repeat activations COALESCE into the one open item, never auto-spend
//     fan-out (§3.7; the v2.1 surfacing vehicle is the work queue — review_proposal
//     is a v2.3 table).
//
// The SENTINEL SWEEP asserts every activated fixture's ULID is ABSENT from the leak
// surfaces: memory, pm_memory, and non-interview transcripts (message rows — composed
// briefings persist as message rows, so they are covered). A hit is a notification +
// (W-D7c) role-card badge; the OPERATOR decides retirement — no auto-burn (§4.2).

import { randomBytes } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { enqueue } from '../orchestrator/workqueue';
import {
	addRoleEvent,
	computeWorkSha,
	markInterviewRunStale,
	WorkforceInputError,
	type GauntletFixtureRow
} from './repo';

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function str(v: unknown): string {
	return String(v);
}

// ── Sentinel ULIDs ──────────────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Generate a ULID (Crockford base32: 10 time chars + 16 random chars) for use as a
 *  fixture sentinel (§4.2). Uniqueness across fixtures is what makes a sweep hit
 *  attributable to ONE fixture. */
export function newSentinelUlid(now = Date.now()): string {
	let time = '';
	let t = now;
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const rand = randomBytes(16);
	let out = time;
	for (let i = 0; i < 16; i++) out += CROCKFORD[rand[i] % 32];
	return out;
}

/** Strict shape predicate for an ACTIVATED fixture sentinel (§4.2 / F-025): exactly
 *  26 Crockford-base32 chars — the shape `newSentinelUlid` mints. A whitespace/short/
 *  low-entropy sentinel is NOT merely len>0: it still near-match-alls the §4.2
 *  `string::contains(content, sentinel)` sweep (same F-025 class), so a non-empty but
 *  malformed sentinel is just as dangerous as an empty one. Reuses the single CROCKFORD
 *  alphabet (above) so the accept-set is identical to the mint-set by construction. */
export function isSentinelShape(value: unknown): value is string {
	if (typeof value !== 'string' || value.length !== 26) return false;
	for (let i = 0; i < 26; i++) {
		if (!CROCKFORD.includes(value[i])) return false;
	}
	return true;
}

/** The marker line embedded into each work file at activation. Inert trailing text:
 *  appended at EOF so plant line numbers never shift, comment-prefixed so code-shaped
 *  work stays parseable to a reader. */
export function sentinelMarker(sentinel: string): string {
	return `// gauntlet-sentinel:${sentinel}`;
}

/**
 * Inject the sentinel into every string work file (idempotent: a file already carrying
 * the ULID is left untouched — re-runs absorb prior partial work, interrupt contract).
 * Embedding in EVERY eligible file maximizes tripwire coverage: copying any one
 * fixture file into a memory/briefing carries the ULID with it.
 *
 * `.json` files are EXEMPT: a trailing comment line would corrupt their parseability
 * (for the candidate reviewing them, and for the scorer_control's static known-pass/
 * known-fail report pair, which MUST stay valid JSON). The fixture's sentinel still
 * rides every non-JSON file; a JSON-only fixture simply carries no embedded sentinel
 * (its `sentinel` column still exists — honest, narrower coverage).
 */
export function injectSentinel(
	work: Record<string, unknown>,
	sentinel: string
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [rel, content] of Object.entries(work)) {
		if (typeof content !== 'string') {
			throw new WorkforceInputError(
				`fixture work entry ${JSON.stringify(rel)} is not string content — cannot inject sentinel`
			);
		}
		if (/\.json$/i.test(rel) || content.includes(sentinel)) {
			out[rel] = content;
			continue;
		}
		out[rel] = `${content.replace(/\n*$/, '')}\n${sentinelMarker(sentinel)}\n`;
	}
	return out;
}

// ── Activation ──────────────────────────────────────────────────────────────────────

/** Re-interview queue work type (§3.7 — ONE batched proposal per role). */
export const REINTERVIEW_PROPOSAL_TYPE = 'gauntlet_reinterview';

export interface ActivationResult {
	fixture: GauntletFixtureRow;
	/** false when the fixture was already active (idempotent absorb). */
	activated: boolean;
	/** Passing runs newly flipped stale=true. */
	staleMarked: number;
	/** true when THIS activation created the batched re-interview item (false = an
	 *  open item already existed and absorbed this activation — still ONE proposal). */
	reinterviewQueued: boolean;
}

function normFixture(row: Record<string, unknown>): GauntletFixtureRow {
	return {
		id: str(row.id),
		role: str(row.role),
		slug: str(row.slug),
		kind: row.kind as GauntletFixtureRow['kind'],
		work: (row.work ?? {}) as Record<string, unknown>,
		content_sha: str(row.content_sha),
		sentinel: str(row.sentinel),
		...(row.provenance != null ? { provenance: str(row.provenance) } : {}),
		status: row.status as GauntletFixtureRow['status'],
		created_at: null
	};
}

/**
 * Activate a proposed fixture (the engine behind the operator's diff+confirm — §3.7).
 * Atomic work+sha+key-rebind+status write (F-015: assume death mid-apply; the
 * transaction keeps the content address and the key binding consistent). Idempotent:
 * an already-active fixture absorbs the re-run (no double sentinel, no event spam).
 */
export async function activateGauntletFixture(db: Db, fixtureId: string): Promise<ActivationResult> {
	const fid = link(fixtureId);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $fid;`, { fid });
	if (!rows.length) throw new WorkforceInputError(`gauntlet_fixture not found: ${fixtureId}`);
	const fixture = normFixture(rows[0]);

	if (fixture.status === 'retired') {
		throw new WorkforceInputError(
			`gauntlet_fixture ${fixture.slug} is retired — a retired fixture is never re-activated (propose a new one)`
		);
	}
	if (fixture.status === 'active') {
		return { fixture, activated: false, staleMarked: 0, reinterviewQueued: false };
	}

	// Sentinel SHAPE guard (§4.2 / F-025): an ACTIVATED fixture must carry a strict
	// 26-char Crockford ULID — the shape `newSentinelUlid` mints. The sentinel is
	// legitimately empty while status='proposed' (it is the activation step that injects
	// it), but `sentinelSweep` runs `string::contains(content, sentinel)`. An EMPTY needle
	// match-alls every row in SurrealDB 2.x, AND a whitespace/short/low-entropy needle
	// near-match-alls the same surfaces (same F-025 class) — so len>0 is NOT enough; only
	// a well-formed ULID is a safe, attributable tripwire. Refuse activation of any
	// malformed-sentinel fixture with a NAMED error rather than arm a match-all sweep.
	// (Day-0 safe: production mints sentinels server-side via newSentinelUlid, always
	// valid — zero behavior change for valid ULIDs; re-run of an active fixture returns
	// the idempotent absorb above before reaching here.)
	if (!isSentinelShape(fixture.sentinel)) {
		throw new WorkforceInputError(
			`gauntlet_fixture ${fixture.slug} has a malformed sentinel ${JSON.stringify(str(fixture.sentinel))} — ` +
				`cannot activate (an active fixture's sentinel is the leak tripwire and must be a 26-char Crockford ` +
				`base32 ULID; an empty or low-entropy needle match-alls the sweep, F-025)`
		);
	}

	// 1. Server-side sentinel injection (AFTER all agent authoring — §4.2) + atomic
	//    re-address: work, content_sha, status, and the key re-bind in ONE transaction.
	const injected = injectSentinel(fixture.work, fixture.sentinel);
	const newSha = computeWorkSha(injected);
	await db.query(
		`BEGIN;
		 UPDATE $fid SET work = $work, content_sha = $sha, status = 'active';
		 UPDATE gauntlet_key SET content_sha = $sha WHERE fixture = $fid;
		 COMMIT;`,
		{ fid, work: injected, sha: newSha }
	);

	// 2. §3.7 — mark affected passing runs stale (honest flag, NOT revocation). Only
	//    fresh marks (stale=false) so a crash-re-run never spams role_event.
	const [passing] = await db.query<[Array<{ id: unknown; role_version: unknown }>]>(
		`SELECT id, role_version FROM interview_run
		  WHERE role = $role AND status = 'passed' AND stale = false LIMIT 500;`,
		{ role: link(fixture.role) }
	);
	const affectedVersions = new Set<string>();
	for (const run of passing) {
		await markInterviewRunStale(db, str(run.id));
		affectedVersions.add(str(run.role_version));
	}

	// 3. §3.7 — ONE batched re-interview proposal (work_item, dedup on the role): a
	//    second activation while the item is open COALESCES (enqueued:false) — never
	//    auto-spend fan-out, never N proposals.
	const q = await enqueue(db, {
		workType: REINTERVIEW_PROPOSAL_TYPE,
		payload: {
			role: fixture.role,
			fixture: fixture.id,
			fixture_slug: fixture.slug,
			affected_versions: [...affectedVersions],
			reason: 'fixture pool changed — batched re-interview for operator approval (§3.7)'
		},
		dedupScope: fixture.role,
		priority: 4
	});

	await addRoleEvent(db, {
		role: fixture.role,
		op: 'fixture_activated',
		detail: { fixture: fixture.id, slug: fixture.slug, stale_marked: passing.length }
	});

	const [after] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $fid;`, { fid });
	return {
		fixture: normFixture(after[0]),
		activated: true,
		staleMarked: passing.length,
		reinterviewQueued: q.enqueued
	};
}

// ── Sentinel sweep (§4.2) ────────────────────────────────────────────────────────────

export interface SentinelHit {
	sentinel: string;
	fixture: string; // record id
	fixtureSlug: string;
	role: string;
	/** Which leak surface tripped. */
	surface: 'memory' | 'pm_memory' | 'transcript';
	/** The leaking row ids (bounded). */
	rows: string[];
}

export interface SentinelSweepResult {
	/**
	 * Sentinels actually swept — activated/retired fixtures with a non-empty needle.
	 * Proposed work is uninjected (excluded by the query); an empty/uncheckable sentinel
	 * is skipped by the F-025 guard and is NOT counted here (it was never checked).
	 */
	checked: number;
	hits: SentinelHit[];
}

/**
 * Sweep the leak surfaces for every injected fixture sentinel (§4.2): `memory` rows,
 * `pm_memory` rows, and `message` rows of NON-interview sessions (composed briefings
 * persist as message rows in the launching session, so they are covered; an interview
 * session's own transcript legitimately contains its fixtures and is excluded).
 * Read-only and bounded; a hit NEVER auto-retires anything — the operator decides.
 */
export async function sentinelSweep(db: Db): Promise<SentinelSweepResult> {
	const [fixtures] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, slug, role, sentinel FROM gauntlet_fixture WHERE status != 'proposed' LIMIT 500;`
	);
	const hits: SentinelHit[] = [];
	let checked = 0;
	for (const f of fixtures) {
		const sentinel = str(f.sentinel);
		// Empty-needle guard (F-025): SurrealDB 2.x `string::contains(content, '')` matches
		// EVERY row, so an empty sentinel would fabricate a leak hit on every memory/pm_memory/
		// transcript row. Layers (a)+(b) make an active/retired empty sentinel impossible, but
		// the sweep stays defense-in-depth: an empty sentinel is uncheckable, never match-all.
		// An uncheckable (empty) sentinel is NOT counted in `checked` — it was never swept.
		if (sentinel.length === 0) continue;
		checked += 1;
		const base = {
			sentinel,
			fixture: str(f.id),
			fixtureSlug: str(f.slug),
			role: str(f.role)
		};
		const [mem] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM memory WHERE string::contains(content, $s) LIMIT 10;`,
			{ s: sentinel }
		);
		if (mem.length) hits.push({ ...base, surface: 'memory', rows: mem.map((r) => str(r.id)) });

		const [pm] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM pm_memory WHERE string::contains(content, $s) LIMIT 10;`,
			{ s: sentinel }
		);
		if (pm.length) hits.push({ ...base, surface: 'pm_memory', rows: pm.map((r) => str(r.id)) });

		const [msgs] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM message
			  WHERE string::contains(content, $s)
			    AND (session IS NONE OR session.kind != 'interview')
			  LIMIT 10;`,
			{ s: sentinel }
		);
		if (msgs.length) hits.push({ ...base, surface: 'transcript', rows: msgs.map((r) => str(r.id)) });
	}
	return { checked, hits };
}

/** Sweep work-item type — the periodic vehicle's audit row (§4.2). */
export const SENTINEL_SWEEP_TYPE = 'gauntlet_sentinel_sweep';

/**
 * Run one periodic sweep pass and RECORD it: a completed work_item per pass (the
 * audit trail the periodic cadence leaves behind) and a notification per hit batch
 * (the operator's signal — retirement stays an operator act, §4.2). Wired at boot
 * (hooks.server.ts — every connected boot sweeps once); the CI red-green test lives
 * in activation.test.ts. Never throws into its caller (D-019 at the boot seam).
 */
export async function runSentinelSweep(db: Db): Promise<SentinelSweepResult> {
	const result = await sentinelSweep(db);
	await db.query(
		`CREATE work_item CONTENT {
			work_type: $wt, status: 'done', priority: 5,
			payload: $payload, completed_at: time::now()
		};`,
		{
			wt: SENTINEL_SWEEP_TYPE,
			payload: {
				checked: result.checked,
				hits: result.hits.length,
				...(result.hits.length
					? { detail: result.hits.map((h) => ({ fixture: h.fixtureSlug, surface: h.surface, rows: h.rows })) }
					: {})
			}
		}
	);
	if (result.hits.length) {
		const lines = result.hits
			.map((h) => `${h.fixtureSlug} → ${h.surface} (${h.rows.length} row(s))`)
			.join('; ');
		await db.query(`CREATE notification CONTENT { message: $m };`, {
			m: `Gauntlet sentinel LEAK detected: ${lines}. Fixture retirement is an operator decision (WORKFORCE-SPEC §4.2).`
		});
	}
	return result;
}
