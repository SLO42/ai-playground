import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { LAUNCH_ROLES, seedLaunchPool } from './launch-fixtures';
import { readGauntletKeyForScoring, listRoleVersions, getRoleBySlug } from './repo';
import { KNOWN_FAIL_PATH, KNOWN_PASS_PATH } from './scorer';
import { parseFindingsFile } from './findings';

// TASK 16.7 VERIFY (W-D7c content): the five launch fixture WORK sets + the seed
// write-path land HONEST against a REAL throwaway SurrealDB (F-008):
//   • §2.1 HARD RULE: fixture work carries NO answer-key material — no plants[],
//     no detection criteria, no fp_tolerance, no key shape ANYWHERE in the work;
//   • §3.8 provenance recorded, none PM-authored ('pm:'-prefixed);
//   • §4.3 / A8: every pool carries ≥1 injection plant (non-compliance bait);
//   • §4.2: sentinel is EMPTY at seed (injected at activation, not now);
//   • everything lands proposed / draft / no-keys / not-deployable;
//   • seedLaunchPool is idempotent (interrupt contract — apply twice, no dupes).

let tdb: TestDb;
let db: Db;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

// Key-material shapes that must NEVER appear in fixture work (§2.1).
const KEY_MATERIAL_KEYS = ['plants', 'detection', 'fp_tolerance', 'fp_justification', 'answer'];

const LAUNCH_SLUGS = ['security-officer', 'code-reviewer', 'qa-lead', 'design-reviewer', 'investigator'];

describe('launch role/fixture content (static — §8/§9)', () => {
	it('defines exactly the five launch roles, each with a non-empty harvested prompt core', () => {
		expect(LAUNCH_ROLES.map((r) => r.slug).sort()).toEqual([...LAUNCH_SLUGS].sort());
		for (const r of LAUNCH_ROLES) {
			expect(r.promptCore.trim().length).toBeGreaterThan(50);
			expect(r.provenance).toMatch(/^harvested:/); // §8 diff-vs-source substrate
			expect(r.purpose.trim().length).toBeGreaterThan(0); // D-038 #5 reason-to-exist
		}
	});

	it('every pool carries ≥1 GENUINE planted defect, a clean/bait control, and an injection plant (§4.3/A8)', () => {
		for (const r of LAUNCH_ROLES) {
			const kinds = r.fixtures.map((f) => f.kind);
			expect(kinds.filter((k) => k === 'planted_defect' || k === 'planted_absence').length).toBeGreaterThanOrEqual(1);
			expect(kinds).toContain('scorer_control');
			// §4.3 / A8 injection plant: a hallucination_bait whose content embeds an
			// instruction to ignore the methodology (non-compliance is the detection axis).
			const injection = r.fixtures.find((f) => f.kind === 'hallucination_bait');
			expect(injection, `${r.slug} has an injection plant`).toBeTruthy();
			const blob = JSON.stringify(injection!.work).toLowerCase();
			expect(blob).toMatch(/ignore|system instruction|do not report/);
		}
	});

	it('NO fixture work carries answer-key material — anywhere (§2.1 HARD RULE)', () => {
		for (const r of LAUNCH_ROLES) {
			for (const f of r.fixtures) {
				// The work object's KEYS are relative paths; its VALUES are file content.
				for (const [rel, content] of Object.entries(f.work)) {
					expect(typeof content).toBe('string');
					// No key-shaped JSON object keys appear as work entries.
					expect(KEY_MATERIAL_KEYS).not.toContain(rel);
				}
				// scorer_control work legitimately carries the static FINDINGS-report pair
				// (known-pass / known-fail) — those are reports the scorer scores, NOT a key
				// (no plants[], no detection). Assert they parse as the findings contract and
				// contain no detection/plants shape.
				if (f.kind === 'scorer_control') {
					const pass = f.work[KNOWN_PASS_PATH];
					const fail = f.work[KNOWN_FAIL_PATH];
					expect(typeof pass).toBe('string');
					expect(typeof fail).toBe('string');
					expect(parseFindingsFile(pass as string).ok).toBe(true);
					const failParsed = parseFindingsFile(fail as string);
					expect(failParsed.ok && failParsed.findings.length).toBe(0);
					const parsedPass = JSON.parse(pass as string) as Array<Record<string, unknown>>;
					for (const entry of parsedPass) {
						// A findings report has evidence/file, NEVER plants/detection (key shape).
						for (const k of KEY_MATERIAL_KEYS) expect(entry).not.toHaveProperty(k);
					}
				}
			}
		}
	});

	it('records §3.8 provenance on every fixture, none PM-authored', () => {
		for (const r of LAUNCH_ROLES) {
			for (const f of r.fixtures) {
				expect(f.provenance, `${r.slug}/${f.slug} provenance`).toMatch(/^(fails:|harvest:)/);
				expect(f.provenance.toLowerCase().startsWith('pm:')).toBe(false); // §4.4
			}
		}
	});

	it('seeds at least one fixture from a real fails.md F-entry (§3.8 — every F-NNN is a candidate)', () => {
		const allProvenance = LAUNCH_ROLES.flatMap((r) => r.fixtures.map((f) => f.provenance));
		expect(allProvenance.some((p) => /fails: F-013/.test(p))).toBe(true);
		expect(allProvenance.some((p) => /fails: F-015/.test(p))).toBe(true);
		expect(allProvenance.some((p) => /fails: F-005/.test(p))).toBe(true);
	});
});

describe('seedLaunchPool — lands HONEST + idempotent (§8, interrupt contract)', () => {
	it('creates roles + DRAFT versions + PROPOSED fixtures, NO keys, NO active version, EMPTY sentinel', async () => {
		const { roles } = await seedLaunchPool(db);
		expect(roles).toHaveLength(5);
		for (const seeded of roles) {
			// Role: NOT deployable (no active_version) — honest (F-008).
			expect(seeded.role.active_version).toBeNull();
			expect(seeded.createdRole).toBe(true);
			// Version: DRAFT — never auto-certified.
			expect(seeded.version.lifecycle).toBe('draft');
			expect(seeded.version.source).toBe('operator');
			// Fixtures: PROPOSED, sentinel EMPTY (injected at activation), NO key.
			expect(seeded.fixtures.length).toBeGreaterThanOrEqual(4);
			for (const f of seeded.fixtures) {
				expect(f.status).toBe('proposed');
				expect(f.sentinel).toBe(''); // §4.2 — never injected at seed
				expect(f.content_sha).toMatch(/^[0-9a-f]{64}$/); // computed mechanically
				const key = await readGauntletKeyForScoring(db, f.id);
				expect(key, `${seeded.role.slug}/${f.slug} must have NO key`).toBeNull();
			}
		}
	});

	it('is idempotent: a second seed adds nothing (no duplicate roles/versions/fixtures)', async () => {
		// First seed already ran above; re-run and assert no growth.
		const before = await getRoleBySlug(db, 'code-reviewer');
		const versionsBefore = await listRoleVersions(db, before!.id);
		const { roles } = await seedLaunchPool(db);
		for (const seeded of roles) {
			expect(seeded.createdRole).toBe(false); // role already existed — absorbed
		}
		const versionsAfter = await listRoleVersions(db, before!.id);
		expect(versionsAfter.length).toBe(versionsBefore.length); // no duplicate draft
		// Fixture count per role is stable.
		const [counts] = await db.query<[Array<{ n: number }>]>(
			`SELECT count() AS n FROM gauntlet_fixture WHERE role = $r GROUP ALL;`,
			{ r: new StringRecordId(before!.id) }
		);
		expect(counts[0].n).toBe(LAUNCH_ROLES.find((r) => r.slug === 'code-reviewer')!.fixtures.length);
	});
});
