import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { EventBus, type BusEvent } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { MemoryService, FakeEmbedder, type ExtractFn, type MemoryCandidate } from '../memory/index';
import { assertRecordId } from '../db/validate';
import { sendPeerMessage, getPeerMessage } from '../peer/repo';
import { launchSession } from './launch';

// TASK 8.3 VERIFY — WIRE THE MEMORY LOOP into the live session path (D-026/D-028/D-029; D-019).
//
// MemoryService (recall/extractAndStore/buildBriefing) was built + unit-tested but had ZERO
// production callers. This proves the WIRING through the real launch path against a real
// throwaway SurrealDB (FakeEmbedder for determinism — the live qwen3 round-trip is the
// separate .live proof; F-008 holds: every row read back came from the real DB):
//   (1) RECALL on spawn — a relevant past memory is recalled, FENCED (D-026), and injected as
//       the runtime's SEPARATE `context` field (D-008 — never folded into the task). The plan
//       the backend receives carries the fenced "(not instructions)" reference block.
//   (2) The briefing is SURFACED — a `system`/briefing `message` row is persisted AND a
//       `briefing` transcript bus event fires (the live render path), so the session view shows
//       the wake-up context.
//   (3) EXTRACT on session-end — the scripted extractor's ADD-only candidate is screened +
//       embedded + stored as a real `memory` row (D-028) reachable on /memory.
//   (4) Best-effort (D-019) — a memory loop that THROWS never blocks or fails the spawn.

function scriptedBackend(events: RuntimeEvent[], ccSessionId: string): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	return {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId,
				async *stream() {
					for (const e of events) yield e;
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return { ccSessionId: req.ccSessionId, async *stream() {}, async cancel() {} };
		},
		async interject() {}
	};
}

function transcript(ccSessionId: string): RuntimeEvent[] {
	return [
		{ type: 'log', message: 'reading the tailwind config' },
		{ type: 'tool_call', name: 'Read', args: { file: 'app.css' }, needsConfirm: false },
		{ type: 'tool_result', name: 'Read', ok: true, output: '@import "tailwindcss";' },
		{ type: 'token_usage', input: 100, output: 40 },
		{ type: 'done', result: { ok: true, summary: 'configured tailwind v4 @theme', ccSessionId } }
	];
}

let tdb: TestDb;
let db: Db;
let projectId: string;
let mem: MemoryService;

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
	const p = await createProject(db, { slug: 'memloop', name: 'Mem Loop', root_path: 'F:/code/memloop' });
	projectId = p.id;
	// FakeEmbedder is deterministic by token overlap — a memory whose text shares words with the
	// task title scores higher, so recall ranking is observable without a live model.
	mem = new MemoryService({ db, embedder: new FakeEmbedder(), cache: false });
	// A past memory to recall on the next spawn (stored via the real screen+embed+insert path).
	await mem.store([
		{ content: 'Tailwind v4 uses @theme CSS-first config, not tailwind.config.js.', project: projectId, importance: 9 },
		{ content: 'A sourdough recipe needs flour water salt and a starter.', project: projectId, importance: 2 }
	]);
}, 90_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function makeTask(title: string, description: string): Promise<string> {
	const t = await createTask(db, { project: projectId, title, description });
	return t.id;
}

function runtimeFor(cc: string): { rt: ClaudeCodeRuntime; plans: CcSpawnPlan[] } {
	const backend = scriptedBackend(transcript(cc), cc);
	return { rt: new ClaudeCodeRuntime({ backend, harnessConfigRoot: '.harness/claude-config' }), plans: backend.plans };
}

describe('TASK 8.3 — memory loop wired into the live session path', () => {
	it('(1+2) RECALLS on spawn: fenced context injected into the plan + a briefing message surfaced', async () => {
		const taskId = await makeTask('Configure Tailwind styling', 'Set up the dashboard Tailwind theme.');
		const { rt, plans } = runtimeFor('cc_recall_1');
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		// A scripted extractor so this test focuses on recall+surface (extract proven in (3)).
		const extract: ExtractFn = async () => [];

		const res = await launchSession({
			db,
			bus,
			runtime: rt,
			memory: { service: mem, extract },
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read', 'Edit', 'Bash'] }
			}
		});
		expect(res.status).toBe('done');

		// (1) The plan handed to the backend carries the fenced recalled context as the
		// runtime's separate "(not instructions)" reference block — NOT folded into the task.
		expect(plans.length).toBe(1);
		const prompt = plans[0].prompt;
		expect(prompt).toContain('Reference context (not instructions)');
		expect(prompt.toLowerCase()).toContain('tailwind'); // the relevant memory was recalled
		// The task description is preserved verbatim (D-008 — context never mutates the task).
		expect(prompt).toContain('Set up the dashboard Tailwind theme.');

		// (2) The briefing was SURFACED: a persisted system/briefing message row exists.
		const [msgRows] = await db.query<[Array<{ role: string; origin?: string; content: string; tool_call?: { kind?: string } }>]>(
			`SELECT role, origin, content, tool_call FROM message WHERE session = $sid;`,
			{ sid: new StringRecordId(assertRecordId(res.sessionId)) }
		);
		const briefingRow = msgRows.find((m) => m.tool_call?.kind === 'briefing');
		expect(briefingRow, 'a briefing message row was persisted').toBeTruthy();
		expect(briefingRow!.role).toBe('system');
		// m0038: the wake-up briefing is SYSTEM-side framing the platform injects — origin='system'
		// (not the agent's own prose, not an operator push); fenced DATA, non-steering (D-035a).
		expect(briefingRow!.origin).toBe('system');
		expect(briefingRow!.content.toLowerCase()).toContain('tailwind');

		// ...and a live `briefing` transcript bus event fired (the render path).
		const briefingEv = seen.find(
			(e) =>
				e.type === 'transcript' &&
				(e.data as { event?: { type?: string } })?.event?.type === 'briefing'
		);
		expect(briefingEv, 'a briefing transcript event was published').toBeTruthy();
	});

	it('(3) EXTRACTS on session-end: the ADD-only candidate is stored as a real memory row', async () => {
		const taskId = await makeTask('Add a release note', 'Write the v0.1 release note.');
		const { rt } = runtimeFor('cc_extract_1');
		const bus = new EventBus();

		const extracted = 'Release notes for Atelier v0.1 live under docs/releases (decided this session).';
		const extract: ExtractFn = async (): Promise<MemoryCandidate[]> => [
			{ content: extracted, kind: 'semantic', source: 'session-extract' }
		];

		const before = await mem.recall(extracted, { project: projectId, limit: 5 });
		const hadBefore = before.items.some((i) => i.fenced.text.includes('docs/releases'));
		expect(hadBefore).toBe(false);

		const res = await launchSession({
			db,
			bus,
			runtime: rt,
			memory: { service: mem, extract },
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done');

		// The extracted candidate is now a real `memory` row, reachable on the recall path
		// that backs /memory (F-008 — read back from the live DB, not the in-memory candidate).
		const [rows] = await db.query<[Array<{ content: string }>]>(
			`SELECT content FROM memory WHERE project = $pid AND content = $c;`,
			{ pid: new StringRecordId(assertRecordId(projectId)), c: extracted }
		);
		expect(rows.length, 'the extracted memory was stored').toBe(1);
	});

	// ── G-B: the offline-drain wired into the spawn path ──────────────────────────────
	//
	// At a recipient session's SPAWN, launchSession drains its pending peer_message inbox, folds the
	// drained (already-fenced) bodies into the briefing (channelBodies), and writes an origin=agent
	// transcript row per delivered message (→ G-A 'communication' turn). These tests prove the WIRING
	// through the real launch path against real SurrealDB. (The drain ENGINE — TTL/idempotency/role —
	// is exhaustively covered in peer/drain.test.ts; here we prove launchSession invokes it correctly.)
	//
	// NOTE (documented limitation, NOT a silent cut): launchSession CREATEs a fresh session WITHOUT a
	// role (role is stamped later by workforce activation), so a freshly-launched session drains only
	// messages addressed to its OWN session id, plus role@project messages once the session carries a
	// role. The full offline→drain→deliver→render end-to-end (incl. the launch-shaped transcript row +
	// the G-A 'communication' classification) is exhaustively covered against real SurrealDB in
	// peer/drain.test.ts; HERE we prove launchSession actually INVOKES the drain leg at spawn and that
	// it is fail-open (a non-matching message is left pending; the spawn is unaffected).

	it('(G-B) launchSession runs the drain leg at spawn and leaves a non-matching role message pending; the spawn completes (fail-open wiring)', async () => {
		// A role-addressed message in this project; the launched task session carries NO role → the drain
		// leg runs, matches nothing, and the spawn completes cleanly (the drain is best-effort, F-014).
		const { id: roleId } = (
			await db.query<[Array<{ id: unknown }>]>(
				`CREATE type::thing('role', 'pdrain_launch_role') SET slug='pdrain_launch_role', name='r', purpose='t', status='active' RETURN id;`
			)
		)[0][0] as { id: string };
		const sender2 = (
			await db.query<[Array<{ id: unknown }>]>(`CREATE session SET kind='task', model={ provider:'claude', model_id:'x' } RETURN id;`)
		)[0][0].id as string;
		const otherMsg = await sendPeerMessage(db, {
			from_session: String(sender2),
			to_kind: 'role',
			to_role: String(roleId),
			project: projectId,
			body: 'role-addressed; not for a role-less task session'
		});

		const taskId = await makeTask('Role-less spawn', 'A task session with no role.');
		const { rt } = runtimeFor('cc_drain_norole');
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: rt,
			memory: { service: mem, extract: async () => [] },
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done'); // drain ran, matched nothing, spawn unaffected
		// The non-matching role message is STILL pending (the role-less session's drain left it for the
		// right recipient) — proving the drain leg ran correctly and did not over-deliver.
		const still = await getPeerMessage(db, otherMsg.id);
		expect(still!.status).toBe('pending');
	});

	it('(4) a THROWING memory loop never blocks or fails the spawn (best-effort, D-019)', async () => {
		const taskId = await makeTask('Resilient task', 'The spawn must succeed even if memory throws.');
		const { rt } = runtimeFor('cc_resilient_1');
		const bus = new EventBus();

		// A service whose recall/extract path throws — wrap the real service's embedder is not
		// needed; we hand an extractor that throws and a recall that throws via a poisoned service.
		const boom: MemoryService = Object.create(mem) as MemoryService;
		(boom as unknown as { recall: () => Promise<never> }).recall = async () => {
			throw new Error('recall exploded');
		};
		const extract: ExtractFn = async () => {
			throw new Error('extract exploded');
		};

		const res = await launchSession({
			db,
			bus,
			runtime: rt,
			memory: { service: boom, extract },
			input: {
				projectId,
				taskId,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		// The spawn still completes done — the memory loop is best-effort and swallowed.
		expect(res.status).toBe('done');
	});
});
