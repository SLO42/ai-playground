import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	proposeSkill,
	getSkillProposal,
	listSkillProposals,
	rejectSkill,
	SkillRejectNotFoundError,
	SkillRejectNotAllowedError,
	type ProposeSkillInput
} from './proposal';

// SH-4 VERIFY (SKILL-HARVEST-SPEC §4 — the operator review surface's MARK path) against a REAL
// throwaway SurrealDB. Covers the integrity invariants the reject action must hold:
//   • MARK NOT DELETE (G2) — a rejected proposal is RETAINED for audit (still SELECT-able), status flips;
//   • OPERATOR-ONLY (G2/D-039) — an empty decider fails closed, never marks;
//   • APPROVED IS TERMINAL — an approved proposal (live skill on disk/catalog) is not reject-able here;
//   • HONEST ABSENT — an unknown id throws named, not a silent no-op;
//   • IDEMPOTENT (F-015) — re-rejecting by the same operator is a no-op; the row is unchanged.

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
		evidence: ['fails.md:F-001'],
		...over
	};
}

describe('rejectSkill — MARK not delete (G2 audit retention)', () => {
	it('flips an open proposal to rejected, records the operator, and RETAINS the row', async () => {
		const p = await proposeSkill(db, input());
		expect(p.status).toBe('open');

		const rejected = await rejectSkill(db, p.id, 'operator:sam');
		expect(rejected.status).toBe('rejected');
		expect(rejected.approved_by).toBe('operator:sam');
		expect(rejected.approved_at).toBeTruthy();

		// MARK not delete: the row is still readable (audit retention — G2).
		const reread = await getSkillProposal(db, p.id);
		expect(reread).not.toBeNull();
		expect(reread?.status).toBe('rejected');

		// The default (open) review list no longer shows it; a rejected filter does (audit).
		const open = await listSkillProposals(db, { status: 'open' });
		expect(open.find((r) => r.id === p.id)).toBeUndefined();
		const closed = await listSkillProposals(db, { status: 'rejected' });
		expect(closed.find((r) => r.id === p.id)).toBeDefined();
	});

	it('frees the normalized dedup key so a fresh open draft of the same pattern can start', async () => {
		const p = await proposeSkill(db, input());
		await rejectSkill(db, p.id, 'operator:sam');
		// A new draft of the SAME normalized (name+trigger) inserts a NEW open row (does not absorb onto
		// the closed one) — the rejected row coexists for audit.
		const fresh = await proposeSkill(db, input());
		expect(fresh.id).not.toBe(p.id);
		expect(fresh.status).toBe('open');
		expect(fresh.occurrences).toBe(1);
	});
});

describe('rejectSkill — operator-only, fail closed (G2/D-039)', () => {
	it('an EMPTY decider fails closed and never marks the row', async () => {
		const p = await proposeSkill(db, input());
		await expect(rejectSkill(db, p.id, '   ')).rejects.toBeInstanceOf(SkillRejectNotAllowedError);
		const reread = await getSkillProposal(db, p.id);
		expect(reread?.status).toBe('open');
	});

	it('an APPROVED proposal is not reject-able from the review surface (terminal)', async () => {
		const p = await proposeSkill(db, input());
		// Simulate the promote path having approved it (status + approver) without invoking SH-3 disk.
		await db.query(`UPDATE ${p.id} SET status = "approved", approved_by = "operator:sam";`);
		await expect(rejectSkill(db, p.id, 'operator:sam')).rejects.toBeInstanceOf(
			SkillRejectNotAllowedError
		);
		const reread = await getSkillProposal(db, p.id);
		expect(reread?.status).toBe('approved');
	});

	it('an unknown id throws a NAMED honest-absent error (not a silent no-op)', async () => {
		await expect(rejectSkill(db, 'skill_proposal:nope', 'operator:sam')).rejects.toBeInstanceOf(
			SkillRejectNotFoundError
		);
	});
});

describe('rejectSkill — idempotent (F-015 interrupt-safe re-run)', () => {
	it('re-rejecting by the same operator is a no-op (status unchanged, still retained)', async () => {
		const p = await proposeSkill(db, input());
		const first = await rejectSkill(db, p.id, 'operator:sam');
		const second = await rejectSkill(db, p.id, 'operator:sam');
		expect(second.status).toBe('rejected');
		expect(second.approved_by).toBe('operator:sam');
		expect(second.id).toBe(first.id);
	});
});
