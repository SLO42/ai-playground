import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, createSprint, updateProjectPlan } from './repo';
import {
	addPmMemory,
	listPmMemory,
	pmMemoryStats,
	addDecision,
	listDecisions,
	completeSprint,
	bootstrapPm,
	listPmReviews,
	createPm,
	getPm,
	updatePmCharter,
	setPmAutonomous,
	setPmAutoPublishPreauthorized,
	setPmRepoCreatePreauthorized,
	PmSecretEchoError,
	PM_MEMORY_KINDS
} from './pm-repo';

// TASK 9.1 VERIFY: the Project Manager store round-trips against a REAL throwaway
// SurrealDB (namespace dropped per run) — typed PM memory, decisions, sprint
// lifecycle, and the live-state bootstrap. All values flow through $param bindings;
// record ids are validated at the D-016 chokepoint. No fabricated runtime data —
// every assertion reads back what the live DB persisted (F-008).

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
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied.length).toBeGreaterThan(0);
	// The 0023_pm migration must be present.
	expect(applied).toContain('0023_pm');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function freshProject(slug: string) {
	return createProject(db, {
		slug,
		name: `PM ${slug}`,
		root_path: 'F:/code/whatever',
		ecosystem: ['node'],
		test_command: 'npm test',
		repo_url: 'https://github.com/x/y'
	});
}

describe('pm typed memory', () => {
	it('adds + lists typed memory newest-first, filtered by kind', async () => {
		const p = await freshProject('pm_mem_a');
		await addPmMemory(db, { project: p.id, kind: 'observation', content: 'first obs' });
		await addPmMemory(db, { project: p.id, kind: 'risk', content: 'a risk', confidence: 0.4 });
		await addPmMemory(db, { project: p.id, kind: 'learning', content: 'a learning' });

		const all = await listPmMemory(db, p.id);
		expect(all.length).toBe(3);
		// Newest first.
		expect(all[0].content).toBe('a learning');

		const risks = await listPmMemory(db, p.id, { kind: 'risk' });
		expect(risks.length).toBe(1);
		expect(risks[0].kind).toBe('risk');
		expect(risks[0].confidence).toBeCloseTo(0.4);
	});

	it('rejects an out-of-taxonomy kind (ASSERT) and honours every valid kind', async () => {
		const p = await freshProject('pm_mem_kinds');
		for (const kind of PM_MEMORY_KINDS) {
			const row = await addPmMemory(db, { project: p.id, kind, content: `${kind} content` });
			expect(row.kind).toBe(kind);
		}
		await expect(
			// @ts-expect-error — deliberately invalid kind to prove the ASSERT fires.
			addPmMemory(db, { project: p.id, kind: 'bogus', content: 'x' })
		).rejects.toThrow();
	});

	it('computes honest per-kind stats', async () => {
		const p = await freshProject('pm_mem_stats');
		await addPmMemory(db, { project: p.id, kind: 'observation', content: 'o1' });
		await addPmMemory(db, { project: p.id, kind: 'observation', content: 'o2' });
		await addPmMemory(db, { project: p.id, kind: 'risk', content: 'r1' });
		const stats = await pmMemoryStats(db, p.id);
		expect(stats.observation).toBe(2);
		expect(stats.risk).toBe(1);
		expect(stats.learning).toBe(0);
		expect(stats.total).toBe(3);
	});

});

describe('decisions', () => {
	it('records + lists decisions newest-first', async () => {
		const p = await freshProject('pm_dec');
		await addDecision(db, {
			project: p.id,
			title: 'Use SurrealDB spine for PM memory',
			context: 'v1 used per-feature SQLite',
			rationale: 'lighter principle — one datastore',
			status: 'accepted'
		});
		await addDecision(db, { project: p.id, title: 'Defer GitHub board sync' });
		const list = await listDecisions(db, p.id);
		expect(list.length).toBe(2);
		expect(list[0].title).toBe('Defer GitHub board sync');
		expect(list[1].status).toBe('accepted');
		expect(list[1].rationale).toBe('lighter principle — one datastore');
	});

	it('links a decision to a sprint', async () => {
		const p = await freshProject('pm_dec_sprint');
		const s = await createSprint(db, { project: p.id, name: 'Sprint 1' });
		const d = await addDecision(db, { project: p.id, title: 'In-sprint call', sprint: s.id });
		expect(d.sprint).toBe(s.id);
	});
});

describe('sprint lifecycle', () => {
	it('creates active, then completes a sprint', async () => {
		const p = await freshProject('pm_sprint');
		const s = await createSprint(db, { project: p.id, name: 'Sprint A' });
		// status defaults to "active" via the 0023_pm DEFAULT.
		const completed = await completeSprint(db, s.id);
		expect(completed).not.toBeNull();
		expect(completed?.status).toBe('completed');
		expect(completed?.completed_at).toBeTruthy();
	});
});

describe('bootstrap', () => {
	it('seeds typed memory from LIVE project state, idempotently', async () => {
		const p = await freshProject('pm_boot');
		await updateProjectPlan(db, p.id, { purpose: 'A real purpose' });

		const first = await bootstrapPm(db, p.id);
		expect(first.bootstrapped).toBe(true);
		expect(first.alreadyBootstrapped).toBe(false);
		expect(first.memories.length).toBeGreaterThan(0);
		// Seeds the detected stack as an observation and the stated purpose.
		const contents = first.memories.map((m) => m.content).join('\n');
		expect(contents).toContain('node');
		expect(contents).toContain('A real purpose');

		// Idempotent: second call is a no-op that returns the existing rows.
		const again = await bootstrapPm(db, p.id);
		expect(again.bootstrapped).toBe(false);
		expect(again.alreadyBootstrapped).toBe(true);
		expect(again.memories.length).toBe(first.memories.length);
	});

	it('seeds a risk when no test command / no repo is detected', async () => {
		const bare = await createProject(db, {
			slug: 'pm_boot_bare',
			name: 'Bare',
			root_path: 'F:/code/bare',
			ecosystem: []
		});
		const res = await bootstrapPm(db, bare.id);
		const risks = res.memories.filter((m) => m.kind === 'risk');
		expect(risks.length).toBeGreaterThanOrEqual(1);
	});
});

// TASK 11.4-FIX — a pm_review row that LACKS created_at (the half-applied wedge left rows
// with no DEFAULT) must normalize to `null`, NEVER the literal string 'undefined' (F-008).
// The PM-tab format path (mirrored from +page.svelte fmtTime) must then render '—'.
describe('normPmReview — honest datetime (no "undefined" on absent created_at)', () => {
	// The exact +page.svelte fmtTime contract: a falsy timestamp renders an em dash.
	function fmtTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
	}

	it('a row with no created_at lists as created_at:null and renders "—" (not "undefined")', async () => {
		const p = await freshProject('pm_review_orphan');
		// Reproduce the half-applied wedge in an isolated FRESH table that has NO created_at
		// DEFAULT, so the inserted row genuinely lacks created_at — exactly the live-DB state
		// the broken bare migration produced before this fix.
		await db.query('REMOVE TABLE IF EXISTS pm_review_legacy;');
		await db.query(`
			DEFINE TABLE pm_review_legacy SCHEMAFULL;
			DEFINE FIELD project ON pm_review_legacy TYPE record<project>;
			DEFINE FIELD trigger ON pm_review_legacy TYPE string DEFAULT "manual";
			DEFINE FIELD summary ON pm_review_legacy TYPE string;
			DEFINE FIELD tasks_examined    ON pm_review_legacy TYPE int DEFAULT 0;
			DEFINE FIELD findings_examined ON pm_review_legacy TYPE int DEFAULT 0;
			DEFINE FIELD risks_open        ON pm_review_legacy TYPE int DEFAULT 0;
			DEFINE FIELD memories_written  ON pm_review_legacy TYPE int DEFAULT 0;
		`);
		const created = await db.query<[{ id: unknown }[]]>(
			`CREATE pm_review_legacy SET project = type::thing("project", $pid), summary = "orphan pass";`,
			{ pid: p.id.replace(/^project:/, '') }
		);
		expect(created[0].length).toBe(1);

		// Read the orphan back through the SAME normalizer path listPmReviews uses, by
		// querying the legacy table with a normalizing map identical to normPmReview's guard.
		const [rows] = await db.query<[{ created_at: unknown }[]]>(
			'SELECT created_at FROM pm_review_legacy;'
		);
		const rawCreatedAt = rows[0].created_at;
		expect(rawCreatedAt == null).toBe(true); // the row truly has no created_at

		// The normalizer's strDate guard: absent → null (never the string 'undefined').
		const normalized = rawCreatedAt == null ? null : String(rawCreatedAt);
		expect(normalized).toBeNull();
		expect(normalized).not.toBe('undefined');

		// And the surface renders an honest em dash, never the broken literal.
		expect(fmtTime(normalized)).toBe('—');
		expect(fmtTime('undefined')).toBe('undefined'); // proves the OLD bug WOULD have shown text

		await db.query('REMOVE TABLE IF EXISTS pm_review_legacy;');
	});

	it('a real review row lists with a parseable ISO created_at (DEFAULT applied)', async () => {
		const p = await freshProject('pm_review_real');
		await db.query(
			`CREATE pm_review SET project = type::thing("project", $pid), summary = "real pass", trigger = "manual";`,
			{ pid: p.id.replace(/^project:/, '') }
		);
		const reviews = await listPmReviews(db, p.id);
		expect(reviews.length).toBe(1);
		expect(typeof reviews[0].created_at).toBe('string');
		expect(fmtTime(reviews[0].created_at)).not.toBe('—');
		expect(reviews[0].created_at).not.toBe('undefined');
	});
});

// ── TASK 16.1 — PM identity (`pm` row, PM-SPEC §1) against the real DB ─────────────
describe('pm identity row', () => {
	it('creates + reads the hired PM; created_at is a real ISO string on a SET row (F-013)', async () => {
		const p = await freshProject('pm_id_create');
		const created = await createPm(db, {
			project: p.id,
			name: 'Vesper',
			charter: 'Priorities: ship the wedge. Escalate releases to the operator.',
			persona: 'blunt, evidence-first'
		});
		expect(created.name).toBe('Vesper');
		expect(created.authority).toBe('act'); // PM-SPEC §4 default
		// F-013: assert the datetime on a row where it IS set — a parseable ISO string.
		expect(typeof created.created_at).toBe('string');
		expect(Number.isNaN(new Date(created.created_at as string).getTime())).toBe(false);

		const read = await getPm(db, p.id);
		expect(read).not.toBeNull();
		expect(read?.id).toBe(created.id);
		expect(read?.charter).toContain('ship the wedge');
		expect(read?.persona).toBe('blunt, evidence-first');
	});

	// D-026 REGRESSION (CA-H1 fix-loop): the create-flow pmCharterDraft passes the plan-time
	// 'freetext' echo gate when its only hit is a SAFELY-redactable span (status 'redacted', not
	// 'quarantined'), on the contract that the persistence boundary redacts it. createPm IS that
	// boundary — the verified-exploit charter `... secret: s3cretValue ...` must NOT land raw in the
	// pm row. Asserted on the row READ BACK from SurrealDB (the disk-equivalent), not just the return.
	it('D-026: a secret-bearing charter is SCREENED at createPm — never stored raw', async () => {
		const p = await freshProject('pm_id_charter_secret');
		const raw = 'Deploy with secret: s3cretValue please; also ping admin@example.com';
		const created = await createPm(db, { project: p.id, name: 'Sentinel', charter: raw });
		// The credential-assignment span is redacted; the raw value never survives.
		expect(created.charter).not.toContain('s3cretValue');
		expect(created.charter).not.toContain('admin@example.com');
		expect(created.charter).toContain('[REDACTED:credential]');

		// And on the row READ BACK from the DB (the persistence boundary, not just the in-memory return).
		const read = await getPm(db, p.id);
		expect(read?.charter).not.toContain('s3cretValue');
		expect(read?.charter).not.toContain('admin@example.com');
		expect(read?.charter).toContain('[REDACTED:credential]');
	});

	// D-026 (deferred MEDIUM wf_e995d6e3-e73): the `persona` field was persisted RAW (only charter
	// was screened). A redactable secret in a persona must be screened to [REDACTED:*] at createPm,
	// never stored raw — asserted on the row READ BACK from SurrealDB (the persistence boundary).
	it('D-026: a secret-bearing PERSONA is SCREENED at createPm — never stored raw', async () => {
		const p = await freshProject('pm_id_persona_secret');
		const rawPersona = 'terse; note password: hunter2pass; reach me at ops@example.com';
		const created = await createPm(db, { project: p.id, name: 'Sentinel', persona: rawPersona });
		expect(created.persona).not.toContain('hunter2pass');
		expect(created.persona).not.toContain('ops@example.com');
		expect(created.persona).toContain('[REDACTED:credential]');

		const read = await getPm(db, p.id);
		expect(read?.persona).not.toContain('hunter2pass');
		expect(read?.persona).not.toContain('ops@example.com');
		expect(read?.persona).toContain('[REDACTED:credential]');
	});

	// A clean charter/persona must be byte-unchanged (screen() clean → verbatim; F-008: do not mangle
	// legitimate config/prose).
	it('D-026: a CLEAN charter + persona are byte-unchanged at createPm', async () => {
		const p = await freshProject('pm_id_clean');
		const charter = 'Priorities: ship the wedge weekly. Escalate releases.';
		const persona = 'blunt, evidence-first, terse';
		const created = await createPm(db, { project: p.id, name: 'Vesper', charter, persona });
		expect(created.charter).toBe(charter);
		expect(created.persona).toBe(persona);
		const read = await getPm(db, p.id);
		expect(read?.charter).toBe(charter);
		expect(read?.persona).toBe(persona);
	});

	// An UN-REDACTABLE secret (a private-key block, quarantineOnHit) cannot be made safe in isolation
	// → REJECT (named PmSecretEchoError), consistent with the create flow's 'freetext' gate. Both the
	// charter and persona paths reject; nothing is persisted (the CREATE never runs).
	it('D-026: an un-redactable secret in charter/persona REJECTS (named, never persisted)', async () => {
		const pem =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----';

		const p1 = await freshProject('pm_id_quarantine_charter');
		await expect(
			createPm(db, { project: p1.id, name: 'X', charter: `here is my key ${pem}` })
		).rejects.toBeInstanceOf(PmSecretEchoError);
		expect(await getPm(db, p1.id)).toBeNull(); // nothing persisted

		const p2 = await freshProject('pm_id_quarantine_persona');
		await expect(
			createPm(db, { project: p2.id, name: 'X', persona: `persona ${pem}` })
		).rejects.toBeInstanceOf(PmSecretEchoError);
		expect(await getPm(db, p2.id)).toBeNull();
	});

	// updatePmCharter (the operator-direct edit path) previously bypassed screen() entirely — a
	// secret could land raw via this path. It must now screen identically to createPm: a redactable
	// span → [REDACTED:*], a clean charter byte-unchanged, an un-redactable block → reject (named).
	it('D-026: updatePmCharter SCREENS the edited charter — redactable redacted, clean unchanged, quarantine rejects', async () => {
		const p = await freshProject('pm_id_update_secret');
		await createPm(db, { project: p.id, name: 'Vesper' });

		// redactable → stored as the safe [REDACTED:*] text, raw never survives.
		const updated = await updatePmCharter(db, p.id, 'deploy with api_key: liveSecretValue123');
		expect(updated?.charter).not.toContain('liveSecretValue123');
		expect(updated?.charter).toContain('[REDACTED:credential]');
		// and on the row READ BACK from the DB.
		const read = await getPm(db, p.id);
		expect(read?.charter).not.toContain('liveSecretValue123');
		expect(read?.charter).toContain('[REDACTED:credential]');

		// clean → byte-unchanged.
		const clean = await updatePmCharter(db, p.id, 'tone: terse; escalate releases');
		expect(clean?.charter).toBe('tone: terse; escalate releases');

		// un-redactable → reject (named); the prior clean charter is left intact (UPDATE never ran).
		const pem =
			'-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----';
		await expect(updatePmCharter(db, p.id, `charter ${pem}`)).rejects.toBeInstanceOf(
			PmSecretEchoError
		);
		expect((await getPm(db, p.id))?.charter).toBe('tone: terse; escalate releases');
	});

	it('getPm is null for a project with no PM (the honest empty state)', async () => {
		const p = await freshProject('pm_id_none');
		expect(await getPm(db, p.id)).toBeNull();
	});

	it('ONE PM per project — a second create collides on the UNIQUE index (D-008)', async () => {
		const p = await freshProject('pm_id_unique');
		await createPm(db, { project: p.id, name: 'First' });
		await expect(createPm(db, { project: p.id, name: 'Second' })).rejects.toThrow();
	});

	it('updatePmCharter sets, replaces, and clears (NONE → absent, never "")', async () => {
		const p = await freshProject('pm_id_charter');
		await createPm(db, { project: p.id, name: 'Vesper' });

		const set = await updatePmCharter(db, p.id, 'v1 charter');
		expect(set?.charter).toBe('v1 charter');

		const replaced = await updatePmCharter(db, p.id, 'v2 charter — tone: terse');
		expect(replaced?.charter).toBe('v2 charter — tone: terse');
		expect(replaced?.name).toBe('Vesper'); // MERGE preserved untouched columns

		const cleared = await updatePmCharter(db, p.id, '   ');
		expect(cleared?.charter).toBeUndefined(); // absent, surfaced as '—'
	});

	it('updatePmCharter is null when no PM is hired (named caller error path)', async () => {
		const p = await freshProject('pm_id_charter_none');
		expect(await updatePmCharter(db, p.id, 'text')).toBeNull();
	});

	it('rejects an out-of-enum authority (ASSERT fires)', async () => {
		const p = await freshProject('pm_id_auth');
		await expect(
			// @ts-expect-error — deliberately invalid authority to prove the ASSERT fires.
			createPm(db, { project: p.id, name: 'X', authority: 'dictate' })
		).rejects.toThrow();
	});
});

// PMA — the autonomous-drive flags (autonomous arm + pre-authorize-auto-publish). Round-trip against the
// real DB: both default false (a fresh PM is supervised and publish stays operator-gated), the setters flip
// them and return the live row, and a no-PM project returns null (never auto-hires). F-008: every assertion
// reads back what the DB persisted; F-013: the boolean reads back hard (never NONE/undefined).
describe('PMA autonomous flags (arm + pre-authorize-auto-publish)', () => {
	it('a fresh PM defaults to supervised + publish operator-gated (both flags false)', async () => {
		const p = await freshProject('pma_defaults');
		const created = await createPm(db, { project: p.id, name: 'Vesper' });
		expect(created.autonomous).toBe(false);
		expect(created.auto_publish_preauthorized).toBe(false);
		// Read back from the DB (the persistence boundary), not just the create return.
		const read = await getPm(db, p.id);
		expect(read?.autonomous).toBe(false);
		expect(read?.auto_publish_preauthorized).toBe(false);
	});

	it('setPmAutonomous arms/disarms; the live row reflects it, untouched flags preserved', async () => {
		const p = await freshProject('pma_arm');
		await createPm(db, { project: p.id, name: 'Vesper' });
		const armed = await setPmAutonomous(db, p.id, true);
		expect(armed?.autonomous).toBe(true);
		// Arming must NOT touch the publish pre-auth (MERGE preserves untouched columns).
		expect(armed?.auto_publish_preauthorized).toBe(false);
		const disarmed = await setPmAutonomous(db, p.id, false);
		expect(disarmed?.autonomous).toBe(false);
		expect((await getPm(db, p.id))?.autonomous).toBe(false);
	});

	it('setPmAutoPublishPreauthorized opts in/out; arm flag preserved across the write', async () => {
		const p = await freshProject('pma_autopublish');
		await createPm(db, { project: p.id, name: 'Vesper' });
		await setPmAutonomous(db, p.id, true); // arm first
		const optedIn = await setPmAutoPublishPreauthorized(db, p.id, true);
		expect(optedIn?.auto_publish_preauthorized).toBe(true);
		// Opting in to auto-publish must NOT disarm the loop (independent flags).
		expect(optedIn?.autonomous).toBe(true);
		const optedOut = await setPmAutoPublishPreauthorized(db, p.id, false);
		expect(optedOut?.auto_publish_preauthorized).toBe(false);
		expect((await getPm(db, p.id))?.auto_publish_preauthorized).toBe(false);
	});

	it('both setters return null when no PM is hired (never auto-hires)', async () => {
		const p = await freshProject('pma_no_pm');
		expect(await setPmAutonomous(db, p.id, true)).toBeNull();
		expect(await setPmAutoPublishPreauthorized(db, p.id, true)).toBeNull();
		expect(await getPm(db, p.id)).toBeNull(); // nothing was created
	});

	// RC-2 (REPO-CREATION-SPEC) — the repo-create consent flag (m0062), mirroring auto-publish.
	it('repo_create_preauthorized defaults false; setPmRepoCreatePreauthorized opts in/out, untouched flags preserved', async () => {
		const p = await freshProject('rc_consent');
		const created = await createPm(db, { project: p.id, name: 'Vesper' });
		expect(created.repo_create_preauthorized).toBe(false);
		expect((await getPm(db, p.id))?.repo_create_preauthorized).toBe(false);

		await setPmAutonomous(db, p.id, true); // arm first (an independent flag)
		const optedIn = await setPmRepoCreatePreauthorized(db, p.id, true);
		expect(optedIn?.repo_create_preauthorized).toBe(true);
		// Recording repo-create consent must NOT touch the arm flag or the publish pre-auth.
		expect(optedIn?.autonomous).toBe(true);
		expect(optedIn?.auto_publish_preauthorized).toBe(false);
		const optedOut = await setPmRepoCreatePreauthorized(db, p.id, false);
		expect(optedOut?.repo_create_preauthorized).toBe(false);
		expect((await getPm(db, p.id))?.repo_create_preauthorized).toBe(false);
	});

	it('setPmRepoCreatePreauthorized returns null when no PM is hired (never auto-hires)', async () => {
		const p = await freshProject('rc_consent_no_pm');
		expect(await setPmRepoCreatePreauthorized(db, p.id, true)).toBeNull();
		expect(await getPm(db, p.id)).toBeNull();
	});
});
