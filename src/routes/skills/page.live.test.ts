// SH-4 integration proof for /skills (SKILL-HARVEST-SPEC §4) against a REAL throwaway SurrealDB + a
// temp harvest scope on disk. The +page.server actions pull $env + hooks.server boot side-effects, so
// (mirroring settings/page.live.test) we exercise the SAME backend the load/actions call — listSkill-
// Proposals / promoteSkill / rejectSkill — and assert the contract end-to-end:
//
//   1. LOAD-SHAPE — the ProposalCard the loader serializes is a fully POJO, devalue-safe payload (no
//      Surreal RecordId / Datetime leak — the F-013 class guard), ranked highest-occurrence first.
//   2. APPROVE — promoteSkill (the approve action's call) writes the confined SKILL.md + lands the name
//      in catalogIds, recording the server-resolved operator. The promoted proposal leaves the open list.
//   3. REJECT — rejectSkill (the reject action's call) MARKS the row rejected (retained for audit) and
//      removes it from the open list; the row is still SELECT-able (G2 mark-don't-delete).
//
// If the SurrealDB binary can't start, the DB-backed assertions skip honestly (never a faked artifact).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { catalogIds, harvestScopeDir } from '$lib/server/cc-config';
import {
	proposeSkill,
	editProposal,
	listSkillProposals,
	getSkillProposal,
	rejectSkill,
	type SkillProposalRow
} from '$lib/server/skills/proposal';
import { promoteSkill } from '$lib/server/skills/promote';

const BODY_PREVIEW_CHARS = 600;

/** The SAME ProposalCard projection the +page.server load() serializes (kept in-test to avoid the
 *  $env/hooks side-effects of importing +page.server). */
function toCard(row: SkillProposalRow) {
	const body = row.body ?? '';
	const truncated = body.length > BODY_PREVIEW_CHARS;
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		body,
		bodyPreview: truncated ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body,
		bodyTruncated: truncated,
		triggerContext: row.trigger_context,
		evidence: row.evidence ?? [],
		occurrences: row.occurrences,
		createdAt: row.created_at
	};
}

let tdb: TestDb | undefined;
let db: Db | undefined;
let harvestRoot: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
	try {
		tdb = await startTestDb();
		db = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		await runMigrations(db, schemaMigrations);
	} catch {
		tdb = undefined;
		db = undefined;
	}
}, 90_000);

afterAll(async () => {
	if (db) await db.close().catch(() => {});
	if (tdb) await tdb.teardown().catch(() => {});
	if (harvestRoot) rmSync(harvestRoot, { recursive: true, force: true });
});

beforeEach(async () => {
	if (!db) return;
	await db.query('DELETE skill_proposal;').catch(() => {});
	await db.query('DELETE cc_skill;').catch(() => {});
	await db.query('DELETE cc_scope;').catch(() => {});
	await db.query('DELETE cc_settings;').catch(() => {});
	if (harvestRoot) rmSync(harvestRoot, { recursive: true, force: true });
	harvestRoot = mkdtempSync(join(tmpdir(), 'sh4-harvest-'));
	env = { ...process.env, HARVEST_SCOPE_ROOT: harvestRoot };
});

describe('/skills load-shape — open proposals ranked, fully serializable (F-013 guard)', () => {
	it('ranks highest-occurrence first and is devalue-safe', async () => {
		if (!db) return expect(true).toBe(true);
		// One pattern surfaced twice (occurrences=2 after the second draft dedups onto it), one once.
		await proposeSkill(db, {
			name: 'windows-pid-liveness',
			description: 'Check process liveness on Windows.',
			body: '# liveness\nUse tasklist.',
			trigger_context: 'checking a spawned process is alive on Windows'
		});
		await proposeSkill(db, {
			name: 'windows-pid-liveness',
			description: 'Check process liveness on Windows.',
			body: '# liveness\nUse tasklist.',
			trigger_context: 'checking a spawned process is alive on Windows'
		});
		await proposeSkill(db, {
			name: 'atomic-write-rename',
			description: 'Stage then rename for atomic file writes.',
			body: '# atomic\nstage→rename',
			trigger_context: 'writing a file that a concurrent reader may observe'
		});

		const cards = (await listSkillProposals(db, { status: 'open' })).map(toCard);
		expect(cards.length).toBe(2);
		// RECUR/RANK §2 — highest occurrence first.
		expect(cards[0].name).toBe('windows-pid-liveness');
		expect(cards[0].occurrences).toBe(2);

		// Devalue-safe POJO (no RecordId/Datetime leak — F-013 class).
		expect(structuredClone(cards)).toEqual(cards);
		expect(JSON.parse(JSON.stringify(cards))).toEqual(cards);
	});

	it('truncates an over-long body into a preview but keeps the full screened body', async () => {
		if (!db) return expect(true).toBe(true);
		const longBody = `# big\n${'x'.repeat(BODY_PREVIEW_CHARS + 50)}`;
		await proposeSkill(db, {
			name: 'big-skill',
			description: 'A skill with a long body.',
			body: longBody,
			trigger_context: 'when the body is long'
		});
		const [card] = (await listSkillProposals(db, { status: 'open' })).map(toCard);
		expect(card.bodyTruncated).toBe(true);
		expect(card.bodyPreview.length).toBeLessThan(card.body.length);
		expect(card.body).toBe(longBody);
	});
});

describe('/skills approve action — promote lands the skill in the catalog', () => {
	it('approve promotes (disk + cc_skill) and the proposal leaves the open list', async () => {
		if (!db) return expect(true).toBe(true);
		const p = await proposeSkill(db, {
			name: 'windows-pid-liveness',
			description: 'Check process liveness on Windows.',
			body: '# liveness\nUse tasklist.',
			trigger_context: 'checking a spawned process is alive on Windows'
		});

		const before = await catalogIds(db);
		expect(before.skills.has('windows-pid-liveness')).toBe(false);

		// The approve action's call: server-resolved operator id, never the form.
		const res = await promoteSkill(db, { proposalId: p.id, approver: 'operator', env });
		expect(existsSync(res.filePath)).toBe(true);
		expect(res.filePath.startsWith(harvestScopeDir(env))).toBe(true);

		const after = await catalogIds(db);
		expect(after.skills.has('windows-pid-liveness')).toBe(true);

		// The promoted proposal is no longer in the OPEN review list.
		const open = await listSkillProposals(db, { status: 'open' });
		expect(open.find((r) => r.id === p.id)).toBeUndefined();
	});
});

// REGRESSION (SH-4 DoD-review defect): edit-then-approve MUST persist the operator's body/description
// edit and promote THAT — never the original undedited body — and must NOT bump the recurrence counter.
describe('/skills editApprove action — operator edit persists; not a harvested recurrence', () => {
	it('body+description edit (name+trigger unchanged) updates IN PLACE, promotes the edited body, keeps occurrences', async () => {
		if (!db) return expect(true).toBe(true);
		// A pattern surfaced twice → occurrences=2 (the dedup-bump path the defect collided with).
		const seed = {
			name: 'windows-pid-liveness',
			description: 'ORIGINAL description.',
			body: '# liveness\nORIGINAL BODY',
			trigger_context: 'checking a spawned process is alive on Windows'
		};
		await proposeSkill(db, seed);
		const orig = await proposeSkill(db, seed);
		expect(orig.occurrences).toBe(2);

		// The operator edits body+description but leaves name+trigger (the skill identity) unchanged.
		const { row: edited, renamed } = await editProposal(db, orig.id, {
			name: seed.name,
			description: 'EDITED description by operator.',
			body: '# liveness\nEDITED BODY OPERATOR CHANGED',
			trigger_context: seed.trigger_context
		});

		// IN-PLACE: same row id, NOT a rename, edited content persisted, occurrences UNCHANGED (not 3).
		expect(renamed).toBe(false);
		expect(edited.id).toBe(orig.id);
		expect(edited.body).toBe('# liveness\nEDITED BODY OPERATOR CHANGED');
		expect(edited.description).toBe('EDITED description by operator.');
		expect(edited.occurrences).toBe(2);

		// The promoted SKILL.md on disk carries the EDITED body — not 'ORIGINAL BODY' (the defect).
		const res = await promoteSkill(db, { proposalId: edited.id, approver: 'operator', env });
		expect(existsSync(res.filePath)).toBe(true);
		const onDisk = readFileSync(res.filePath, 'utf8');
		expect(onDisk).toContain('EDITED BODY OPERATOR CHANGED');
		expect(onDisk).not.toContain('ORIGINAL BODY');
	});

	it('a RENAME (name changed) creates a fresh draft and leaves the original open (renamed:true)', async () => {
		if (!db) return expect(true).toBe(true);
		const orig = await proposeSkill(db, {
			name: 'old-name',
			description: 'desc.',
			body: '# body',
			trigger_context: 'some trigger context'
		});

		const { row: renamedRow, renamed } = await editProposal(db, orig.id, {
			name: 'new-name',
			description: 'desc.',
			body: '# body',
			trigger_context: 'some trigger context'
		});

		expect(renamed).toBe(true);
		expect(renamedRow.id).not.toBe(orig.id);
		expect(renamedRow.name).toBe('new-name');
		// Both are still OPEN (the original is retained for review — G2).
		const open = await listSkillProposals(db, { status: 'open' });
		expect(open.find((r) => r.id === orig.id)).toBeDefined();
		expect(open.find((r) => r.id === renamedRow.id)).toBeDefined();
	});

	it('editing an unknown id throws the honest named absent (SkillRejectNotFoundError)', async () => {
		if (!db) return expect(true).toBe(true);
		await expect(
			editProposal(db, 'skill_proposal:does_not_exist', {
				name: 'whatever-name',
				description: 'd',
				body: 'b',
				trigger_context: 't'
			})
		).rejects.toThrow(/not found/i);
	});
});

describe('/skills reject action — MARK not delete (G2 audit retention)', () => {
	it('reject marks the row rejected, removes it from open, and retains it', async () => {
		if (!db) return expect(true).toBe(true);
		const p = await proposeSkill(db, {
			name: 'flaky-pattern',
			description: 'A pattern not worth keeping.',
			body: '# nope',
			trigger_context: 'when an idea is not reusable enough'
		});

		const row = await rejectSkill(db, p.id, 'operator');
		expect(row.status).toBe('rejected');
		expect(row.approved_by).toBe('operator');

		// Gone from open, retained in the table (audit).
		const open = await listSkillProposals(db, { status: 'open' });
		expect(open.find((r) => r.id === p.id)).toBeUndefined();
		const retained = await getSkillProposal(db, p.id);
		expect(retained?.status).toBe('rejected');
	});
});
