import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import type { ProviderHealth } from '../providers/index';
import type { AgentPool } from '../config/load';
import type { Orchestration } from '../config/load';
import { classifyIntent, resolveRoute, writeRoutingEvent, scoreComplexity } from './resolve';

// TASK 2.3 VERIFY (ARCHITECTURE §2.5; D-020; DATA-MODEL §4.4; F-005) against the
// real throwaway test DB + a MOCKED provider-health source (NO live model spawn,
// NO creds, NO network — health is the only external input and it is injected):
//   • a task resolves through the FULL order
//     (explicit override → intent classify → tier → adaptive config → provider/health → fallback)
//   • the decision is persisted as a routing_event carrying reason (rationale) + intent
//   • an explicit override SHORT-CIRCUITS the order (method "explicit", no classify)
//   • a down provider triggers escalation/fallback (F-005)
// Every assertion reads back what the live DB persisted — no fake runtime data (F-008).

// ── Test config: the v1-shape pool + orchestration bundles (mirrors the fixtures). ──
const pool: AgentPool = {
	tiers: {
		local: { provider: 'ollama', model: 'gpt-oss:20b' },
		haiku: { provider: 'anthropic', model: 'claude-haiku' },
		sonnet: { provider: 'anthropic', model: 'claude-sonnet' },
		opus: { provider: 'anthropic', model: 'claude-opus' }
	},
	slots: [
		{ id: 'coder-1', tier: 'opus', role: 'coder' },
		{ id: 'tester-1', tier: 'sonnet', role: 'tester' },
		{ id: 'scout-1', tier: 'local', role: 'scout' }
	],
	escalation: { order: ['haiku', 'sonnet', 'opus'] },
	delegation: { from: 'opus', to: 'sonnet' }
};

const orch: Orchestration = {
	mode: 'event',
	concurrency: { maxAgents: 8, perProject: 3 },
	bundles: {
		'simple-question': { thinking: 'none', retrievalDepth: 0 },
		'code-read': { thinking: 'low', retrievalDepth: 3 },
		'code-write': { thinking: 'medium', retrievalDepth: 5 },
		'code-debug': { thinking: 'high', retrievalDepth: 8 },
		'deep-explore': { thinking: 'high', retrievalDepth: 12 }
	}
};

const allUp: ProviderHealth[] = [
	{ provider: 'ollama', up: true },
	{ provider: 'anthropic', up: true }
];

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
	const p = await createProject(db, {
		slug: 'routing',
		name: 'Routing Host',
		root_path: 'F:/code/routing'
	});
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('routing — intent classification (§2.5)', () => {
	it('maps task text to the five intents', () => {
		expect(classifyIntent({ title: 'What is the build command?', description: '' })).toBe(
			'simple-question'
		);
		expect(
			classifyIntent({ title: 'Read the auth module', description: 'understand how login works' })
		).toBe('code-read');
		expect(
			classifyIntent({ title: 'Implement the SSE endpoint', description: 'add a new route' })
		).toBe('code-write');
		expect(
			classifyIntent({ title: 'Fix the failing test', description: 'the bus double-fires, debug it' })
		).toBe('code-debug');
		expect(
			classifyIntent({
				title: 'Investigate the whole orchestration architecture',
				description: 'research and explore tradeoffs across the system'
			})
		).toBe('deep-explore');
	});

	it('complexity score rises with intent weight', () => {
		const simple = scoreComplexity('simple-question', { title: 'hi', description: '' });
		const debug = scoreComplexity('code-debug', { title: 'fix', description: 'x'.repeat(400) });
		expect(simple).toBeLessThan(debug);
		expect(simple).toBeGreaterThanOrEqual(0);
		expect(debug).toBeLessThanOrEqual(1);
	});
});

describe('routing — resolveRoute full order (§2.5 / F-005)', () => {
	it('resolves a task through classify → tier → adaptive config → health, and writes a routing_event', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'Fix the failing orchestrator test',
			description: 'the work_item claim double-fires — debug the race and repair it'
		});

		const plan = await resolveRoute({
			db,
			task: { id: t.id, project: projectId, title: t.title, description: t.description },
			pool,
			orchestration: orch,
			providerHealth: async () => allUp
		});

		// Order ran fully: a debug task classifies code-debug and tiers to a capable model.
		expect(plan.method).toBe('classify');
		expect(plan.intent).toBe('code-debug');
		expect(plan.model.provider).toBe('anthropic');
		expect(plan.model.tier).toBeTruthy();
		// Adaptive config (D-020) came from the code-debug bundle.
		expect(plan.budgets.thinking).toBe('high');
		expect(plan.adaptiveConfig.retrievalDepth).toBe(8);
		expect(plan.reason).toContain('code-debug');
		expect(typeof plan.complexity).toBe('number');

		// The decision was PERSISTED as a routing_event carrying rationale + intent.
		expect(plan.routingEventId).toMatch(/^routing_event:/);
		const ev = await getRoutingEvent(db, plan.routingEventId);
		expect(ev).toBeTruthy();
		expect(String(ev.task)).toBe(t.id);
		expect(String(ev.project)).toBe(projectId);
		expect(ev.method).toBe('classify');
		expect(ev.reason).toContain('code-debug'); // rationale carries the intent
		expect((ev.chosen as Record<string, unknown>).provider).toBe('anthropic');
		expect(ev.complexity).toBeTypeOf('number');
	});
});

describe('routing — explicit override short-circuits (F-005)', () => {
	it('an explicit model override wins and skips classification', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'Fix the failing orchestrator test again',
			description: 'this would classify as code-debug, but the override must win'
		});

		const plan = await resolveRoute({
			db,
			task: { id: t.id, project: projectId, title: t.title, description: t.description },
			pool,
			orchestration: orch,
			providerHealth: async () => allUp,
			override: { provider: 'ollama', modelId: 'gpt-oss:20b', tier: 'local' }
		});

		expect(plan.method).toBe('explicit'); // SHORT-CIRCUIT — no classify
		expect(plan.model.provider).toBe('ollama');
		expect(plan.model.modelId).toBe('gpt-oss:20b');
		expect(plan.reason.toLowerCase()).toContain('override');

		const ev = await getRoutingEvent(db, plan.routingEventId);
		expect(ev.method).toBe('explicit');
		expect((ev.chosen as Record<string, unknown>).provider).toBe('ollama');
	});
});

describe('routing — provider/health fallback (F-005)', () => {
	it('escalates past a down provider and records the fallback method', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'Simple question about config',
			description: 'what mode is the orchestrator in?'
		});

		// anthropic is DOWN — a simple-question would tier to local(ollama) anyway, so
		// force the opposite: ollama down, so the only-capable provider is anthropic.
		const plan = await resolveRoute({
			db,
			task: { id: t.id, project: projectId, title: t.title, description: t.description },
			pool,
			orchestration: orch,
			providerHealth: async () => [
				{ provider: 'ollama', up: false, detail: 'unreachable' },
				{ provider: 'anthropic', up: true }
			]
		});

		// The cheapest tier (local/ollama) is unhealthy → fell back to a healthy tier.
		expect(plan.method).toBe('fallback');
		expect(plan.model.provider).toBe('anthropic');
		expect(plan.reason.toLowerCase()).toContain('fallback');

		const ev = await getRoutingEvent(db, plan.routingEventId);
		expect(ev.method).toBe('fallback');
	});

	it('writeRoutingEvent persists a standalone decision with rationale + intent', async () => {
		const id = await writeRoutingEvent(db, {
			task: undefined,
			project: projectId,
			chosen: { provider: 'anthropic', modelId: 'claude-sonnet', tier: 'sonnet' },
			method: 'tier',
			reason: 'tiered to sonnet for code-write',
			intent: 'code-write',
			complexity: 0.5,
			alternatives: [{ tier: 'haiku', reason: 'too weak' }]
		});
		expect(id).toMatch(/^routing_event:/);
		const ev = await getRoutingEvent(db, id);
		expect(ev.method).toBe('tier');
		expect(ev.reason).toContain('code-write');
		expect(String(ev.project)).toBe(projectId);
		expect(ev.task ?? null).toBeNull(); // option<> omitted, not NULL (§6.1)
	});
});

// ── WORKFORCE-SPEC §7 — staffing short-circuit (BL-3) ──────────────────────────────
//
// resolveStaff output passes into resolveRoute as the §7 explicit-staffed decision: a role-bound
// session routes to its staffed model (method:'explicit', the chain rationale), staffing IS the
// decision. The seam is ADDITIVE + FAIL-CLOSED: no role / null resolution → the route is
// byte-identical to pre-wiring. The resolver is a deterministic stub here (the staff.ts unit/
// integration tests cover the real resolveStaff; this proves the ROUTING wiring).
describe('routing — §7 staffing short-circuit (additive, fail-closed)', () => {
	const STAFFED = {
		version: 'role_version:v_staff_1',
		provider: 'anthropic',
		modelId: 'claude-opus',
		tier: 'opus',
		certifiedBy: 'interview_run:run_staff_1',
		staffId: 'project_staff:ps_staff_1'
	};

	it('a staffed role-bound session routes method:explicit at the staffed model, citing the §7 chain', async () => {
		const t = await createTask(db, {
			project: projectId,
			// A title that would normally classify simple/cheap — proving staffing OVERRIDES the classifier.
			title: 'What is the status?',
			description: ''
		});
		const plan = await resolveRoute({
			db,
			task: { id: t.id, project: projectId, title: t.title, description: t.description, role: 'role:security_officer' },
			pool,
			orchestration: orch,
			providerHealth: async () => allUp,
			staffResolver: async () => STAFFED
		});
		expect(plan.method).toBe('explicit');
		expect(plan.model.provider).toBe('anthropic');
		expect(plan.model.modelId).toBe('claude-opus'); // the STAFFED model, not the classifier's cheap tier
		expect(plan.model.tier).toBe('opus');
		expect(plan.complexity).toBeUndefined(); // staffing skips complexity scoring
		// The §7 chain is in the rationale (operator how/why).
		expect(plan.reason).toContain(STAFFED.staffId);
		expect(plan.reason).toContain(STAFFED.version);
		expect(plan.reason).toContain(STAFFED.certifiedBy);
		const ev = await getRoutingEvent(db, plan.routingEventId);
		expect(ev.method).toBe('explicit');
		expect((ev.chosen as Record<string, unknown>).model_id).toBe('claude-opus');
	});

	it('an UNSTAFFED role (resolver → null) falls through to the normal order — byte-identical to no seam', async () => {
		const task = { project: projectId, title: 'Investigate and evaluate the whole system architecture and its tradeoffs', description: 'deep dive' };
		const t = await createTask(db, task);
		const view = { id: t.id, project: projectId, title: t.title, description: t.description };

		// WITHOUT a staffResolver (pre-wiring behavior):
		const baseline = await resolveRoute({ db, task: view, pool, orchestration: orch, providerHealth: async () => allUp });
		// WITH a staffResolver that returns null for this (unstaffed) role:
		const withSeam = await resolveRoute({
			db,
			task: { ...view, role: 'role:not_staffed' },
			pool,
			orchestration: orch,
			providerHealth: async () => allUp,
			staffResolver: async () => null
		});
		// Byte-identical decision (the seam was inert): same method, intent, model, complexity.
		expect(withSeam.method).toBe(baseline.method);
		expect(withSeam.intent).toBe(baseline.intent);
		expect(withSeam.model.tier).toBe(baseline.model.tier);
		expect(withSeam.model.modelId).toBe(baseline.model.modelId);
		expect(withSeam.complexity).toBe(baseline.complexity);
	});

	it('a task with NO role never consults the resolver (additive)', async () => {
		let consulted = false;
		const t = await createTask(db, { project: projectId, title: 'Implement the feature', description: 'add the endpoint' });
		const plan = await resolveRoute({
			db,
			task: { id: t.id, project: projectId, title: t.title, description: t.description }, // no role
			pool,
			orchestration: orch,
			providerHealth: async () => allUp,
			staffResolver: async () => { consulted = true; return STAFFED; }
		});
		expect(consulted).toBe(false); // the seam is gated on task.role
		expect(plan.method).not.toBe('explicit');
	});

	it('an explicit operator override STILL wins over staffing (F-005 precedence)', async () => {
		const t = await createTask(db, { project: projectId, title: 'Anything', description: '' });
		const plan = await resolveRoute({
			db,
			task: { id: t.id, project: projectId, title: t.title, description: t.description, role: 'role:security_officer' },
			pool,
			orchestration: orch,
			providerHealth: async () => allUp,
			override: { provider: 'ollama', modelId: 'gpt-oss:20b', tier: 'local' },
			staffResolver: async () => STAFFED
		});
		// The operator's explicit pick wins; staffing is the DEFAULT for a role session, not an
		// override of an explicit operator choice.
		expect(plan.model.provider).toBe('ollama');
		expect(plan.reason.toLowerCase()).toContain('override');
	});
});

// ── helper: read a routing_event back by id ─────────────────────────────────────
async function getRoutingEvent(db: Db, id: string): Promise<Record<string, unknown>> {
	const { StringRecordId } = await import('surrealdb');
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
		rid: new StringRecordId(id)
	});
	return rows[0];
}
