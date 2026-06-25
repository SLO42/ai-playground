import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { EventBus } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent,
	type ModelSelection
} from '../runtime/index';
import { listSkillProposals } from './proposal';
import { launchSession } from '../sessions/launch';
import {
	makeSkillHarvestAgent,
	parseHarvestOutput,
	buildHarvestPrompt,
	SkillHarvestContractError
} from './harvest-agent';

// SH-2 GO-LIVE VERIFY (SKILL-HARVEST-SPEC §"CAPTURE") — the PRODUCTION skill-harvest generator.
//
// parseHarvestOutput (pure, the trust boundary): a fenced ```json draft parses to a ProposeSkillInput;
// the DECLINE shapes ({harvest:false}/{skill:null}/empty) return null (F-008 — never fabricate); the
// four shadow paths (nil/empty text, no JSON block, malformed JSON, missing/over-bound field) each
// throw a NAMED SkillHarvestContractError.
//
// makeSkillHarvestAgent (integration, scripted runtime — NO creds/network/spend): the production
// generator runs a read-only launchSession and parses its summary; a 'done' session with a fenced
// draft yields the draft, a non-'done' session throws (named) — and CRUCIALLY, fed through the LIVE
// SH-2 seam in launchSession on a successful code-write session, it drafts a BORN-'open' proposal in
// the SH-1 store (the dormant capture loop is now wired end-to-end). A throwing generator does NOT
// fail the session (best-effort, D-019).

const MODEL: ModelSelection = { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' };

/** A scripted backend that emits a fixed transcript ending in a `done` carrying `summary`. */
function scriptedBackend(
	events: RuntimeEvent[],
	ccSessionId = `cc_harv_${Math.random().toString(36).slice(2, 10)}`
): CcBackend {
	return {
		kind: 'mock',
		run(_plan: CcSpawnPlan): CcBackendRun {
			void _plan;
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

/** A transcript that ends 'done' carrying the given summary text (the harvest output channel). */
function transcriptWithSummary(summary: string, ok = true): RuntimeEvent[] {
	const cc = `cc_harv_${Math.random().toString(36).slice(2, 10)}`;
	return [
		{ type: 'log', message: 'reviewing trajectory' },
		{ type: 'token_usage', input: 100, output: 40 },
		{ type: 'done', result: { ok, summary, ccSessionId: cc } }
	];
}

let tdb: TestDb;
let db: Db;
let projectId: string;

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
	const p = await createProject(db, { slug: 'harvest_agent_proj', name: 'harvest-agent-proj', root_path: 'F:/code/harv' });
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

afterEach(async () => {
	await db.query('DELETE skill_proposal;').catch(() => {});
});

// ── parseHarvestOutput — the trust boundary (pure) ──────────────────────────────────────────────────

describe('parseHarvestOutput — happy draft', () => {
	it('parses a fenced ```json draft into a ProposeSkillInput', () => {
		const out = parseHarvestOutput(
			'Here is the skill:\n```json\n' +
				JSON.stringify({
					harvest: true,
					skill: {
						name: 'retry-flaky-network-call',
						description: 'Retry a flaky network call with backoff',
						body: '# Retry\nWrap the call in a bounded retry loop.',
						trigger_context: 'when a network call intermittently times out',
						evidence: ['src/net/client.ts', 'transcript:turn-4']
					}
				}) +
				'\n```'
		);
		expect(out).not.toBeNull();
		expect(out?.name).toBe('retry-flaky-network-call');
		expect(out?.evidence).toEqual(['src/net/client.ts', 'transcript:turn-4']);
		// session/project are NOT forged by the generator (launch.ts stamps them server-side).
		expect(out?.session).toBeUndefined();
		expect(out?.project).toBeUndefined();
	});

	it('accepts a bare skill object (no wrapper envelope — lenient)', () => {
		const out = parseHarvestOutput(
			'```json\n' +
				JSON.stringify({
					name: 'bare-skill',
					description: 'd',
					body: 'b',
					trigger_context: 't'
				}) +
				'\n```'
		);
		expect(out?.name).toBe('bare-skill');
		expect(out?.evidence).toBeUndefined();
	});

	it('parses with the no-fence outermost-braces fallback', () => {
		const out = parseHarvestOutput(
			'no fence here {"harvest":true,"skill":{"name":"fallback-skill","description":"d","body":"b","trigger_context":"t"}} trailing'
		);
		expect(out?.name).toBe('fallback-skill');
	});
});

describe('parseHarvestOutput — decline shapes (honest empty, F-008 — NOT an error)', () => {
	it('{ harvest:false } → null', () => {
		expect(parseHarvestOutput('```json\n{"harvest":false}\n```')).toBeNull();
	});
	it('{ skill:null } → null', () => {
		expect(parseHarvestOutput('```json\n{"skill":null}\n```')).toBeNull();
	});
	it('empty object {} → null (no skill fields)', () => {
		expect(parseHarvestOutput('```json\n{}\n```')).toBeNull();
	});
	it('JSON null → null', () => {
		expect(parseHarvestOutput('```json\nnull\n```')).toBeNull();
	});
});

describe('parseHarvestOutput — shadow paths each throw a NAMED error', () => {
	it('nil text → SkillHarvestContractError (EMPTY)', () => {
		expect(() => parseHarvestOutput(null)).toThrow(SkillHarvestContractError);
		expect(() => parseHarvestOutput(undefined)).toThrow(/EMPTY/);
	});
	it('empty/whitespace text → SkillHarvestContractError (EMPTY)', () => {
		expect(() => parseHarvestOutput('   ')).toThrow(/EMPTY/);
	});
	it('no JSON block at all → SkillHarvestContractError (no JSON block)', () => {
		expect(() => parseHarvestOutput('just prose, no braces')).toThrow(/no JSON block/);
	});
	it('malformed JSON in the fence → SkillHarvestContractError (did not parse)', () => {
		expect(() => parseHarvestOutput('```json\n{ not valid json,, }\n```')).toThrow(/did not parse/);
	});
	it('a draft missing a required field → named throw', () => {
		expect(() =>
			parseHarvestOutput('```json\n{"harvest":true,"skill":{"name":"x","description":"d","body":"b"}}\n```')
		).toThrow(/trigger_context/);
	});
	it('a blank required field → named throw', () => {
		expect(() =>
			parseHarvestOutput(
				'```json\n{"harvest":true,"skill":{"name":"x","description":"  ","body":"b","trigger_context":"t"}}\n```'
			)
		).toThrow(/description/);
	});
	it('evidence not an array → named throw', () => {
		expect(() =>
			parseHarvestOutput(
				'```json\n{"skill":{"name":"x","description":"d","body":"b","trigger_context":"t","evidence":"oops"}}\n```'
			)
		).toThrow(/evidence.*array/);
	});
	it('evidence over the cap → named throw', () => {
		const tooMany = Array.from({ length: 40 }, (_, i) => `ref-${i}`);
		expect(() =>
			parseHarvestOutput(
				'```json\n' +
					JSON.stringify({ skill: { name: 'x', description: 'd', body: 'b', trigger_context: 't', evidence: tooMany } }) +
					'\n```'
			)
		).toThrow(/exceeds/);
	});
});

describe('buildHarvestPrompt — pure, grounds in the screened ctx', () => {
	it('embeds the task title + the trajectory and instructs decline-by-default', () => {
		const prompt = buildHarvestPrompt({
			transcriptText: 'TRAJECTORY-MARKER',
			sessionId: 'session:abc',
			projectId: 'project:xyz',
			taskTitle: 'TASK-MARKER'
		});
		expect(prompt.title).toContain('TASK-MARKER');
		expect(prompt.description).toContain('TRAJECTORY-MARKER');
		expect(prompt.description).toContain('"harvest": false'); // the decline convention is taught
		expect(prompt.description).toMatch(/DECLINE/);
	});
});

// ── makeSkillHarvestAgent — production generator over a scripted runtime (NO spend) ──────────────────

describe('makeSkillHarvestAgent — runs a read-only session + parses its summary', () => {
	it('a done session whose summary carries a fenced draft → the parsed draft', async () => {
		const draftSummary =
			'```json\n' +
			JSON.stringify({
				harvest: true,
				skill: { name: 'prod-harvested', description: 'd', body: '# body', trigger_context: 'when X' }
			}) +
			'\n```';
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(transcriptWithSummary(draftSummary)) });
		const harvester = makeSkillHarvestAgent({ db, bus: new EventBus(), runtime, agentId: 'opus-1', model: MODEL });
		const draft = await harvester.propose({
			transcriptText: 'screened trajectory',
			sessionId: 'session:s1',
			projectId,
			taskTitle: 'do the reusable thing'
		});
		expect(draft?.name).toBe('prod-harvested');
	});

	it('a done session that DECLINES → null (honest, no draft)', async () => {
		const runtime = new ClaudeCodeRuntime({
			backend: scriptedBackend(transcriptWithSummary('```json\n{"harvest":false}\n```'))
		});
		const harvester = makeSkillHarvestAgent({ db, bus: new EventBus(), runtime, agentId: 'opus-1', model: MODEL });
		const draft = await harvester.propose({
			transcriptText: 't',
			sessionId: 'session:s2',
			projectId,
			taskTitle: 'one-off fix'
		});
		expect(draft).toBeNull();
	});

	it('a NON-done session throws a NAMED SkillHarvestContractError (subprocess discipline — never phantom success)', async () => {
		const runtime = new ClaudeCodeRuntime({
			backend: scriptedBackend(transcriptWithSummary('partial', /* ok */ false))
		});
		const harvester = makeSkillHarvestAgent({ db, bus: new EventBus(), runtime, agentId: 'opus-1', model: MODEL });
		await expect(
			harvester.propose({ transcriptText: 't', sessionId: 'session:s3', projectId, taskTitle: 'x' })
		).rejects.toThrow(SkillHarvestContractError);
	});
});

// ── End-to-end through the LIVE SH-2 seam (the capture loop, wired) ──────────────────────────────────

describe('SH-2 capture loop wired — the production generator drafts via the live seam', () => {
	it('a successful code-write session feeds the generator → a BORN-open proposal in the SH-1 store', async () => {
		// The harvest GENERATOR runs its own read-only session via THIS runtime too; its `done` summary is
		// the SAME scripted draft (the backend replays the fixed transcript for every run). So the
		// driving code-write session ends 'done', the SH-2 seam invokes the generator, the generator's
		// inner session also ends 'done' with the draft summary → proposeSkill persists it born 'open'.
		const name = `e2e-harvest-${Math.random().toString(36).slice(2, 8)}`;
		const draftSummary =
			'```json\n' +
			JSON.stringify({
				harvest: true,
				skill: { name, description: 'reusable', body: '# steps', trigger_context: 'when the e2e thing' }
			}) +
			'\n```';
		// The DRIVING code-write session and the harvester's INNER read-only session are DISTINCT real
		// sessions — give each its own scripted backend so their cc_session_ids don't collide on the
		// session_dedup UNIQUE index (a test-harness artifact; in production every session has a unique id).
		const driverRuntime = new ClaudeCodeRuntime({
			backend: scriptedBackend(transcriptWithSummary('driver done'), `cc_driver_${Math.random().toString(36).slice(2, 10)}`)
		});
		const harvesterRuntime = new ClaudeCodeRuntime({
			backend: scriptedBackend(transcriptWithSummary(draftSummary), `cc_harv_${Math.random().toString(36).slice(2, 10)}`)
		});
		const harvester = makeSkillHarvestAgent({ db, bus: new EventBus(), runtime: harvesterRuntime, agentId: 'opus-1', model: MODEL });

		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: driverRuntime,
			input: {
				projectId,
				promptTask: { id: 'driver_task', title: 'build the reusable thing', description: 'do it' },
				agentId: 'opus-1',
				model: MODEL,
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 10, concurrency: 1 },
				toolPolicy: { allow: ['Read', 'Edit', 'Bash'] }
			},
			// point the WRITE session's cwd at the project root (no real git repo needed for the test).
			acquireWorktree: async (root) => ({ cwd: root, branch: 'harv-e2e', cleanup: async () => {} }),
			skillHarvester: harvester
		});
		expect(res.status).toBe('done');

		const open = await listSkillProposals(db, { status: 'open' });
		const mine = open.find((p) => p.name === name);
		expect(mine).toBeDefined();
		expect(mine?.status).toBe('open');
		// provenance stamped server-side (the generator never forged it).
		expect(mine?.session).toBe(res.sessionId);
		expect(mine?.project).toBe(projectId);
	}, 60_000);
});
