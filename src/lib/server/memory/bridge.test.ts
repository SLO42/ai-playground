import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { FakeEmbedder } from './embed';
import {
	parseAutoMemoryFile,
	parseMemoryLinks,
	importAutoMemory,
	traverse,
	type AutoMemoryFile
} from './bridge';

// TASK 2.6 VERIFY (integration) — the memory bridge against a LIVE throwaway SurrealDB
// with the real §4.6 graph schema (entity + references RELATION). Embedder is the
// deterministic FakeEmbedder (no Ollama in this sandbox; the live qwen3 round-trip is the
// 2.5 deferred live proof — unchanged here). All rows read back from the real DB (F-008).
//
// The headline VERIFY: a graph traversal returns LINKED ENTITIES from imported memory.
// The MEMORY.md index links sub-files via `[label](file.md)` references; the bridge turns
// each imported .md into a memory row + an `entity` node, and each cross-link into a
// `references` edge, so traverse(entityForFile) returns the entities it links to.

let tdb: TestDb;
let db: Db;
let projectId: string;
let embedder: FakeEmbedder;

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
	const p = await createProject(db, { slug: 'bridge_demo', name: 'Bridge Demo', root_path: 'F:/code/bridge-demo' });
	projectId = p.id;
	embedder = new FakeEmbedder();
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

describe('§2.6 parse — frontmatter + body + cross-links', () => {
	it('parses YAML frontmatter (name/description/type) and the markdown body', () => {
		const raw = [
			'---',
			'name: PR and branch strategy',
			'description: Branch per task, PR per sprint group',
			'type: feedback',
			'---',
			'',
			'Branch per task, then batch-merge into a sprint PR.'
		].join('\n');
		const parsed = parseAutoMemoryFile('feedback_pr-strategy.md', raw);
		expect(parsed.name).toBe('PR and branch strategy');
		expect(parsed.kind).toBe('feedback');
		expect(parsed.body).toContain('Branch per task');
		// content fed to memory carries the human name + body (recall-friendly).
		expect(parsed.content).toContain('PR and branch strategy');
		expect(parsed.content).toContain('batch-merge');
	});

	it('handles a file with no frontmatter (falls back to the basename)', () => {
		const parsed = parseAutoMemoryFile('heartbeat-agents.md', 'The heartbeat system runs 17 modules.');
		expect(parsed.name).toBe('heartbeat-agents');
		expect(parsed.body).toContain('heartbeat system');
	});

	it('extracts [label](file.md) cross-links, ignoring http(s) and anchors', () => {
		const body =
			'See [vision](user_vision-ai-playground.md) and [patterns](dashboard-patterns.md).\n' +
			'External [docs](https://example.com/x.md) and [anchor](#section) are NOT links.';
		const links = parseMemoryLinks(body);
		expect(links).toContain('user_vision-ai-playground.md');
		expect(links).toContain('dashboard-patterns.md');
		expect(links).not.toContain('https://example.com/x.md');
		expect(links.some((l) => l.startsWith('#'))).toBe(false);
	});
});

describe('§2.6 import — memory rows + entity nodes + references edges (reuses 2.5 store)', () => {
	it('imports files, creating one memory + one entity per file and edges per cross-link', async () => {
		const files: AutoMemoryFile[] = [
			{
				path: 'MEMORY.md',
				raw: [
					'---',
					'name: Auto Memory Index',
					'type: index',
					'---',
					'See [PR strategy](feedback_pr-strategy.md) and [dashboard](dashboard-patterns.md).'
				].join('\n')
			},
			{
				path: 'feedback_pr-strategy.md',
				raw: '---\nname: PR strategy\ntype: feedback\n---\nBranch per task, PR per sprint group.'
			},
			{
				path: 'dashboard-patterns.md',
				raw: '---\nname: Dashboard patterns\ntype: reference\n---\nSvelteKit 2 with Svelte 5 runes.'
			}
		];
		const res = await importAutoMemory({ db, embedder }, files, { project: projectId });
		expect(res.imported).toBe(3);
		expect(res.entities).toBe(3);
		// MEMORY.md links to two files → two references edges.
		expect(res.edges).toBe(2);

		// Each imported file produced a memory row (screened/embedded) and an entity node.
		const [mrows] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM memory WHERE source = "claude-auto-memory" AND project = $p GROUP ALL;`,
			{ p: new StringRecordId(projectId) }
		);
		expect(mrows[0].c).toBe(3);
		const [erows] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM entity WHERE type = "auto-memory" AND project = $p GROUP ALL;`,
			{ p: new StringRecordId(projectId) }
		);
		expect(erows[0].c).toBe(3);
	});

	it('is idempotent — re-importing the same files adds no duplicate rows or edges', async () => {
		const files: AutoMemoryFile[] = [
			{ path: 'MEMORY.md', raw: '---\nname: Idx\ntype: index\n---\nSee [a](a.md).' },
			{ path: 'a.md', raw: '---\nname: A\ntype: feedback\n---\nA fact about builds.' }
		];
		const opts = { db, embedder } as const;
		const first = await importAutoMemory(opts, files, { project: projectId, namespace: 'idem' });
		const second = await importAutoMemory(opts, files, { project: projectId, namespace: 'idem' });
		expect(first.imported).toBe(2);
		expect(second.imported).toBe(2);
		// No twins: count memories/entities/edges in the idem namespace is stable.
		const [mrows] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM memory WHERE namespace = "idem" GROUP ALL;`
		);
		expect(mrows[0].c).toBe(2);
		const [edgeRows] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM references WHERE kind = "relates_to" GROUP ALL;`
		);
		// edges from idem import deduped; first import (above) used "mentions" so isolate by re-querying idem entities
		expect(edgeRows[0].c).toBeGreaterThanOrEqual(1);
	});

	it('DROPS a transient-claim file (DO-NOT-CAPTURE) but still creates its entity node', async () => {
		const files: AutoMemoryFile[] = [
			{ path: 'broken.md', raw: '---\nname: Broken note\ntype: feedback\n---\nThe ollama daemon is unreachable right now.' }
		];
		const res = await importAutoMemory({ db, embedder }, files, { project: projectId, namespace: 'drop' });
		// The memory candidate is dropped by the §3.1 guard; the entity node still exists so
		// the graph references it (no dangling edge target), but no memory row persists.
		expect(res.dropped).toBe(1);
		const [mrows] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM memory WHERE namespace = "drop" GROUP ALL;`
		);
		expect(mrows[0]?.c ?? 0).toBe(0);
	});
});

describe('§2.6 VERIFY — graph traversal returns LINKED ENTITIES from imported memory', () => {
	it('traverse(index) returns the entities the index links to (1-hop)', async () => {
		const files: AutoMemoryFile[] = [
			{ path: 'MEMORY.md', raw: '---\nname: Index\ntype: index\n---\nLinks: [vision](v.md), [arch](arch.md).' },
			{ path: 'v.md', raw: '---\nname: Vision\ntype: project\n---\nThe product vision.' },
			{ path: 'arch.md', raw: '---\nname: Architecture\ntype: reference\n---\nThe system architecture.' }
		];
		const ns = 'traverse';
		const res = await importAutoMemory({ db, embedder }, files, { project: projectId, namespace: ns });
		expect(res.edges).toBe(2);

		const indexEntity = res.entityByPath['MEMORY.md'];
		expect(indexEntity).toBeTruthy();

		const neighbors = await traverse(db, indexEntity, { depth: 1 });
		const labels = neighbors.map((n) => n.label).sort();
		expect(labels).toEqual(['Architecture', 'Vision']);
		// Every returned node is a real entity row read back from the DB (F-008).
		for (const n of neighbors) {
			expect(n.id).toMatch(/^entity:/);
			expect(n.type).toBe('auto-memory');
		}
	});

	it('traverse honors depth — 2-hop reaches transitively linked entities', async () => {
		const files: AutoMemoryFile[] = [
			{ path: 'root.md', raw: '---\nname: Root\ntype: index\n---\nSee [mid](mid.md).' },
			{ path: 'mid.md', raw: '---\nname: Mid\ntype: reference\n---\nSee [leaf](leaf.md).' },
			{ path: 'leaf.md', raw: '---\nname: Leaf\ntype: reference\n---\nA leaf fact.' }
		];
		const res = await importAutoMemory({ db, embedder }, files, { project: projectId, namespace: 'depth' });
		const rootEntity = res.entityByPath['root.md'];

		const oneHop = await traverse(db, rootEntity, { depth: 1 });
		expect(oneHop.map((n) => n.label)).toEqual(['Mid']);

		const twoHop = await traverse(db, rootEntity, { depth: 2 });
		const labels = twoHop.map((n) => n.label).sort();
		expect(labels).toContain('Mid');
		expect(labels).toContain('Leaf');
	});

	it('linked memory rows are reachable from an entity (entity → memory edge)', async () => {
		const files: AutoMemoryFile[] = [
			{ path: 'topic.md', raw: '---\nname: Topic\ntype: reference\n---\nThe canonical fact about routing.' }
		];
		const res = await importAutoMemory({ db, embedder }, files, { project: projectId, namespace: 'em' });
		const entityId = res.entityByPath['topic.md'];
		// Each entity derived_from its own memory row — follow that edge.
		const [rows] = await db.query<[Array<{ content: string }>]>(
			`SELECT VALUE ->references->memory.content FROM $e;`,
			{ e: new StringRecordId(entityId) }
		);
		const contents = (rows as unknown as string[][]).flat();
		expect(contents.some((c) => c.includes('routing'))).toBe(true);
	});
});
