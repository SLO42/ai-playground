import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	proposeSkill,
	listSkillProposals,
	getSkillProposal,
	normalizedDedupKey,
	SkillProposalContractError,
	type ProposeSkillInput
} from './proposal';

// SH-1 VERIFY (SKILL-HARVEST-SPEC §1/§2) — the skill_proposal store against a REAL throwaway SurrealDB.
// Covers: a draft is BORN status='open' (never 'approved' — no self-promotion); a normalized
// (case/space-insensitive) name+trigger match BUMPS occurrences instead of inserting a 2nd row; a
// planted secret in body/description is SCREENED to [REDACTED:*] before persist (and an un-redactable
// private-key block REJECTS, named); evidence + name shape contracts; the migration is idempotent
// (applied twice + over a half-applied state); F-013 honest datetimes/absents.

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

beforeEach(async () => {
	await db.query('DELETE skill_proposal;').catch(() => {});
});

function input(over: Partial<ProposeSkillInput> = {}): ProposeSkillInput {
	return {
		name: 'windows-pid-liveness',
		description: 'Check process liveness on Windows/MINGW reliably.',
		body: '# Windows PID liveness\n\nUse `tasklist /FI "PID eq <pid>"` — never `process.kill(pid, 0)`.',
		trigger_context: 'When checking whether a spawned process is still alive on Windows.',
		evidence: ['fails.md:F-001', 'session:abc'],
		...over
	};
}

describe('proposeSkill — born open, no self-promotion', () => {
	it('creates a proposal BORN status="open" (never approved)', async () => {
		const row = await proposeSkill(db, input());
		expect(row.status).toBe('open');
		expect(row.source).toBe('session-harvest');
		expect(row.occurrences).toBe(1);
		expect(row.approved_by).toBeUndefined();
		expect(row.approved_at).toBeNull();
		// F-013: datetimes are ISO strings, never the literal 'undefined'.
		expect(row.created_at).toBeTruthy();
		expect(row.created_at).not.toBe('undefined');
		expect(row.name).toBe('windows-pid-liveness');
	});

	it('persists the row readable back as open via listSkillProposals', async () => {
		await proposeSkill(db, input());
		const open = await listSkillProposals(db, { status: 'open' });
		expect(open).toHaveLength(1);
		expect(open[0].status).toBe('open');
		const approved = await listSkillProposals(db, { status: 'approved' });
		expect(approved).toHaveLength(0);
	});
});

describe('proposeSkill — normalized dedup bumps occurrences', () => {
	it('a matching normalized (name+trigger) draft bumps occurrences, not a 2nd row', async () => {
		const first = await proposeSkill(db, input());
		expect(first.occurrences).toBe(1);

		// Same name + trigger but with case + whitespace noise → must collapse onto the SAME row.
		const second = await proposeSkill(
			db,
			input({
				trigger_context: '  When   CHECKING whether a spawned process is still ALIVE on Windows.  ',
				description: 'A slightly reworded description.',
				body: '# Reworded body that should be ignored for dedup.'
			})
		);
		expect(second.id).toBe(first.id);
		expect(second.occurrences).toBe(2);

		const all = await listSkillProposals(db, {});
		expect(all).toHaveLength(1);
		expect(all[0].occurrences).toBe(2);
	});

	it('a DIFFERENT trigger inserts a new row (does not absorb)', async () => {
		await proposeSkill(db, input());
		const other = await proposeSkill(
			db,
			input({ trigger_context: 'A genuinely different trigger context.' })
		);
		expect(other.occurrences).toBe(1);
		const all = await listSkillProposals(db, {});
		expect(all).toHaveLength(2);
	});

	it('normalizedDedupKey is case- and whitespace-insensitive', () => {
		expect(normalizedDedupKey('Foo-Bar', '  Hello   World ')).toBe(
			normalizedDedupKey('foo-bar', 'hello world')
		);
	});
});

describe('proposeSkill — D-026 secret screen before persist', () => {
	it('a planted email/home-path in the body is REDACTED before persist (never raw)', async () => {
		const row = await proposeSkill(
			db,
			input({
				body: '# Skill\n\nContact dev@example.com and read /home/sam/.ssh/config for the path.'
			})
		);
		expect(row.body).not.toContain('dev@example.com');
		expect(row.body).not.toContain('/home/sam');
		expect(row.body).toContain('[REDACTED:email]');
		// Read back from the DB to prove the RAW secret never landed on disk.
		const fetched = await getSkillProposal(db, row.id);
		expect(fetched?.body).not.toContain('dev@example.com');
		expect(fetched?.body).toContain('[REDACTED:email]');
	});

	it('a planted provider key in the description is REDACTED before persist', async () => {
		const row = await proposeSkill(
			db,
			input({ description: 'Use the key sk-ant-abcd1234efgh5678 to authenticate.' })
		);
		expect(row.description).not.toContain('sk-ant-abcd1234efgh5678');
		expect(row.description).toContain('[REDACTED:anthropic-key]');
	});

	it('an un-redactable private-key block REJECTS the proposal (named, field carried)', async () => {
		const pem =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----';
		await expect(proposeSkill(db, input({ body: `# Skill\n\n${pem}` }))).rejects.toMatchObject({
			name: 'SkillSecretEchoError',
			field: 'body'
		});
		// Nothing persisted on the reject path.
		const all = await listSkillProposals(db, {});
		expect(all).toHaveLength(0);
	});
});

describe('proposeSkill — shape contracts (every error has a name)', () => {
	it('rejects a non-kebab name (no silent coercion)', async () => {
		await expect(proposeSkill(db, input({ name: 'Windows PID/Liveness' }))).rejects.toBeInstanceOf(
			SkillProposalContractError
		);
		await expect(proposeSkill(db, input({ name: '../escape' }))).rejects.toBeInstanceOf(
			SkillProposalContractError
		);
	});

	it('rejects an empty required field', async () => {
		await expect(proposeSkill(db, input({ description: '   ' }))).rejects.toBeInstanceOf(
			SkillProposalContractError
		);
		await expect(proposeSkill(db, input({ body: '' }))).rejects.toBeInstanceOf(
			SkillProposalContractError
		);
	});

	it('accepts an empty evidence array (evidence is optional; F-008 honest empty)', async () => {
		const row = await proposeSkill(db, input({ evidence: [] }));
		expect(row.evidence).toEqual([]);
	});

	it('rejects over-long evidence list', async () => {
		const many = Array.from({ length: 40 }, (_, i) => `ref:${i}`);
		await expect(proposeSkill(db, input({ evidence: many }))).rejects.toBeInstanceOf(
			SkillProposalContractError
		);
	});
});

describe('skill_proposal migration — idempotent (F-015)', () => {
	it('re-running the migration is a no-op (apply twice)', async () => {
		// A throwaway DB so we can re-run migrations independently.
		const tdb2 = await startTestDb();
		const db2 = await Db.connect({
			url: tdb2.wsUrl,
			username: tdb2.root.username,
			password: tdb2.root.password,
			namespace: tdb2.namespace,
			database: tdb2.database
		});
		try {
			const first = await runMigrations(db2, schemaMigrations);
			expect(first).toContain('0060_skill_proposal');
			// Second full run records nothing new (the ledger skips applied ids).
			const second = await runMigrations(db2, schemaMigrations);
			expect(second).not.toContain('0060_skill_proposal');

			// Apply the bare DDL a THIRD time directly (simulates a half-applied re-run): OVERWRITE
			// statements re-apply cleanly with no error.
			const m = schemaMigrations.find((x) => x.id === '0060_skill_proposal');
			await db2.query(m!.up);

			// The table still functions after the re-applies.
			const row = await proposeSkill(db2, input());
			expect(row.status).toBe('open');
		} finally {
			await db2.close().catch(() => {});
			await tdb2.teardown();
		}
	}, 90_000);

	it('recovers over a half-applied state (table exists, fields re-OVERWRITE clean)', async () => {
		const tdb3 = await startTestDb();
		const db3 = await Db.connect({
			url: tdb3.wsUrl,
			username: tdb3.root.username,
			password: tdb3.root.password,
			namespace: tdb3.namespace,
			database: tdb3.database
		});
		try {
			// Simulate a half-applied 0060: the table is created but its fields never landed.
			await db3.query('DEFINE TABLE skill_proposal SCHEMAFULL;');
			// The real migration must OVERWRITE-recover without "table already exists".
			const applied = await runMigrations(db3, schemaMigrations);
			expect(applied).toContain('0060_skill_proposal');
			const row = await proposeSkill(db3, input());
			expect(row.status).toBe('open');
			expect(row.occurrences).toBe(1);
		} finally {
			await db3.close().catch(() => {});
			await tdb3.teardown();
		}
	}, 90_000);
});
