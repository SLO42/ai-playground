import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { EventBus } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { MemoryService, OllamaEmbedder, type ExtractFn } from '../memory/index';
import { assertRecordId } from '../db/validate';
import { launchSession } from './launch';

// LIVE PROOF 8.3 — the memory loop driven by REAL Ollama embeddings (qwen3-embedding:0.6b,
// 1024-dim), not the FakeEmbedder. memory-loop.test.ts proves the WIRING with FakeEmbedder;
// THIS proves the same recall→inject + extract→store holds over real vectors + the real
// SurrealDB HNSW index. SKIP-WHEN-DOWN: a live proof — self-skips if Ollama is unreachable,
// never fabricating a vector (F-008). The extractor is still scripted (the extraction MODEL is
// a separate concern; the wiring proves the screened+embedded STORE lands a real row).

const OLLAMA = process.env.OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';
const MODEL = 'qwen3-embedding:0.6b';

async function ollamaUp(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
		if (!res.ok) return false;
		const j = (await res.json()) as { models?: { name?: string }[] };
		return (j.models ?? []).some((m) => m.name === MODEL);
	} catch {
		return false;
	}
}

function scriptedBackend(events: RuntimeEvent[], cc: string): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	return {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: cc,
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

const STREAM = (cc: string): RuntimeEvent[] => [
	{ type: 'log', message: 'working on the tailwind theme' },
	{ type: 'token_usage', input: 50, output: 20 },
	{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: cc } }
];

let live = false;
let tdb: TestDb;
let db: Db;
let projectId: string;
let mem: MemoryService;

beforeAll(async () => {
	live = await ollamaUp();
	if (!live) return;
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	const p = await createProject(db, { slug: 'memlive', name: 'Mem Live', root_path: 'F:/code/memlive' });
	projectId = p.id;
	mem = new MemoryService({ db, embedder: new OllamaEmbedder({ endpoint: OLLAMA, model: MODEL }), cache: false });
	await mem.store([
		{ content: 'Tailwind v4 uses @theme CSS-first config, not tailwind.config.js.', project: projectId, importance: 9 },
		{ content: 'A sourdough recipe needs flour water salt and a starter.', project: projectId, importance: 2 }
	]);
}, 120_000);

afterAll(async () => {
	if (!live) return;
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('LIVE PROOF 8.3 — memory loop over real qwen3 embeddings', () => {
	it('recalls the relevant memory into the plan + extracts a real memory on session-end', async () => {
		if (!live) return expect(live, 'Ollama unreachable — live proof deferred').toBe(false);
		const t = await createTask(db, {
			project: projectId,
			title: 'Configure Tailwind styling',
			description: 'Set up the dashboard Tailwind theme.'
		});
		const cc = 'cc_live_83';
		const backend = scriptedBackend(STREAM(cc), cc);
		const rt = new ClaudeCodeRuntime({ backend, harnessConfigRoot: '.harness/claude-config' });
		const extracted = 'Decided this session: the dashboard uses Tailwind v4 @theme tokens.';
		const extract: ExtractFn = async () => [{ content: extracted, kind: 'semantic', source: 'session-extract' }];

		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: rt,
			memory: { service: mem, extract },
			// WI-2: this live proof targets memory recall/extract with a scripted backend (no real
			// cwd); a fake worktree acquirer keeps the code-write spawn off the git fail-closed path.
			acquireWorktree: async (root, sid) => ({
				cwd: `${root}/.wt/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
				branch: `atelier/session/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
				cleanup: async () => {}
			}),
			input: {
				projectId,
				taskId: t.id,
				agentId: 'opus-1',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(res.status).toBe('done');

		// RECALL: the real-vector recall put the Tailwind memory into the fenced reference block.
		const prompt = backend.plans[0].prompt;
		expect(prompt).toContain('Reference context (not instructions)');
		expect(prompt.toLowerCase()).toContain('tailwind');

		// EXTRACT: the screened+embedded candidate landed as a real memory row.
		const [rows] = await db.query<[Array<{ content: string }>]>(
			`SELECT content FROM memory WHERE project = $pid AND content = $c;`,
			{ pid: new StringRecordId(assertRecordId(projectId)), c: extracted }
		);
		expect(rows.length).toBe(1);
	}, 120_000);
});
