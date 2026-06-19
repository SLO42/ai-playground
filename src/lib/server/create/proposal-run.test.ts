import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createRole, createGauntletFixture, createGauntletKey } from '../workforce/repo';
import { newSentinelUlid } from '../workforce/activation';
import {
	createProposalRun,
	attachSession,
	markProposalDone,
	markProposalFailed,
	getProposalRun,
	runProposalInBackground
} from './proposal-run';
import { assertProposalFresh, type CreateBrief, type ProposalGenerator } from './plan';

// Create-with-AI ASYNC propose — the create_proposal_run lifecycle vs a REAL throwaway SurrealDB
// (no agent spend: the proposal comes from a STUBBED generator). Covers the four shadow paths
// (generating / done / failed / nil), the D-010 token round-trip, D-026 brief + envelope screening,
// and the red-team invariants (no envelope while generating, no partial envelope on failure, no raw
// secret in a persisted run row, concurrent proposes create distinct runs).

let tdb: TestDb;
let db: Db;
let hostProject: string;

async function seedDefectClass(cls: string): Promise<void> {
	const role = await createRole(db, { slug: `pr-${cls}`, name: `Role ${cls}`, purpose: 'proposal-run vocab seed' });
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: `pr-fx-${cls}`,
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
	const proj = await createProject(db, {
		slug: 'pr_host',
		name: 'Proposal Run Host',
		root_path: 'F:/code/pr-host'
	});
	hostProject = String(proj.id);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

const stubGen = (raw: unknown): ProposalGenerator => async () => raw;

/** A well-formed raw proposal (the agent's structured output). */
function goodRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dirLayout: ['src/', 'src/index.ts', 'package.json'],
		stack: ['TypeScript', 'Node'],
		planMacro: {
			purpose: 'A small CLI that prints a curve.',
			vision: 'A tool reached for when tuning a run.',
			role: 'Solo maintainer.',
			definition_of_done: 'CLI runs, curve configurable, no crash across 10 inputs.'
		},
		foundingTasks: [
			{ objective: 'Scaffold the CLI entry point', purpose: 'Nothing runs until the entry exists.' },
			{ objective: 'Implement the curve', purpose: 'The curve is the whole point.' },
			{ objective: 'Add a config surface', purpose: 'Users tune without code edits.' }
		],
		targetDrafts: [{ kind: 'publish', adapterId: 'npm', config: { tokenEnv: 'NPM_TOKEN' } }],
		capabilityNeeds: { languages: ['typescript'], frameworks: [], defect_classes: ['null-deref'] },
		clarifiers: [],
		...over
	};
}

const BRIEF: CreateBrief = { name: 'curve-cli', description: 'A CLI that prints a difficulty curve.' };

describe('createProposalRun — the generating state (shadow: in-flight)', () => {
	it('starts in generating with NO envelope and NO error_reason, screened brief stored', async () => {
		const runId = await createProposalRun(db, { project: hostProject, brief: BRIEF });
		const run = await getProposalRun(db, runId);
		expect(run).not.toBeNull();
		expect(run!.status).toBe('generating');
		expect(run!.envelope).toBeUndefined(); // red-team: no envelope while generating
		expect(run!.errorReason).toBeUndefined();
		expect(run!.project).toBe(hostProject);
		expect(run!.brief.name).toBe('curve-cli');
		expect(run!.createdAt).toBeTypeOf('string'); // F-013: ISO string, not a raw Date
		expect(run!.endedAt).toBeUndefined();
		expect(run!.session).toBeUndefined();
	});

	it('attachSession stamps the live session id (surfaced synchronously at launch)', async () => {
		const runId = await createProposalRun(db, { project: hostProject, brief: BRIEF });
		// A real session row to link (the generation session). project is a record<project>, so the
		// id binds as a StringRecordId (the D-016 record-link shape), not a plain string.
		const [s] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session CONTENT { project: $p, kind: "task", runtime: "claude-code", model: { provider: "anthropic", model_id: "x", tier: "cheap" } } RETURN AFTER;`,
			{ p: new StringRecordId(hostProject) }
		);
		const sid = String(s[0].id);
		await attachSession(db, runId, sid);
		const run = await getProposalRun(db, runId);
		expect(run!.session).toBe(sid);
		expect(run!.status).toBe('generating'); // still in flight
	});
});

describe('getProposalRun — nil shadow path', () => {
	it('unknown run id → null (honest empty, never fabricated)', async () => {
		expect(await getProposalRun(db, 'create_proposal_run:nope')).toBeNull();
	});
});

describe('runProposalInBackground — done', () => {
	it('resolves to done with a token-bound envelope that re-validates at execute (D-010)', async () => {
		const runId = await createProposalRun(db, { project: hostProject, brief: BRIEF });
		await runProposalInBackground(db, runId, BRIEF, stubGen(goodRaw()));
		const run = await getProposalRun(db, runId);
		expect(run!.status).toBe('done');
		expect(run!.errorReason).toBeUndefined();
		expect(run!.envelope).toBeDefined();
		expect(run!.endedAt).toBeTypeOf('string'); // F-013
		// The persisted envelope's confirmToken STILL validates (the executor's freshness check).
		const env = run!.envelope!;
		expect(() => assertProposalFresh(env.brief, env.proposal, env.confirmToken)).not.toThrow();
		// The brief inside the envelope is the VERBATIM token-bound brief (not the screened display copy).
		expect(env.brief.name).toBe('curve-cli');
	});
});

describe('runProposalInBackground — failed (shadow: agent garbage + leg error)', () => {
	it('a contract violation → failed with an honest reason and NO partial envelope', async () => {
		const runId = await createProposalRun(db, { project: hostProject, brief: BRIEF });
		// Missing required dirLayout → ProposalContractError inside validateProposal.
		await runProposalInBackground(db, runId, BRIEF, stubGen(goodRaw({ dirLayout: [] })));
		const run = await getProposalRun(db, runId);
		expect(run!.status).toBe('failed');
		expect(run!.envelope).toBeUndefined(); // red-team: no partial envelope on failure
		expect(run!.errorReason).toBeTypeOf('string');
		expect(run!.errorReason!.length).toBeGreaterThan(0); // honest, non-empty
		expect(run!.endedAt).toBeTypeOf('string');
	});

	it('an agent-leg throw (env/timeout) → failed, the runtime reason surfaced, no envelope', async () => {
		const runId = await createProposalRun(db, { project: hostProject, brief: BRIEF });
		const throwingGen: ProposalGenerator = async () => {
			throw new Error('proposal session ended timeout (not done)');
		};
		await runProposalInBackground(db, runId, BRIEF, throwingGen);
		const run = await getProposalRun(db, runId);
		expect(run!.status).toBe('failed');
		expect(run!.envelope).toBeUndefined();
		expect(run!.errorReason).toMatch(/timeout|session|agent|fail/i);
	});
});

describe('D-026 — no raw secret in a persisted/rendered run row', () => {
	it('a secret pasted into the brief description is SCREENED in the stored brief column', async () => {
		const leaky: CreateBrief = {
			name: 'leaky',
			description: 'deploy with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 please'
		};
		const runId = await createProposalRun(db, { project: hostProject, brief: leaky });
		const run = await getProposalRun(db, runId);
		// The raw GitHub PAT must NOT round-trip out of the rendered brief column.
		expect(run!.brief.description).not.toMatch(/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/);
	});
});

describe('concurrent proposes create DISTINCT runs', () => {
	it('two creates yield two different run ids, each independently resolvable', async () => {
		const [a, b] = await Promise.all([
			createProposalRun(db, { project: hostProject, brief: BRIEF }),
			createProposalRun(db, { project: hostProject, brief: { name: 'other', description: 'a second brief' } })
		]);
		expect(a).not.toBe(b);
		await Promise.all([
			runProposalInBackground(db, a, BRIEF, stubGen(goodRaw())),
			runProposalInBackground(db, b, { name: 'other', description: 'a second brief' }, stubGen(goodRaw()))
		]);
		const [ra, rb] = await Promise.all([getProposalRun(db, a), getProposalRun(db, b)]);
		expect(ra!.status).toBe('done');
		expect(rb!.status).toBe('done');
		expect(ra!.envelope!.brief.name).toBe('curve-cli');
		expect(rb!.envelope!.brief.name).toBe('other');
	});

	it('markProposalFailed then a read shows the honest failed state (idempotent re-resolve safe)', async () => {
		const runId = await createProposalRun(db, { project: hostProject, brief: BRIEF });
		await markProposalFailed(db, runId, 'manual failure for the test');
		const run = await getProposalRun(db, runId);
		expect(run!.status).toBe('failed');
		expect(run!.errorReason).toContain('manual failure');
		// Re-marking done over a failed row is a plain UPDATE (no half-state); the interrupt contract.
		await markProposalDone(db, runId, {
			brief: BRIEF,
			proposal: (await runResolveProposal()) as never,
			confirmToken: 'x'
		} as never);
		const run2 = await getProposalRun(db, runId);
		expect(run2!.status).toBe('done');
	});
});

// Helper: produce a validated proposal object for the re-resolve idempotency check above.
async function runResolveProposal(): Promise<unknown> {
	const { validateProposal } = await import('./plan');
	return validateProposal(db, goodRaw());
}
