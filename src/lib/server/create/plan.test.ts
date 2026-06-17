import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createRole, createGauntletFixture, createGauntletKey } from '../workforce/repo';
import { newSentinelUlid } from '../workforce/activation';
import {
	generateCreationProposal,
	validateProposal,
	computeConfirmToken,
	assertProposalFresh,
	ProposalContractError,
	SecretEchoError,
	StaleProposalError,
	SycophancyError,
	type CreateBrief,
	type CreationProposal,
	type ProposalGenerator
} from './plan';

// CA-1 (CREATE-SPEC §2.1-2.3, §3) — the generative PLAN half. Run against a REAL throwaway
// SurrealDB (the only DB touch is listDefectClassVocabulary, exercised live), with a STUBBED
// generator for the agent leg (no creds/network/spend — mirrors launchSession's scripted backend).

let tdb: TestDb;
let db: Db;

/** Seed ONE operator-confirmed defect class into the vocabulary, returning its name. */
async function seedDefectClass(cls: string): Promise<void> {
	const role = await createRole(db, { slug: `ca1-${cls}`, name: `Role ${cls}`, purpose: 'CA-1 vocab seed' });
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: `ca1-fx-${cls}`,
		kind: 'planted_defect',
		work: { 'a.ts': 'l1\nl2\nx();\n' },
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		author: 'operator',
		plants: [{ id: 'p1', class: cls, detection: { file: 'a.ts', lines: [3, 3] } }]
	});
}

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
	await seedDefectClass('null-deref');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

const BRIEF: CreateBrief = {
	name: 'rounds-mod',
	description: 'A ROUNDS mod that adds a survival difficulty curve.',
	hints: { ecosystem: 'node', targetPlatform: 'desktop' }
};

/** A well-formed raw proposal (the agent's structured output) for the happy path. */
function goodRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dirLayout: ['src/', 'src/index.ts', 'tests/'],
		stack: ['TypeScript', 'Node'],
		planMacro: {
			purpose: 'Add a survival difficulty curve to ROUNDS.',
			vision: 'A mod players reach for when the base game feels flat.',
			role: 'Solo maintainer with periodic playtests.',
			definition_of_done: 'Mod loads, curve is configurable, no crash across 10 rounds.'
		},
		foundingTasks: [
			{ objective: 'Scaffold the mod loader', purpose: 'Nothing ships until the mod loads in-game.' },
			{ objective: 'Implement the difficulty curve', purpose: 'The curve is the whole point of the mod.' },
			{ objective: 'Add a config surface', purpose: 'Players tune the curve without code edits.' }
		],
		targetDrafts: [{ kind: 'publish', adapterId: 'thunderstore', config: { tokenEnv: 'THUNDERSTORE_TOKEN' } }],
		capabilityNeeds: { languages: ['typescript'], frameworks: [], defect_classes: ['null-deref'] },
		clarifiers: [
			{
				question: 'Single package or split core/UI?',
				position: 'A single package will hold unless you expect independent release cadences.',
				falsifier: 'Evidence of separate UI release timelines would justify a split.'
			}
		],
		...over
	};
}

const stubGen = (raw: unknown): ProposalGenerator => async () => raw;

describe('generateCreationProposal — happy path', () => {
	it('validates the agent output and mints a stable confirmToken (no disk/DB write)', async () => {
		const env = await generateCreationProposal(db, BRIEF, stubGen(goodRaw()));
		expect(env.brief).toEqual(BRIEF);
		expect(env.proposal.foundingTasks.length).toBe(3);
		expect(env.proposal.capabilityNeeds.defect_classes).toEqual(['null-deref']);
		expect(env.confirmToken).toMatch(/^[0-9a-f]{64}$/);
		// token is deterministic over {brief, proposal}.
		expect(computeConfirmToken(env.brief, env.proposal)).toBe(env.confirmToken);
	});
});

describe('shadow paths — the agent leg returns bad/edge output', () => {
	it('nil agent output → ProposalContractError (named)', async () => {
		await expect(generateCreationProposal(db, BRIEF, stubGen(null))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
	it('empty object → ProposalContractError on the first missing field', async () => {
		await expect(generateCreationProposal(db, BRIEF, stubGen({}))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
	it('upstream agent error propagates UNSWALLOWED (never silence-as-success)', async () => {
		const boom: ProposalGenerator = async () => {
			throw new Error('runtime timeout');
		};
		await expect(generateCreationProposal(db, BRIEF, boom)).rejects.toThrow('runtime timeout');
	});
	it('nil brief field → ProposalContractError before the agent runs', async () => {
		const bad = { ...BRIEF, name: '' };
		await expect(generateCreationProposal(db, bad, stubGen(goodRaw()))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
});

describe('founding-task count (fork 4: 3-7 milestone-level)', () => {
	it('rejects fewer than 3', async () => {
		const raw = goodRaw({ foundingTasks: [{ objective: 'x', purpose: 'y' }] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalContractError);
	});
	it('rejects more than 7', async () => {
		const tasks = Array.from({ length: 8 }, (_, i) => ({ objective: `o${i}`, purpose: `p${i}` }));
		await expect(validateProposal(db, goodRaw({ foundingTasks: tasks }))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
	it('rejects a task missing its purpose (D-039 — never born purposeless)', async () => {
		const raw = goodRaw({
			foundingTasks: [
				{ objective: 'a', purpose: 'p' },
				{ objective: 'b', purpose: 'p' },
				{ objective: 'c' } // no purpose
			]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalContractError);
	});
});

describe('clarifier count (G4: 0-4, must-not-interrogate)', () => {
	it('allows zero (a brief that does not fork)', async () => {
		const p = await validateProposal(db, goodRaw({ clarifiers: [] }));
		expect(p.clarifiers).toEqual([]);
	});
	it('rejects more than 4', async () => {
		const five = Array.from({ length: 5 }, (_, i) => ({
			question: `q${i}`,
			position: `pos${i}`,
			falsifier: `f${i}`
		}));
		await expect(validateProposal(db, goodRaw({ clarifiers: five }))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
	it('rejects a clarifier missing its falsifier (§3 — every position has one)', async () => {
		const raw = goodRaw({ clarifiers: [{ question: 'q', position: 'p' }] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalContractError);
	});
});

describe('anti-sycophancy enforcement (§3, redTeam)', () => {
	it('rejects a banned phrase anywhere in agent-authored text', async () => {
		const raw = goodRaw({
			planMacro: {
				purpose: 'That could work as a purpose.',
				vision: 'v',
				role: 'r',
				definition_of_done: 'd'
			}
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SycophancyError);
	});
	it('rejects a hedge inside a clarifier position', async () => {
		const raw = goodRaw({
			clarifiers: [
				{
					question: 'q',
					position: 'There are many ways to think about this.',
					falsifier: 'f'
				}
			]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SycophancyError);
	});
	// Regression (review gap 1): the §3 rail must cover EVERY agent-authored string, including the
	// stack[] and dirLayout[] arrays — a banned hedge there previously reached the operator unflagged.
	it('rejects a banned phrase inside a stack[] entry (regression: was uncovered)', async () => {
		const raw = goodRaw({ stack: ['That could work', 'Node'] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SycophancyError);
	});
	it('rejects a banned phrase inside a dirLayout[] entry (regression: was uncovered)', async () => {
		const raw = goodRaw({ dirLayout: ['src/', 'You might want to consider this dir'] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SycophancyError);
	});
});

describe('D-026 no-secret-echo in target configs (redTeam)', () => {
	it('rejects a literal secret value in a target config', async () => {
		const raw = goodRaw({
			targetDrafts: [
				{ kind: 'deploy', adapterId: 'vercel', config: { token: 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' } }
			]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('accepts an env NAME reference in a target config', async () => {
		const p = await validateProposal(
			db,
			goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'vercel', config: { tokenEnv: 'VERCEL_TOKEN' } }] })
		);
		expect(p.targetDrafts[0].config).toEqual({ tokenEnv: 'VERCEL_TOKEN' });
	});
});

describe('defect_class enum-closed (§3 D4, vs the live vocabulary)', () => {
	it('accepts a class in the operator-confirmed vocabulary', async () => {
		const p = await validateProposal(db, goodRaw());
		expect(p.capabilityNeeds.defect_classes).toEqual(['null-deref']);
	});
	it('rejects a class NOT in the vocabulary', async () => {
		const raw = goodRaw({
			capabilityNeeds: { languages: [], frameworks: [], defect_classes: ['never-confirmed-class'] }
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalContractError);
	});
	it('empty defect_classes is honest (F-008) — no enum check needed', async () => {
		const p = await validateProposal(
			db,
			goodRaw({ capabilityNeeds: { languages: ['ts'], frameworks: [], defect_classes: [] } })
		);
		expect(p.capabilityNeeds.defect_classes).toEqual([]);
	});
});

describe('confirmToken staleness (D-010 shape, ephemeral)', () => {
	it('a matching brief+proposal passes assertProposalFresh', async () => {
		const env = await generateCreationProposal(db, BRIEF, stubGen(goodRaw()));
		expect(() => assertProposalFresh(env.brief, env.proposal, env.confirmToken)).not.toThrow();
	});
	it('a changed brief → StaleProposalError', async () => {
		const env = await generateCreationProposal(db, BRIEF, stubGen(goodRaw()));
		const changed: CreateBrief = { ...env.brief, description: env.brief.description + ' (edited)' };
		expect(() => assertProposalFresh(changed, env.proposal, env.confirmToken)).toThrow(StaleProposalError);
	});
	it('a changed proposal → StaleProposalError', async () => {
		const env = await generateCreationProposal(db, BRIEF, stubGen(goodRaw()));
		const tampered: CreationProposal = {
			...env.proposal,
			stack: [...env.proposal.stack, 'sneaky-extra']
		};
		expect(() => assertProposalFresh(env.brief, tampered, env.confirmToken)).toThrow(StaleProposalError);
	});
});
