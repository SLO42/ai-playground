import { StringRecordId } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { IdentifierError } from '../db/validate';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { activateGauntletFixture, newSentinelUlid } from './activation';
import {
	createGauntletFixture,
	createGauntletKey,
	createInterviewRun,
	createRole,
	createRoleVersion,
	finalizeInterviewRun,
	swapActiveVersion,
	type Tier
} from './repo';
import {
	CapabilityNeedsError,
	getCapabilityNeeds,
	listDefectClassVocabulary,
	recommendStaffing,
	roleProvenCoverage,
	setCapabilityNeeds
} from './capability-match';

// CAPABILITY-MATCH-SPEC (BL-3) VERIFY — against a REAL throwaway SurrealDB. Covers:
//   • m0048 capability_needs migration (apply-twice + half-applied recovery, F-015)
//   • the operator-confirmed defect-class VOCABULARY (only author='operator' keys; distinct)
//   • needs validation: an unknown/free-form class is REJECTED (enum-closed), known accepted
//   • D-026: a planted secret in a needs string is screened
//   • roleProvenCoverage: PROVEN not claimed (failed / uninterviewed / no-active-version → not covered)
//   • the matcher: REUSE (⊇), EXTEND (partial), HIRE (gap), cost-ranked, PROPOSE-ONLY
//   • shadow paths: missing project, no declared needs, empty catalog, nil/empty inputs

let tdb: TestDb;
let db: Db;

const CAPABILITY_NEEDS_MIG = '0048_capability_needs';

const MODELS: Record<string, { provider: string; model_id: string }> = {
	haiku: { provider: 'claude', model_id: 'claude-haiku-test' },
	sonnet: { provider: 'claude', model_id: 'claude-sonnet-test' },
	opus: { provider: 'claude', model_id: 'claude-opus-test' }
};
const RUN_BASE = { provider: 'claude', fixture_set_sha: 'fsha-cap-1' };

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied).toContain(CAPABILITY_NEEDS_MIG);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

let seq = 0;

async function freshProject(): Promise<string> {
	const n = ++seq;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $id) CONTENT { slug: $slug, name: $slug, root_path: '/tmp/x' } RETURN id;`,
		{ id: `cap_proj_${n}`, slug: `cap-proj-${n}` }
	);
	return String(rows[0].id);
}

async function freshRole(prefix = 'cap-role') {
	const slug = `${prefix}-${++seq}`;
	return createRole(db, { slug, name: `Role ${slug}`, purpose: 'capability-match test' });
}

/**
 * Build a role with ONE active fixture whose OPERATOR key plants `cls`, drive its version to a
 * PASSING interview at `tier`, and swap it in as active. Returns role/version ids. This is the
 * full §3.8 PROVEN path: active version + passing run + active fixture + operator-confirmed key.
 */
async function provenRole(opts: {
	prefix: string;
	cls: string;
	tier?: Tier;
	pass?: boolean;
	keyAuthor?: 'operator' | 'fixing_commit_diff';
	activate?: boolean;
}) {
	const tier = opts.tier ?? 'sonnet';
	const role = await freshRole(opts.prefix);
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `Review for ${opts.cls}.`,
		default_tier: tier
	});
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: `fx-${opts.cls}-${++seq}`,
		kind: 'planted_defect',
		work: { 'a.ts': 'line1\nline2\nprocess.kill(pid, 0);\n' },
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		author: opts.keyAuthor ?? 'operator',
		plants: [
			{ id: 'p1', class: opts.cls, detection: { file: 'a.ts', lines: [3, 3], evidence_pattern: 'kill' } }
		]
	});
	if (opts.activate !== false) await activateGauntletFixture(db, fixture.id);

	const run = await createInterviewRun(db, {
		role_version: version.id,
		tier,
		model_id: MODELS[tier].model_id,
		...RUN_BASE
	});
	await finalizeInterviewRun(db, run.id, {
		status: opts.pass === false ? 'failed' : 'passed',
		planted_total: 4,
		planted_found: opts.pass === false ? 1 : 4
	});
	if (opts.pass !== false) await swapActiveVersion(db, role.id, version.id);
	return { role, version, fixture };
}

// ── m0048 migration (F-015) ───────────────────────────────────────────────────────

describe('0048 capability_needs migration — apply-twice + half-applied', () => {
	it('defines the capability_needs object + nested array fields on project', async () => {
		const project = await freshProject();
		const pid = new StringRecordId(project);
		// The nested array fields accept arrays and read back honest (NONE until set → omitted).
		await db.query(
			`UPDATE $pid SET capability_needs = { languages: ['ts'], frameworks: [], defect_classes: [] };`,
			{ pid }
		);
		const [rows] = await db.query<[Array<{ capability_needs?: { languages?: string[] } }>]>(
			`SELECT capability_needs FROM $pid;`,
			{ pid }
		);
		expect(rows[0].capability_needs?.languages).toEqual(['ts']);
	});

	it('m0051: the proposed_defect_classes nested field accepts arrays (additive, idempotent)', async () => {
		const project = await freshProject();
		const pid = new StringRecordId(project);
		await db.query(
			`UPDATE $pid SET capability_needs = { languages: [], frameworks: [], defect_classes: [], proposed_defect_classes: ['novel-x'] };`,
			{ pid }
		);
		const [rows] = await db.query<[Array<{ capability_needs?: { proposed_defect_classes?: string[] } }>]>(
			`SELECT capability_needs FROM $pid;`,
			{ pid }
		);
		expect(rows[0].capability_needs?.proposed_defect_classes).toEqual(['novel-x']);
	});

	it('apply-twice: runner skips AND the raw DDL re-applies cleanly (OVERWRITE)', async () => {
		const again = await runMigrations(db, schemaMigrations);
		expect(again).toEqual([]);
		const mig = schemaMigrations.find((m) => m.id === CAPABILITY_NEEDS_MIG);
		expect(mig).toBeDefined();
		await expect(db.query(mig!.up)).resolves.toBeDefined();
	});

	it('half-applied recovery: a project missing the field is absorbed by the re-run', async () => {
		const half = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: `${tdb.namespace}_caphalf`,
			database: tdb.database
		});
		try {
			const without = schemaMigrations.filter((m) => m.id !== CAPABILITY_NEEDS_MIG);
			await runMigrations(half, without);
			// A project created BEFORE the field migration (reads NONE on the field).
			await half.query(
				`CREATE type::thing('project', 'pre_p') CONTENT { slug: 'pre', name: 'pre', root_path: '/x' };`
			);
			const applied = await runMigrations(half, schemaMigrations);
			expect(applied).toEqual([CAPABILITY_NEEDS_MIG]);
			// The pre-existing row now accepts capability_needs (additive, no mutation lost).
			const pid = new StringRecordId('project:pre_p');
			await half.query(`UPDATE $pid SET capability_needs = { defect_classes: [] };`, { pid });
			const [rows] = await half.query<[Array<{ slug: string }>]>(`SELECT slug FROM $pid;`, { pid });
			expect(rows[0].slug).toBe('pre'); // existing columns survived
		} finally {
			await half
				.query('REMOVE NAMESPACE IF EXISTS type::namespace($ns);', { ns: `${tdb.namespace}_caphalf` })
				.catch(() => {});
			await half.close().catch(() => {});
		}
	}, 60_000);
});

// ── 1. THE VOCABULARY ───────────────────────────────────────────────────────────────

describe('listDefectClassVocabulary — operator-confirmed plant.class set', () => {
	it('is the distinct class set across author=operator keys ONLY', async () => {
		await provenRole({ prefix: 'vocab-a', cls: 'swallowed-error' });
		await provenRole({ prefix: 'vocab-b', cls: 'non-idempotent-ddl' });
		// a key authored by fixing_commit_diff carries a class NOT confirmed → excluded.
		await provenRole({ prefix: 'vocab-c', cls: 'auto-derived-class', keyAuthor: 'fixing_commit_diff' });

		const vocab = await listDefectClassVocabulary(db);
		expect(vocab).toContain('swallowed-error');
		expect(vocab).toContain('non-idempotent-ddl');
		expect(vocab).not.toContain('auto-derived-class'); // not operator-confirmed
		// distinct + sorted
		expect([...vocab].sort()).toEqual(vocab);
		expect(new Set(vocab).size).toBe(vocab.length);
	});
});

// ── 2. THE NEEDS — validation + D-026 ─────────────────────────────────────────────────

describe('get/setCapabilityNeeds — enum-closed validation + D-026 screen', () => {
	it('accepts known classes, returns honest-empty needs before any set', async () => {
		const project = await freshProject();
		expect(await getCapabilityNeeds(db, project)).toEqual({
			languages: [],
			frameworks: [],
			defect_classes: [],
			proposed_defect_classes: []
		});
		await provenRole({ prefix: 'need-known', cls: 'committed-secret-value' });
		const needs = await setCapabilityNeeds(db, project, {
			languages: ['typescript'],
			defect_classes: ['committed-secret-value']
		});
		expect(needs.defect_classes).toEqual(['committed-secret-value']);
		expect(needs.languages).toEqual(['typescript']);
		// persisted
		expect((await getCapabilityNeeds(db, project)).defect_classes).toEqual(['committed-secret-value']);
	});

	it('REJECTS an unknown/free-form defect_class (enum-closed) and stores nothing', async () => {
		const project = await freshProject();
		await provenRole({ prefix: 'need-reject', cls: 'swallowed-error' });
		await expect(
			setCapabilityNeeds(db, project, { defect_classes: ['swallowed-error', 'totally-made-up-class'] })
		).rejects.toBeInstanceOf(CapabilityNeedsError);
		// fail-closed: NO partial write — defect_classes stays empty.
		expect((await getCapabilityNeeds(db, project)).defect_classes).toEqual([]);
	});

	it('the rejection names the unknown class on the error', async () => {
		const project = await freshProject();
		const err = await setCapabilityNeeds(db, project, { defect_classes: ['nope-class'] }).catch(
			(e) => e
		);
		expect(err).toBeInstanceOf(CapabilityNeedsError);
		expect((err as CapabilityNeedsError).unknownClasses).toContain('nope-class');
	});

	it('D-026: a planted secret in a needs string is screened before storage', async () => {
		const project = await freshProject();
		const needs = await setCapabilityNeeds(db, project, {
			frameworks: ['token sk-abcdef0123456789abcdef0123456789abcdef01']
		});
		expect(needs.frameworks.join(' ')).not.toContain('sk-abcdef0123456789abcdef0123456789abcdef01');
	});

	it('setting only defect_classes leaves languages/frameworks intact (MERGE)', async () => {
		const project = await freshProject();
		await provenRole({ prefix: 'need-merge', cls: 'raw-datetime' });
		await setCapabilityNeeds(db, project, { languages: ['csharp'], frameworks: ['unity'] });
		await setCapabilityNeeds(db, project, { defect_classes: ['raw-datetime'] });
		const needs = await getCapabilityNeeds(db, project);
		expect(needs.languages).toEqual(['csharp']);
		expect(needs.frameworks).toEqual(['unity']);
		expect(needs.defect_classes).toEqual(['raw-datetime']);
	});

	it('SHADOW: a missing project throws CapabilityNeedsError (get + set)', async () => {
		await expect(getCapabilityNeeds(db, 'project:does_not_exist')).rejects.toBeInstanceOf(
			CapabilityNeedsError
		);
		await expect(
			setCapabilityNeeds(db, 'project:does_not_exist', { languages: ['x'] })
		).rejects.toBeInstanceOf(CapabilityNeedsError);
	});

	it('SHADOW: empty arrays are accepted (clear the needs) honestly', async () => {
		const project = await freshProject();
		await provenRole({ prefix: 'need-empty', cls: 'hardcoded-color' });
		await setCapabilityNeeds(db, project, { defect_classes: ['hardcoded-color'] });
		const cleared = await setCapabilityNeeds(db, project, { defect_classes: [] });
		expect(cleared.defect_classes).toEqual([]);
	});
});

// ── 3. roleProvenCoverage — PROVEN not claimed ────────────────────────────────────────

describe('roleProvenCoverage — §3.8 proven coverage', () => {
	it('unions plant.class over the PASSING active version fixtures', async () => {
		const { role } = await provenRole({ prefix: 'cov-pass', cls: 'gate-bypass' });
		expect(await roleProvenCoverage(db, role.id)).toEqual(['gate-bypass']);
	});

	it('a FAILED interview is NOT proven coverage (claimed ≠ proven)', async () => {
		const { role } = await provenRole({ prefix: 'cov-fail', cls: 'never-proven', pass: false });
		// failed run → no swap → no active version → empty coverage.
		expect(await roleProvenCoverage(db, role.id)).toEqual([]);
	});

	it('a role with NO active version covers nothing', async () => {
		const role = await freshRole('cov-noactive');
		expect(await roleProvenCoverage(db, role.id)).toEqual([]);
	});

	it('SHADOW: a missing role covers nothing (no throw)', async () => {
		expect(await roleProvenCoverage(db, 'role:no_such_role')).toEqual([]);
	});
});

// ── 4. THE MATCHER — REUSE / EXTEND / HIRE, cost-ranked, propose-only ─────────────────

describe('recommendStaffing — match engine', () => {
	it('REUSE when a role proves ALL needed classes', async () => {
		const project = await freshProject();
		const { role } = await provenRole({ prefix: 'reuse', cls: 'reuse-class-x' });
		await setCapabilityNeeds(db, project, { defect_classes: ['reuse-class-x'] });
		const rec = await recommendStaffing(db, project);
		const cand = rec.candidates.find((c) => c.role === role.id);
		expect(cand?.match).toBe('reuse');
		expect(cand?.covered).toEqual(['reuse-class-x']);
		expect(cand?.missing).toEqual([]);
		expect(rec.fullyCovered).toBe(true);
		expect(rec.gaps).toEqual([]);
	});

	it('EXTEND when a role proves SOME but not all needed classes', async () => {
		const project = await freshProject();
		const { role } = await provenRole({ prefix: 'extend', cls: 'extend-known' });
		// need two: one proven (extend-known), one a different but VOCAB class proven by another role
		const { role: other } = await provenRole({ prefix: 'extend-other', cls: 'extend-other-known' });
		await setCapabilityNeeds(db, project, {
			defect_classes: ['extend-known', 'extend-other-known']
		});
		const rec = await recommendStaffing(db, project);
		const cand = rec.candidates.find((c) => c.role === role.id);
		expect(cand?.match).toBe('extend');
		expect(cand?.covered).toEqual(['extend-known']);
		expect(cand?.missing).toEqual(['extend-other-known']);
		// the other role REUSE-covers its own class; both needs are covered across the catalog.
		expect(rec.candidates.some((c) => c.role === other.id && c.match === 'extend')).toBe(true);
		expect(rec.fullyCovered).toBe(true);
	});

	it('HIRE gap when NO role proves a needed class', async () => {
		const project = await freshProject();
		// confirm a class into the vocabulary via one role, then need it where NO role proves it:
		// use a class proven by NO role's active version. Author an operator key for the class
		// WITHOUT a passing run so it is in the vocabulary but not proven.
		const gapRole = await freshRole('hire-gap-src');
		const fixture = await createGauntletFixture(db, {
			role: gapRole.id,
			slug: `fx-gap-${++seq}`,
			kind: 'planted_defect',
			work: { 'a.ts': 'l1\nl2\nx();\n' },
			sentinel: newSentinelUlid()
		});
		await createGauntletKey(db, {
			fixture: fixture.id,
			author: 'operator',
			plants: [{ id: 'g1', class: 'gap-only-class', detection: { file: 'a.ts', lines: [3, 3] } }]
		});
		// gapRole has NO active version (never swapped) → proves nothing.
		await setCapabilityNeeds(db, project, { defect_classes: ['gap-only-class'] });
		const rec = await recommendStaffing(db, project);
		expect(rec.candidates).toEqual([]);
		expect(rec.gaps.map((g) => g.defectClass)).toEqual(['gap-only-class']);
		expect(rec.fullyCovered).toBe(false);
	});

	it('cost-ranks candidates cheapest tier first', async () => {
		const project = await freshProject();
		const cls = `rank-shared-${++seq}`;
		await provenRole({ prefix: 'rank-opus', cls, tier: 'opus' });
		await provenRole({ prefix: 'rank-haiku', cls, tier: 'haiku' });
		await setCapabilityNeeds(db, project, { defect_classes: [cls] });
		const rec = await recommendStaffing(db, project);
		const tiers = rec.candidates.filter((c) => c.coverage.includes(cls)).map((c) => c.tier);
		// haiku (cheaper) must precede opus
		const haikuIdx = tiers.indexOf('haiku');
		const opusIdx = tiers.indexOf('opus');
		expect(haikuIdx).toBeGreaterThanOrEqual(0);
		expect(opusIdx).toBeGreaterThan(haikuIdx);
	});

	it('SHADOW: no declared defect_classes → empty candidates + gaps, fullyCovered:true', async () => {
		const project = await freshProject();
		const rec = await recommendStaffing(db, project);
		expect(rec.candidates).toEqual([]);
		expect(rec.gaps).toEqual([]);
		expect(rec.fullyCovered).toBe(true);
	});

	it('SHADOW: a missing project throws (matcher reads needs first)', async () => {
		await expect(recommendStaffing(db, 'project:nope')).rejects.toBeInstanceOf(CapabilityNeedsError);
	});

	it('D-016 TABLE-SCOPE: a cross-type id (a REAL role:<id>) is rejected with IdentifierError', async () => {
		// The BL-3 bug: role:x passes the generic RECORD_ID_RE shape, so the matcher would run a
		// WRONG-TABLE lookup (SELECT capability_needs FROM role:…). The table-scope guard rejects it.
		const { role } = await provenRole({ prefix: 'scope-role', cls: `scope-${++seq}` });
		await expect(recommendStaffing(db, role.id)).rejects.toBeInstanceOf(IdentifierError);
		await expect(getCapabilityNeeds(db, role.id)).rejects.toBeInstanceOf(IdentifierError);
		await expect(
			setCapabilityNeeds(db, role.id, { languages: ['ts'] })
		).rejects.toBeInstanceOf(IdentifierError);
		// A REAL project:<id> still resolves through the same path.
		const project = await freshProject();
		const rec = await recommendStaffing(db, project);
		expect(rec.project).toBe(project);
	});

	it('PROPOSE-ONLY: recommend does not staff, hire, or open a proposal', async () => {
		const project = await freshProject();
		const { role } = await provenRole({ prefix: 'noside', cls: `noside-${++seq}` });
		const cls = (await getCapabilityNeeds(db, project)).defect_classes; // empty baseline
		expect(cls).toEqual([]);
		// pick the class this role proves
		const coverage = await roleProvenCoverage(db, role.id);
		await setCapabilityNeeds(db, project, { defect_classes: coverage });
		await recommendStaffing(db, project);
		// no project_staff row was created, no review_proposal opened by the matcher.
		const [staff] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM project_staff WHERE project = $p;`,
			{ p: new StringRecordId(project) }
		);
		expect(staff).toEqual([]);
		const [props] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM review_proposal WHERE role = $r;`,
			{ r: new StringRecordId(role.id) }
		);
		expect(props).toEqual([]);
	});
});

// ── 5. proposed_defect_classes — captured HIRE signal, NEVER matchable (D4 LOCKED) ────

describe('proposed_defect_classes — captured, separate, never coverage', () => {
	it('persists SEPARATELY from confirmed defect_classes (screened, not enum-validated)', async () => {
		const project = await freshProject();
		await provenRole({ prefix: 'sep-confirmed', cls: 'sep-known-class' });
		const needs = await setCapabilityNeeds(db, project, {
			defect_classes: ['sep-known-class'],
			proposed_defect_classes: ['bepinex-patch-conflict', 'unknown-runtime-class']
		});
		expect(needs.defect_classes).toEqual(['sep-known-class']);
		expect(needs.proposed_defect_classes).toEqual([
			'bepinex-patch-conflict',
			'unknown-runtime-class'
		]);
		// persisted + read back
		const read = await getCapabilityNeeds(db, project);
		expect(read.defect_classes).toEqual(['sep-known-class']);
		expect(read.proposed_defect_classes).toEqual([
			'bepinex-patch-conflict',
			'unknown-runtime-class'
		]);
	});

	it('an UNKNOWN class set as proposed is NOT rejected (no enum check) and stays NON-matchable', async () => {
		const project = await freshProject();
		// proposed_defect_classes accepts a class with NO confirmed key — it would be rejected as a
		// defect_classes member, but is captured fine as a proposed need.
		const needs = await setCapabilityNeeds(db, project, {
			proposed_defect_classes: ['never-confirmed-anywhere']
		});
		expect(needs.proposed_defect_classes).toEqual(['never-confirmed-anywhere']);
		// it is NOT in the vocabulary (no operator key) — proving D4 stays locked.
		const vocab = await listDefectClassVocabulary(db);
		expect(vocab).not.toContain('never-confirmed-anywhere');
	});

	it('the matcher NEVER counts a proposed class as covered — it is a HIRE gap, not coverage', async () => {
		const project = await freshProject();
		// A role PROVES 'cov-real-class'; the project declares it confirmed AND lists a proposed class.
		await provenRole({ prefix: 'matcher-prop', cls: 'cov-real-class' });
		await setCapabilityNeeds(db, project, {
			defect_classes: ['cov-real-class'],
			proposed_defect_classes: ['proposed-only-class']
		});
		const rec = await recommendStaffing(db, project);
		// candidates + gaps are computed ONLY from confirmed defect_classes.
		const candCovered = rec.candidates.flatMap((c) => c.covered);
		expect(candCovered).not.toContain('proposed-only-class');
		expect(rec.gaps.map((g) => g.defectClass)).not.toContain('proposed-only-class');
		// the confirmed class IS scored (matcher untouched).
		expect(candCovered).toContain('cov-real-class');
		// the proposed need rides on the surfaced needs object (a signal), never as coverage.
		expect(rec.needs.proposed_defect_classes).toEqual(['proposed-only-class']);
	});

	it('setting only proposed leaves confirmed defect_classes intact (MERGE)', async () => {
		const project = await freshProject();
		await provenRole({ prefix: 'merge-prop', cls: 'merge-known' });
		await setCapabilityNeeds(db, project, { defect_classes: ['merge-known'] });
		await setCapabilityNeeds(db, project, { proposed_defect_classes: ['merge-proposed'] });
		const needs = await getCapabilityNeeds(db, project);
		expect(needs.defect_classes).toEqual(['merge-known']); // confirmed survived
		expect(needs.proposed_defect_classes).toEqual(['merge-proposed']);
	});

	it('D-026: a planted secret in a proposed class is screened before storage', async () => {
		const project = await freshProject();
		const needs = await setCapabilityNeeds(db, project, {
			proposed_defect_classes: ['leak sk-abcdef0123456789abcdef0123456789abcdef01']
		});
		expect(needs.proposed_defect_classes.join(' ')).not.toContain(
			'sk-abcdef0123456789abcdef0123456789abcdef01'
		);
	});

	it('NO promotion path: a proposed class never enters the vocabulary without an operator key', async () => {
		const project = await freshProject();
		await setCapabilityNeeds(db, project, { proposed_defect_classes: ['would-be-promoted'] });
		// Setting it as proposed minted no key → it is still NOT a vocabulary member, so trying to
		// set it as a CONFIRMED defect_class is REJECTED (enum-closed). D4 holds.
		await expect(
			setCapabilityNeeds(db, project, { defect_classes: ['would-be-promoted'] })
		).rejects.toBeInstanceOf(CapabilityNeedsError);
	});
});
