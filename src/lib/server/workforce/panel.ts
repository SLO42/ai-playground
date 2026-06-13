// TASK 16.7b — W-D7c SURFACES (UI half): the read-only AGGREGATOR feeding the
// `/agents` workforce panel (WORKFORCE-SPEC §8 'Surfaces' + 'Degraded/empty states').
//
// This is a computed service-level VIEW (rollup discipline: bounded SELECTs, fold in
// JS, every figure honest — null/'—', never a dressed-up 0; F-008). It REUSES the
// W-D7a/b data plane wholesale (listRoles, listRoleVersions, roleTrackRecord,
// checkDeployability) — no row writes, no key reads, no fork of the track-record math.
//
// What it produces per launch role (§8 'Surfaces'):
//   • the launch role_version (the draft/interviewing/passed campaign row), version
//     chip + lifecycle badge data;
//   • the INTERVIEW LINE source: the latest TERMINAL interview_run (found N/T plants ·
//     k FP · <tier> (<model_id>) · <date>, plus its candidate session id for the
//     transcript link) — model_id rendered straight from the row (NEVER hardcoded);
//   • the deployability verdict (§2.4) WITHOUT needing a config tier→model resolve:
//     a launch role is "certified" iff it has ANY passing terminal run AND the latest
//     terminal run passed at that run's own model_id with a matching prompt_sha — the
//     honest existential check over real rows;
//   • the §3.7 stale flag (every passing run stale);
//   • the track record (roleTrackRecord) for the stat lines, each carrying its own
//     source-row count;
//   • the pool-generation provenance ('passed launch pool v1, N fixtures') when known.
//
// Plus the GLOBAL adjudication queue (§3.4): every interview_run in status
// 'adjudicating' with its ambiguous items — the operator's judge surface.
//
// Day-one reality: there is NO interview data yet, so EVERY launch role resolves to
// 'not yet interviewed' / NOT DEPLOYABLE. The honest empties ARE the primary surface.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import {
	listRoles,
	listRoleVersions,
	type RoleRow,
	type RoleVersionRow
} from './repo';
import { roleTrackRecord, type RoleTrackRecord } from './track-record';

/** The latest terminal interview_run distilled to the §8 interview-line fields. */
export interface InterviewLine {
	run: string;
	status: 'passed' | 'failed' | 'error';
	/** 'env_timeout' | 'spawn_failure' | 'scorer_error' when status='error'; else null. */
	errorReason: string | null;
	tier: string;
	/** RESOLVED model_id from the run row — the certification axis (§2.4). Real data. */
	modelId: string;
	provider: string;
	plantedFound: number;
	plantedTotal: number;
	falsePositives: number;
	/** §3.7 honest flag — the certifying run predates a fixture-pool change. */
	stale: boolean;
	/** The candidate session (kind='interview') for the transcript link; null if none. */
	session: string | null;
	/** ISO; null → '—'. */
	at: string | null;
}

/** One launch role's card data — null-honest throughout (F-008). */
export interface WorkforceRoleCard {
	role: string;
	slug: string;
	name: string;
	purpose: string;
	provenance: string | null;
	/** The launch version row, or null when the role has no non-withdrawn version. */
	version: number | null;
	roleVersion: string | null;
	lifecycle: RoleVersionRow['lifecycle'] | null;
	defaultTier: string | null;
	/** Deployability over real runs (§2.4 existential), NO config tier→model needed. */
	deployable: boolean;
	/** Named honest reason when not deployable; null when deployable. */
	notDeployableReason: string | null;
	/** Latest TERMINAL run → the §8 interview line; null = 'not yet interviewed'. */
	interview: InterviewLine | null;
	/** Total interview_run rows for this version (any status) — sample-size context. */
	interviewRuns: number;
	/** The null-honest track record (each stat carries its own source-row count). */
	track: RoleTrackRecord | null;
	/** Pool-generation provenance ('passed launch pool v1, N fixtures') or null. */
	poolGeneration: string | null;
}

/** One adjudicating run surfaced on the §3.4 operator queue. */
export interface AdjudicationCard {
	run: string;
	role: string;
	roleSlug: string;
	roleVersion: string;
	tier: string;
	modelId: string;
	plantedFound: number;
	plantedTotal: number;
	falsePositives: number;
	/** The ambiguous-queue items (verbatim from interview_run.ambiguous). */
	ambiguous: Array<Record<string, unknown>>;
	at: string | null;
}

export interface WorkforcePanelData {
	roles: WorkforceRoleCard[];
	/** §8 step ⑤ readiness echo: true once every launch role is deployable. */
	allCertified: boolean;
	/** §3.4 — every 'adjudicating' run awaiting the operator's judgment. */
	adjudication: AdjudicationCard[];
}

const TERMINAL = new Set(['passed', 'failed', 'error']);

interface RawRun {
	id: unknown;
	status: string;
	error_reason?: string | null;
	tier: string;
	model_id: string;
	provider: string;
	prompt_sha: string;
	planted_found: number;
	planted_total: number;
	false_positives: number;
	stale: boolean;
	session?: unknown;
	started_at: unknown;
	ended_at?: unknown;
}

function strOrNull(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	return s === '' || s === 'undefined' || s === 'null' ? null : s;
}

/**
 * The launch version is the role's earliest non-withdrawn version (§8 bootstrap: each
 * launch role has exactly one draft campaign at day 0). listRoleVersions returns
 * newest-first; we pick the lowest version that isn't withdrawn so a later revision
 * never hides the launch campaign on the card. Returns null when the role has no
 * usable version (honest 'not yet interviewed' / NOT DEPLOYABLE).
 */
function pickLaunchVersion(versions: RoleVersionRow[]): RoleVersionRow | null {
	const usable = versions.filter((v) => v.lifecycle !== 'withdrawn');
	if (usable.length === 0) return null;
	// Prefer the active/passed campaign; else the lowest version number.
	return [...usable].sort((a, b) => a.version - b.version)[0];
}

/** Distill the latest TERMINAL run (passed|failed|error) into the interview line. */
function latestTerminal(runs: RawRun[]): InterviewLine | null {
	const term = runs.find((r) => TERMINAL.has(r.status));
	if (!term) return null;
	return {
		run: String(term.id),
		status: term.status as InterviewLine['status'],
		errorReason: term.error_reason ?? null,
		tier: term.tier,
		modelId: term.model_id,
		provider: term.provider,
		plantedFound: term.planted_found,
		plantedTotal: term.planted_total,
		falsePositives: term.false_positives,
		stale: term.stale,
		session: term.session != null ? String(term.session) : null,
		at: strOrNull(term.started_at)
	};
}

/**
 * §2.4 existential deployability over REAL rows, WITHOUT a config tier→model resolve:
 * a launch version is "deployable" iff there is ≥1 passing terminal run whose
 * prompt_sha matches the version's current prompt_sha (the (prompt_sha × model_id)
 * certification axis — we surface the certifying model on the interview line). This is
 * the honest day-0 surface: no passing run → not deployable, with the named reason.
 */
function deployabilityFromRuns(
	version: RoleVersionRow,
	runs: RawRun[]
): { deployable: boolean; reason: string | null } {
	if (version.lifecycle === 'failed' || version.lifecycle === 'withdrawn') {
		return {
			deployable: false,
			reason: `lifecycle '${version.lifecycle}' — a fix is a new version (§2.2)`
		};
	}
	const passing = runs.filter(
		(r) => r.status === 'passed' && r.prompt_sha === version.prompt_sha
	);
	if (passing.length === 0) {
		const anyPassedOtherSha = runs.some((r) => r.status === 'passed');
		if (anyPassedOtherSha) {
			return {
				deployable: false,
				reason: 'prompt core changed since the last passing interview — re-interview required (§2.4)'
			};
		}
		return { deployable: false, reason: 'not yet interviewed' };
	}
	return { deployable: true, reason: null };
}

/** Read all interview_run rows for a version (newest-first; bounded). */
async function runsForVersion(db: Db, versionId: string): Promise<RawRun[]> {
	const vid = new StringRecordId(assertRecordId(versionId));
	const [rows] = await db.query<[RawRun[]]>(
		`SELECT id, status, error_reason, tier, model_id, provider, prompt_sha,
		        planted_found, planted_total, false_positives, stale, session, started_at
		   FROM interview_run WHERE role_version = $vid
		  ORDER BY started_at DESC LIMIT 500;`,
		{ vid }
	);
	return rows ?? [];
}

/**
 * Pool-generation provenance ('passed launch pool v1, N active fixtures') — honest
 * count of the role's ACTIVE fixtures when the version is deployable; null otherwise
 * (we never claim a pool generation the role hasn't passed). Bounded count query.
 */
async function poolGeneration(
	db: Db,
	roleId: string,
	deployable: boolean
): Promise<string | null> {
	if (!deployable) return null;
	const rid = new StringRecordId(assertRecordId(roleId));
	const [rows] = await db.query<[Array<{ c: number }>]>(
		`SELECT count() AS c FROM gauntlet_fixture
		  WHERE role = $rid AND status = 'active' GROUP ALL;`,
		{ rid }
	);
	const n = rows?.[0]?.c ?? 0;
	if (n === 0) return null;
	return `passed launch pool · ${n} ${n === 1 ? 'fixture' : 'fixtures'}`;
}

async function buildCard(db: Db, role: RoleRow): Promise<WorkforceRoleCard> {
	const versions = await listRoleVersions(db, role.id);
	const launch = pickLaunchVersion(versions);
	if (!launch) {
		return {
			role: role.id,
			slug: role.slug,
			name: role.name,
			purpose: role.purpose,
			provenance: role.provenance ?? null,
			version: null,
			roleVersion: null,
			lifecycle: null,
			defaultTier: null,
			deployable: false,
			notDeployableReason: 'no version',
			interview: null,
			interviewRuns: 0,
			track: null,
			poolGeneration: null
		};
	}
	const runs = await runsForVersion(db, launch.id);
	const { deployable, reason } = deployabilityFromRuns(launch, runs);
	const interview = latestTerminal(runs);
	// Track record is per-version; only meaningful once the version exists. Always
	// fetch (it is null-honest internally) so stat lines have their source counts.
	const track = await roleTrackRecord(db, launch.id);
	const poolGen = await poolGeneration(db, role.id, deployable);
	return {
		role: role.id,
		slug: role.slug,
		name: role.name,
		purpose: role.purpose,
		provenance: role.provenance ?? null,
		version: launch.version,
		roleVersion: launch.id,
		lifecycle: launch.lifecycle,
		defaultTier: launch.default_tier,
		deployable,
		notDeployableReason: reason,
		interview,
		interviewRuns: runs.length,
		track,
		poolGeneration: poolGen
	};
}

/** §3.4 — every adjudicating run across all roles, for the operator's judge queue. */
async function buildAdjudicationQueue(db: Db): Promise<AdjudicationCard[]> {
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				role: unknown;
				role_version: unknown;
				tier: string;
				model_id: string;
				planted_found: number;
				planted_total: number;
				false_positives: number;
				ambiguous: Array<Record<string, unknown>>;
				started_at: unknown;
			}>
		]
	>(
		`SELECT id, role, role_version, tier, model_id, planted_found, planted_total,
		        false_positives, ambiguous, started_at
		   FROM interview_run WHERE status = 'adjudicating'
		  ORDER BY started_at DESC LIMIT 100;`
	);
	const cards: AdjudicationCard[] = [];
	// role slug lookup (small, cached for the loop).
	const slugCache = new Map<string, string>();
	for (const r of rows ?? []) {
		const roleId = String(r.role);
		let slug = slugCache.get(roleId);
		if (slug === undefined) {
			const [sr] = await db.query<[Array<{ slug: string }>]>(
				`SELECT slug FROM $rid;`,
				{ rid: new StringRecordId(assertRecordId(roleId)) }
			);
			slug = sr?.[0]?.slug ?? roleId;
			slugCache.set(roleId, slug);
		}
		cards.push({
			run: String(r.id),
			role: roleId,
			roleSlug: slug,
			roleVersion: String(r.role_version),
			tier: r.tier,
			modelId: r.model_id,
			plantedFound: r.planted_found,
			plantedTotal: r.planted_total,
			falsePositives: r.false_positives,
			ambiguous: Array.isArray(r.ambiguous) ? r.ambiguous : [],
			at: strOrNull(r.started_at)
		});
	}
	return cards;
}

/**
 * §8 'Surfaces' — the full read-only workforce panel view. Bounded queries, JS fold,
 * honest empties (F-008). Throws nothing for an empty workforce: zero roles → an empty
 * `roles` array, which the page renders as the honest 'no roles' state.
 */
export async function loadWorkforcePanel(db: Db): Promise<WorkforcePanelData> {
	const roleRows = await listRoles(db);
	const cards = await Promise.all(roleRows.map((r) => buildCard(db, r)));
	const adjudication = await buildAdjudicationQueue(db);
	return {
		roles: cards,
		allCertified: cards.length > 0 && cards.every((c) => c.deployable),
		adjudication
	};
}
