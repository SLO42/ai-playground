import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createRole, createGauntletFixture, createGauntletKey } from '../workforce/repo';
import { newSentinelUlid } from '../workforce/activation';
import { EventBus } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { parseProposalOutput, makeProposalAgent } from './agent';
import { generateCreationProposal, ProposalContractError, type CreateBrief } from './plan';

// CA-1 agent leg — the structured-output PARSER (pure) + the production ProposalGenerator wired
// through launchSession with a SCRIPTED backend (no creds/network/spend — mirrors launch.test.ts).

describe('parseProposalOutput — shadow paths', () => {
	it('nil/empty → ProposalContractError (EMPTY output, named channel)', () => {
		expect(() => parseProposalOutput(undefined)).toThrow(ProposalContractError);
		expect(() => parseProposalOutput('   ')).toThrow(/EMPTY output/);
	});
	it('no JSON block → ProposalContractError (no JSON block)', () => {
		expect(() => parseProposalOutput('just some prose, no braces')).toThrow(/no JSON block/);
	});
	it('malformed JSON block → ProposalContractError (did not parse)', () => {
		expect(() => parseProposalOutput('```json\n{ not: valid, }\n```')).toThrow(/did not parse/);
	});
	it('parses the LAST fenced json block', () => {
		const text = '```json\n{"a":1}\n```\nthen\n```json\n{"b":2}\n```';
		expect(parseProposalOutput(text)).toEqual({ b: 2 });
	});
	it('falls back to outermost braces when fence-less', () => {
		expect(parseProposalOutput('prefix {"x": true} suffix')).toEqual({ x: true });
	});
});

// ── integration: makeProposalAgent through a scripted launchSession ──────────────

function scriptedBackend(events: RuntimeEvent[], ccSessionId = `cc_${Math.random().toString(36).slice(2, 9)}`): CcBackend {
	return {
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			void plan;
			return {
				ccSessionId,
				async *stream() {
					for (const e of events) yield e;
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return {
				ccSessionId: req.ccSessionId,
				async *stream() {
					yield { type: 'done', result: { ok: true, summary: 'resumed' } };
				},
				async cancel() {}
			};
		},
		async interject() {}
	};
}

const RAW = {
	dirLayout: ['src/', 'src/index.ts'],
	stack: ['TypeScript'],
	planMacro: { purpose: 'p', vision: 'v', role: 'r', definition_of_done: 'd' },
	foundingTasks: [
		{ objective: 'a', purpose: 'pa' },
		{ objective: 'b', purpose: 'pb' },
		{ objective: 'c', purpose: 'pc' }
	],
	targetDrafts: [],
	capabilityNeeds: { languages: ['ts'], frameworks: [], defect_classes: [] },
	clarifiers: []
};

let tdb: TestDb;
let db: Db;
let hostProjectId: string;

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
	const p = await createProject(db, { slug: 'create_host', name: 'Create Host', root_path: 'F:/code/create-host' });
	hostProjectId = p.id;
	// no defect classes needed — RAW declares none (honest empty).
	void createRole;
	void createGauntletFixture;
	void createGauntletKey;
	void newSentinelUlid;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, hostProjectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

const BRIEF: CreateBrief = { name: 'thing', description: 'a small CLI' };

describe('makeProposalAgent — through a scripted launchSession (no spend)', () => {
	it('runs read-only, parses the emitted proposal, end-to-end into a confirmToken', async () => {
		const summary = '```json\n' + JSON.stringify(RAW) + '\n```';
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'thinking' },
			{ type: 'done', result: { ok: true, summary, ccSessionId: 'cc_prop_1' } }
		];
		const runtime = new ClaudeCodeRuntime({
			backend: scriptedBackend(events, 'cc_prop_1'),
			harnessConfigRoot: 'F:/code/create-host/.harness-cc'
		});
		const generate = makeProposalAgent({
			db,
			bus: new EventBus(),
			runtime,
			hostProjectId,
			agentId: 'agent_create_1',
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'haiku' }
		});
		const env = await generateCreationProposal(db, BRIEF, generate);
		expect(env.proposal.foundingTasks.length).toBe(3);
		expect(env.confirmToken).toMatch(/^[0-9a-f]{64}$/);
	});

	it('a failed session → ProposalContractError (never silence-as-success)', async () => {
		const events: RuntimeEvent[] = [{ type: 'error', error: 'env timeout' }];
		const runtime = new ClaudeCodeRuntime({
			backend: scriptedBackend(events, 'cc_prop_fail'),
			harnessConfigRoot: 'F:/code/create-host/.harness-cc'
		});
		const generate = makeProposalAgent({
			db,
			bus: new EventBus(),
			runtime,
			hostProjectId,
			agentId: 'agent_create_2',
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'haiku' }
		});
		await expect(generateCreationProposal(db, BRIEF, generate)).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
});
