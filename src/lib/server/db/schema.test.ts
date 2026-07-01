import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from './client';
import { runMigrations, type Migration } from './migrate';
import { schemaMigrations } from './schema';
import { startTestDb, fixtureVector, type TestDb } from './testserver';

// TASK 0.c VERIFY: the full DATA-MODEL schema applies to a throwaway test DB
// (namespace dropped per run). The migration test asserts EVERY table + index
// from DATA-MODEL.md §4 exists, that all HNSW indexes are 2.x-valid (no "M0"),
// and that a memory CRUD + KNN round-trip works against the live index.

let tdb: TestDb;
let root: Db;

// INFO FOR DB returns { tables: { <name>: <DEFINE string>, ... }, ... } in 2.x.
interface InfoForDb {
	tables: Record<string, string>;
}
// INFO FOR TABLE returns { fields, indexes, events, lives, tables } — each a
// map of name → DEFINE string.
interface InfoForTable {
	fields: Record<string, string>;
	indexes: Record<string, string>;
}

async function infoForDb(): Promise<InfoForDb> {
	const res = await root.query<[InfoForDb]>('INFO FOR DB;');
	return res[0];
}
async function infoForTable(table: string): Promise<InfoForTable> {
	// table name is a known literal from EXPECTED below — safe to interpolate.
	const res = await root.query<[InfoForTable]>(`INFO FOR TABLE ${table};`);
	return res[0];
}

// Every table DATA-MODEL.md §4 declares (plus the _migration ledger).
const EXPECTED_TABLES = [
	// §4.1 project & plan
	'project',
	'release',
	'phase',
	'feature',
	'sprint',
	// §4.2 tasks
	'task',
	// §4.3 agents/sessions/runtime
	'agent_slot',
	'session',
	'message',
	// §4.4 analytics
	'routing_event',
	'agent_event',
	// §4.5 / §4.5a memory + audit
	'memory',
	'memory_history',
	// §4.6 knowledge graph
	'entity',
	'references',
	// §4.7 services/processes/incidents/notifications
	'service',
	'process',
	'incident',
	'notification',
	// §4.9 security
	'security_finding',
	// §4.10 cc_* mirror
	'cc_scope',
	'cc_settings',
	'cc_hook',
	'cc_agent',
	'cc_skill',
	'cc_mcp_server',
	// §4.11 workflows
	'workflow',
	'workflow_run',
	// §4.12 work queue
	'work_item',
	// §4.13 retrieval outcomes
	'retrieval_outcome',
	// §4.14 learned skills + causal chains
	'skill',
	'causal_chain',
	// §4.15 embedding cache
	'embedding_cache',
	// §S3 cognitive layer (m0073)
	'concept',
	'concept_edge',
	// §S2 learned reranker (m0075)
	'reranker_model'
];

// Every named index DATA-MODEL.md §4 declares, mapped to its table.
const EXPECTED_INDEXES: Record<string, string[]> = {
	project: ['project_slug'],
	release: ['release_by_project'],
	task: ['task_by_project', 'task_by_status', 'task_by_project_status'],
	message: ['message_by_session'],
	session: [
		'session_by_project',
		'session_dedup',
		'session_cc',
		'session_by_status',
		'session_by_workflow_run'
	],
	routing_event: ['routing_event_by_project', 'routing_event_by_task'],
	agent_event: ['agent_event_by_project', 'agent_event_by_type'],
	memory: ['memory_vec', 'memory_dedup', 'memory_by_project', 'memory_resurface', 'memory_fts'],
	memory_history: ['memory_history_by_memory'],
	process: ['process_by_pid'],
	cc_scope: ['cc_scope_by_project'],
	cc_agent: ['cc_agent_by_scope'],
	cc_skill: ['cc_skill_by_scope'],
	workflow_run: ['wfrun_by_workflow'],
	work_item: ['work_item_dedup', 'work_item_by_status_priority'],
	retrieval_outcome: ['retrieval_outcome_by_session', 'retrieval_outcome_by_memory'],
	skill: ['skill_vec', 'skill_by_status'],
	causal_chain: ['causal_chain_by_session'],
	embedding_cache: ['embedding_cache_hash'],
	// §S3 cognitive layer (m0073)
	concept: ['concept_vec', 'concept_dedup', 'concept_by_project', 'concept_by_status'],
	// §S2 learned reranker (m0075)
	reranker_model: ['reranker_model_by_status']
};

// The HNSW vector indexes — must be 2.x-valid (no "M0").
const HNSW_INDEXES: Array<{ table: string; index: string }> = [
	{ table: 'memory', index: 'memory_vec' },
	{ table: 'skill', index: 'skill_vec' },
	{ table: 'concept', index: 'concept_vec' }
];

beforeAll(async () => {
	tdb = await startTestDb();
	root = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	const applied = await runMigrations(root, schemaMigrations);
	expect(applied.length).toBeGreaterThan(0);
}, 90_000);

afterAll(async () => {
	await root?.close().catch(() => {});
	await tdb?.teardown();
});

describe('schema migrations — every table exists (§4)', () => {
	it('defines every DATA-MODEL table', async () => {
		const info = await infoForDb();
		const present = Object.keys(info.tables);
		for (const t of EXPECTED_TABLES) {
			expect(present, `missing table: ${t}`).toContain(t);
		}
	});

	it('is idempotent — re-running applies nothing new', async () => {
		const applied = await runMigrations(root, schemaMigrations);
		expect(applied).toEqual([]);
	});
});

describe('schema migrations — every index exists (§4)', () => {
	for (const [table, indexes] of Object.entries(EXPECTED_INDEXES)) {
		it(`${table} defines [${indexes.join(', ')}]`, async () => {
			const info = await infoForTable(table);
			const present = Object.keys(info.indexes);
			for (const idx of indexes) {
				expect(present, `missing index ${table}.${idx}`).toContain(idx);
			}
		});
	}
});

describe('HNSW vector indexes are 2.x-valid (no authored M0)', () => {
	// NOTE on the "no M0" rule: SurrealDB 2.6.5 ECHOES an HNSW index in INFO FOR
	// TABLE with engine-derived internals — "… M 12 M0 24 LM 0.40…" — where `M0`
	// is the auto-derived layer-0 connection count (2*M), a VALID 2.x artifact.
	// The HARD RULE ("NO M0") is about the AUTHORED DDL: we must never WRITE M0
	// in a DEFINE statement (that is the invalid/3.x form). So we assert two
	// distinct things: (a) the source migration text contains no authored M0,
	// and (b) the live index echoes a well-formed HNSW DIMENSION 1024 COSINE def.
	// Scan only EXECUTABLE DDL: strip SurrealQL line comments (`-- …`) so that an
	// explanatory comment mentioning "M0" never trips the authored-M0 guard.
	const executableSource = (schemaMigrations as Migration[])
		.map((m) => m.up)
		.join('\n')
		.replace(/--[^\n]*/g, '');

	it('no migration authors an "M0" token in any executable HNSW DEFINE', () => {
		// A bare "M0" in authored (non-comment) DDL is the invalid/3.x form.
		expect(executableSource).not.toMatch(/\bM0\b/);
	});

	it('the authored HNSW DEFINEs use the locked 2.x parameter string', () => {
		// Every authored HNSW index must be exactly the D-locked 2.x form.
		const hnswDefines = executableSource.match(/HNSW[^;]*/g) ?? [];
		expect(hnswDefines.length).toBe(HNSW_INDEXES.length);
		for (const def of hnswDefines) {
			expect(def.replace(/\s+/g, ' ').trim()).toContain(
				'HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12'
			);
		}
	});

	for (const { table, index } of HNSW_INDEXES) {
		it(`${table}.${index} echoes a valid HNSW DIMENSION 1024 COSINE def`, async () => {
			const info = await infoForTable(table);
			const ddl = info.indexes[index];
			expect(ddl, `index ${table}.${index} not found`).toBeDefined();
			expect(ddl).toMatch(/HNSW/);
			expect(ddl).toMatch(/DIMENSION\s+1024/);
			expect(ddl).toMatch(/DIST\s+COSINE/);
			expect(ddl).toMatch(/TYPE\s+F32/);
			expect(ddl).toMatch(/\bM\s+12\b/); // authored connectivity preserved
		});
	}
});

describe('memory table — CRUD + KNN round-trip through the live HNSW index', () => {
	it('inserts memories and recalls the nearest via <|K,EF|>', async () => {
		const q = fixtureVector(1);
		const near = fixtureVector(1); // identical → distance ~0
		const far = fixtureVector(9999);

		await root.query(
			`CREATE memory SET content = $c1, embedding = $e1, namespace = 'knn', key = 'near';
			 CREATE memory SET content = $c2, embedding = $e2, namespace = 'knn', key = 'far';`,
			{ c1: 'the near one', e1: near, c2: 'the far one', e2: far }
		);

		const res = await root.query<[Array<{ content: string; dist: number }>]>(
			`SELECT content, vector::distance::knn() AS dist
			 FROM memory
			 WHERE embedding <|2,40|> $q
			 ORDER BY dist;`,
			{ q }
		);
		const rows = res[0];
		expect(rows.length).toBe(2);
		expect(rows[0].content).toBe('the near one');
		expect(typeof rows[0].dist).toBe('number');
		expect(rows[0].dist).toBeLessThan(rows[1].dist);
	});

	it('soft-archive default: a fresh memory row is status="active"', async () => {
		const res = await root.query<[Array<{ status: string }>]>(
			`CREATE memory SET content = 'x', embedding = $e, namespace = 'st', key = 'k1' RETURN status;`,
			{ e: fixtureVector(2) }
		);
		expect(res[0][0].status).toBe('active');
	});
});

describe('work_item — atomic claim (dedup_key + claim-token guard, §4.12)', () => {
	it('the claim-token guard lets exactly one claimer win the pending row', async () => {
		await root.query(`CREATE work_item SET work_type = 'scan', payload = {}, priority = 5;`);
		// The claim-token guard (status='pending' AND claim_token IS NONE) is what
		// makes the claim safe; a 2nd claimer with the same guard matches nothing.
		const first = await root.query<[Array<{ status: string; claim_token: string }>]>(
			`UPDATE work_item SET claim_token = $t, status = 'processing', attempts += 1
			 WHERE status = 'pending' AND claim_token IS NONE RETURN AFTER;`,
			{ t: 'lease-1' }
		);
		expect(first[0].length).toBe(1);
		expect(first[0][0].status).toBe('processing');
		expect(first[0][0].claim_token).toBe('lease-1');

		// A 2nd claimer finds no pending+unclaimed row → claim-token guard holds.
		const second = await root.query<[Array<unknown>]>(
			`UPDATE work_item SET claim_token = $t, status = 'processing'
			 WHERE status = 'pending' AND claim_token IS NONE RETURN AFTER;`,
			{ t: 'lease-2' }
		);
		expect(second[0].length).toBe(0);
	});
});
