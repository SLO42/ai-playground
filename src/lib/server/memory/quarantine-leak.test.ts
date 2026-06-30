import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import {
	MemoryService,
	FakeEmbedder,
	cacheKey,
	gateCandidate,
	listMemories,
	listProjectMemories,
	listProjectGraph
} from './index';

// MEMORY-SPEC §3.1b + §5.3 — END-TO-END QUARANTINE LEAK HARNESS (D-026).
//
// The engine ALREADY stamps screen_status (store.ts) and excludes quarantined rows from
// every injection surface (recall.ts active-set filter, loadTier0 in index.ts, the explorer
// projections). This harness PROVES that invariant end-to-end against a REAL throwaway
// SurrealDB — it is the evidence artifact, not a digest. It does NOT rebuild quarantine.
//
// Deliverables (each an assertion below, with a real excluded-row count):
//   (1) a quarantined candidate is WRITTEN for audit but EXCLUDED from the active/persisted set.
//   (2) the RAW secret is NEVER embedded — no §7.1 embedding_cache entry keyed on raw text.
//   (3) a quarantined row is NEVER returned by recall().
//   (4) a quarantined row is NEVER returned by loadTier0() (even promoted to tier=0).
//   (5) a quarantined row is EXCLUDED from the knowledge-only export surfaces (D-026) —
//       the realized export-adjacent reads are the explorer projections (listMemories,
//       listProjectMemories, listProjectGraph) per DATA-MODEL §7b / DECISIONS D-026(b).
//
// PLUS a static grep-and-assert (no DB): enumerate EVERY source line that SELECTs `memory`
// rows and assert each injection/recall/export surface carries `screen_status != "quarantined"`,
// or is an explicitly-documented non-leak exemption (leak detector / by-id curator / write-side
// dedup probe). This is the grep-and-assert the spec demands — not a spot-check.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..', '..', 'src', 'lib', 'server');

// ─────────────────────────────────────────────────────────────────────────────────
// PART A — STATIC grep-and-assert over every `memory`-row reader (no DB).
// ─────────────────────────────────────────────────────────────────────────────────
//
// The enumeration below is the authoritative census of every NON-TEST source file that
// runs `SELECT ... FROM memory`. Each is classified LEAK (an injection/recall/export
// surface that MUST carry the quarantine filter) or EXEMPT (with the reason it cannot
// leak quarantined content into model context or an export). The coverage guard at the
// end GLOBS the whole `src/lib/server` source tree (excluding tests), so a new `FROM
// memory` reader added in ANY file — including a brand-new uncatalogued file — that this
// census does not classify makes the guard FAIL, forcing it to be classified LEAK/EXEMPT.

interface ReaderPath {
	file: string;
	/** A substring unique to the SELECT statement so we can locate + assert on it. */
	marker: string;
	/** LEAK = must carry the quarantine filter. EXEMPT = documented non-leak. */
	kind: 'LEAK' | 'EXEMPT';
	why: string;
}

const READERS: ReaderPath[] = [
	// ── LEAK surfaces — every injection / recall / export read MUST exclude quarantined ──
	{
		file: 'memory/recall.ts',
		marker: 'embedding <|',
		kind: 'LEAK',
		why: 'recall vector KNN — primary injection path (§4)'
	},
	{
		file: 'memory/recall.ts',
		marker: '->references->memory FROM $seeds',
		kind: 'LEAK',
		why: 'recall graph-neighbour expansion (§4.3 step 2) — also injects'
	},
	{
		file: 'memory/index.ts',
		marker: 'WHERE tier = 0',
		kind: 'LEAK',
		why: 'loadTier0 — always-loaded directive injection (§6.8)'
	},
	{
		file: 'memory/explorer.ts',
		marker: 'ORDER BY importance DESC, created_at DESC\n\t\t  LIMIT $limit',
		kind: 'LEAK',
		why: 'listMemories — /memory explorer + knowledge-only export surface (UI-SPEC §43, D-026)'
	},
	{
		file: 'memory/explorer.ts',
		marker: 'WHERE screen_status != "quarantined" AND project = $project',
		kind: 'LEAK',
		why: 'listProjectMemories — project Memory tab + export surface (UI-SPEC §195)'
	},
	{
		file: 'memory/explorer.ts',
		marker: 'SELECT VALUE id FROM memory WHERE project = $project',
		kind: 'LEAK',
		why: 'listProjectGraph entity sub-select — graph export of project memory (D-026)'
	},
	{
		file: 'memory/observability.ts',
		marker: 'SELECT id, content FROM memory WHERE screen_status',
		kind: 'LEAK',
		why: 'loadMemoryContent — the utilization lens (listRetrievalOutcomes) surfaces memory CONTENT to the UI; must exclude quarantined so a quarantined memory with persisted retrieval_outcome rows never surfaces its body (D-026, UI-SPEC §43)'
	},
	{
		file: 'scene/scene.ts',
		marker: 'SELECT id, kind, status, project, importance, created_at FROM memory',
		kind: 'LEAK',
		why: 'MS-2 scene aggregator — the /memory Scene viz surfaces memory NODES to the UI (id + a kind-label only, never raw content); carries the quarantine filter so a quarantined memory never appears as a scene node (MEMORY-SCENE-SPEC §2, D-026)'
	},
	{
		file: 'scene/scene.ts',
		marker: 'WHERE category = "correction" AND screen_status != "quarantined"',
		kind: 'LEAK',
		why: 'S3 scene aggregator — surfaces high-importance CORRECTION memory rows as correction NODES (id + a kind-label only, never raw content); carries the same quarantine filter so a quarantined correction never appears as a scene node (D-026)'
	},
	// ── EXEMPT readers — cannot leak quarantined content into context or an export ──
	{
		file: 'workforce/activation.ts',
		marker: 'string::contains(content, $s)',
		kind: 'EXEMPT',
		why: 'sentinelSweep is the LEAK DETECTOR itself — it MUST scan ALL rows incl. quarantined; filtering would blind it (WORKFORCE-SPEC §4.2)'
	},
	{
		file: 'importer/v1-stores.ts',
		marker: 'WHERE namespace = $ns AND key = $key LIMIT 1',
		kind: 'EXEMPT',
		why: 'findMemoryByKey — write-side import idempotency probe: returns an id only, never injects content nor exports'
	},
	{
		file: 'memory/bridge.ts',
		marker: 'WHERE namespace = $ns AND key = $key LIMIT 1',
		kind: 'EXEMPT',
		why: 'findMemoryByKey — write-side auto-memory bridge idempotency probe: returns an id only'
	},
	{
		file: 'memory/loop.ts',
		marker: 'SELECT tier, source FROM $m',
		kind: 'EXEMPT',
		why: 'consolidate §5.2 guard — by-id curator read of an explicitly-passed member; not a query surface and never injects'
	},
	{
		file: 'memory/eval/harness.ts',
		marker: 'embedding <|${k},COSINE|>',
		kind: 'LEAK',
		why: 'B8 §11 eval harness fetchCandidates — mirrors recall step-1 read-only for the weight/novelty sweep; classified LEAK so the guard enforces the same active-set filter, ensuring a sweep can never surface a quarantined row (measurement-only; never injects to a live model)'
	}
];

function readSource(rel: string): string {
	return readFileSync(join(SRC, rel), 'utf8');
}

describe('PART A — static grep-and-assert: every `memory`-row reader is classified + guarded', () => {
	for (const r of READERS) {
		it(`${r.file} :: ${r.kind} — ${r.why}`, () => {
			const src = readSource(r.file);
			const idx = src.indexOf(r.marker);
			expect(idx, `marker not found in ${r.file}: ${r.marker}`).toBeGreaterThanOrEqual(0);
			if (r.kind === 'LEAK') {
				// The quarantine filter must appear in the SAME query statement as the marker.
				// Slice the enclosing statement (from the FROM/marker back to the prior `;`,
				// forward to the next `;`) and assert the filter clause is present in it.
				const stmtStart = src.lastIndexOf(';', idx) + 1;
				const stmtEnd = src.indexOf(';', idx);
				const stmt = src.slice(stmtStart, stmtEnd === -1 ? src.length : stmtEnd);
				expect(
					stmt.includes('screen_status != "quarantined"'),
					`LEAK surface ${r.file} (${r.marker}) is MISSING the quarantine filter in its statement`
				).toBe(true);
			}
		});
	}

	// Bare `FROM memory` table reads only — NOT `memory_history`, `memory:id`, `memory_entries`,
	// `pm_memory`, nor by-id reads (`FROM $m`). This is the leak-surface regex the guard is built on.
	const FROM_MEMORY = /FROM memory(?![A-Za-z0-9_:])/g;

	// Recursively enumerate every NON-TEST .ts source file under src/lib/server, relative to SRC,
	// using forward slashes so the paths match the READERS `file` keys on every platform.
	function listServerSources(): string[] {
		const out: string[] = [];
		const walk = (absDir: string) => {
			for (const ent of readdirSync(absDir, { withFileTypes: true })) {
				const abs = join(absDir, ent.name);
				if (ent.isDirectory()) {
					walk(abs);
				} else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
					out.push(relative(SRC, abs).split(sep).join('/'));
				}
			}
		};
		walk(SRC);
		return out;
	}

	it('coverage guard: per catalogued file, the census count matches the real `FROM memory` read count', () => {
		// Catches a SECOND unfiltered read sneaked into an ALREADY-CATALOGUED file: if recall.ts
		// grows a 3rd `FROM memory` the count diverges from the census and this fails, forcing a
		// new classification. (By-id `FROM $m` reads, e.g. loop.ts consolidate, never scan the
		// table, so they do not contribute to the regex count and are skipped here.)
		const censusCounts = new Map<string, number>();
		for (const r of READERS) {
			if (r.marker.includes('tier, source FROM $')) continue;
			censusCounts.set(r.file, (censusCounts.get(r.file) ?? 0) + 1);
		}
		for (const [file, expected] of censusCounts) {
			const matches = readSource(file).match(FROM_MEMORY) ?? [];
			expect(
				matches.length,
				`${file}: census expects ${expected} bare \`FROM memory\` reads but source has ${matches.length} — classify the new reader`
			).toBe(expected);
		}
	});

	// The forward-looking guard's core predicate, factored out so it can be exercised against a
	// synthetic file set (regression test below) as well as the real tree.
	function unclassifiedReaders(files: string[], read: (rel: string) => string): string[] {
		const catalogued = new Set(READERS.map((r) => r.file));
		return files.filter(
			(rel) => (read(rel).match(FROM_MEMORY) ?? []).length > 0 && !catalogued.has(rel)
		);
	}

	it('coverage guard: EVERY file in src/lib/server with a `FROM memory` read is classified in the census', () => {
		// THE forward-looking guard: scan the whole source TREE — not just the catalogued files —
		// so a brand-new, uncatalogued source file that adds an unfiltered `FROM memory` read is
		// detected and FAILS here until it is classified LEAK or EXEMPT. (The earlier census-only
		// loop could never see a new file; this Globs the filesystem.)
		const unclassified = unclassifiedReaders(listServerSources(), readSource);
		expect(
			unclassified,
			`uncatalogued \`FROM memory\` reader(s) found — classify each LEAK or EXEMPT in READERS: ${unclassified.join(', ')}`
		).toEqual([]);
	});

	it('REGRESSION (the FAIL this fix closes): a NEW uncatalogued file with an unfiltered `FROM memory` is FLAGGED', () => {
		// Before the fix the guard only iterated the hardcoded census, so a brand-new leaking file
		// was invisible. Simulate that file and prove the filesystem-driven guard now flags it.
		const SYNTH = 'memory/__synthetic_new_leak.ts';
		const fakeRead = (rel: string): string =>
			rel === SYNTH
				? 'export async function leak(db){ return db.query(`SELECT content FROM memory WHERE 1=1;`); }'
				: readSource(rel);
		// The synthetic file is NOT in READERS → must be flagged.
		expect(unclassifiedReaders([SYNTH], fakeRead)).toEqual([SYNTH]);
		// Sanity: an already-catalogued real file with the same read is NOT flagged (no false positive).
		expect(unclassifiedReaders(['memory/recall.ts'], fakeRead)).toEqual([]);
		// Sanity: a new file WITHOUT a `FROM memory` read is NOT flagged.
		const noRead = (rel: string): string =>
			rel === SYNTH ? 'export const x = 1; // SELECT id FROM memory_history' : readSource(rel);
		expect(unclassifiedReaders([SYNTH], noRead)).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────
// PART B — END-TO-END leak proof against a REAL throwaway SurrealDB.
// ─────────────────────────────────────────────────────────────────────────────────

let tdb: TestDb;
let db: Db;
let mem: MemoryService;
let projectId: string;

// A high-confidence private-key block — the screen QUARANTINES (cannot redact safely in
// isolation, screen.ts `private-key` quarantineOnHit). Its content is recall-friendly so
// any leak would surface. SENTINEL marks raw key material that must never escape.
const RAW_SECRET =
	'deploy runbook leak-probe: here is the prod signing key\n' +
	'-----BEGIN RSA PRIVATE KEY-----\n' +
	'MIIEowIBAAKCAQEA_LEAKSENTINEL_9c1f_keymaterial_must_never_escape\n' +
	'-----END RSA PRIVATE KEY-----';
const SENTINEL = '_LEAKSENTINEL_9c1f_keymaterial_must_never_escape';
const RECALL_QUERY = 'deploy runbook prod signing key leak-probe';

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
		slug: 'qleak_demo',
		name: 'Quarantine Leak Demo',
		root_path: 'F:/code/qleak-demo'
	});
	projectId = p.id;
	mem = new MemoryService({ db, embedder: new FakeEmbedder() });
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

async function count(query: string, params: Record<string, unknown> = {}): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(query, params);
	return rows[0]?.c ?? 0;
}

describe('PART B — end-to-end quarantine leak proof (real SurrealDB, real counts)', () => {
	let quarantinedId: string;

	it('pre-flight: the screen classifies RAW_SECRET as quarantined (engine truth, not assumption)', () => {
		const gate = gateCandidate(RAW_SECRET);
		expect(gate.capture).toBe(true); // survives DO-NOT-CAPTURE
		expect(gate.screen!.status).toBe('quarantined');
		// The screened body the engine would persist already has the raw key material stripped.
		expect(gate.screen!.text).not.toContain(SENTINEL);
	});

	it('Deliverable (1): the quarantined candidate is WRITTEN for audit but EXCLUDED from the active/persisted set', async () => {
		// Plant a clean decoy on the SAME theme so recall/list have a legitimate row to return —
		// a leak would show up as the quarantined row appearing ALONGSIDE the decoy.
		await mem.store([
			{ content: 'deploy runbook: signing-key rotation policy is documented (control)', project: projectId }
		]);
		const [r] = await mem.store([{ content: RAW_SECRET, project: projectId }]);
		expect(r.persisted).toBe(true); // written
		expect(r.screenStatus).toBe('quarantined');
		quarantinedId = r.id;

		// WRITTEN for audit: the row exists, AND a memory_history "add" audit row exists.
		const total = await count(`SELECT count() AS c FROM $id GROUP ALL;`, { id: rid(quarantinedId) });
		expect(total).toBe(1);
		const audit = await count(
			`SELECT count() AS c FROM memory_history WHERE memory = $id GROUP ALL;`,
			{ id: rid(quarantinedId) }
		);
		expect(audit).toBeGreaterThanOrEqual(1);

		// Its stored body never carries the raw key material (audit row is safe too).
		const [rows] = await db.query<[Array<{ content: string }>]>(`SELECT content FROM $id;`, {
			id: rid(quarantinedId)
		});
		expect(rows[0].content).not.toContain(SENTINEL);

		// EXCLUDED from the active/persisted SET — the shared active-set + screen filter (§5.3)
		// the readers use. Real excluded-row count: total quarantined rows minus what the
		// active-set query returns.
		const activeSetCount = await count(
			`SELECT count() AS c FROM memory
			   WHERE (status = "active" OR status IS NONE)
			     AND screen_status != "quarantined"
			     AND id = $id GROUP ALL;`,
			{ id: rid(quarantinedId) }
		);
		expect(activeSetCount).toBe(0); // excluded: 1 written, 0 in the active set
	});

	it('Deliverable (2): the RAW secret is NEVER embedded — no §7.1 embedding_cache entry keyed on raw text', async () => {
		// The cache key the engine WOULD have used had it embedded the raw candidate. Because
		// screen-before-embed (store.ts) embeds only the REDACTED text, this key must be absent.
		const rawKey = cacheKey(RAW_SECRET, mem.embedder.modelVersion);
		const rawHits = await count(`SELECT count() AS c FROM embedding_cache WHERE hash = $h GROUP ALL;`, {
			h: rawKey
		});
		expect(rawHits).toBe(0);

		// Defence-in-depth: NO embedding_cache row's hash is computed over any text containing
		// the sentinel is impossible to check directly (hashes are opaque), so we assert the
		// stronger structural fact — the engine never called embed() on a body with the sentinel
		// by confirming the redacted body (what WAS embedded) lacks it, and the redacted key
		// (what SHOULD exist) does. The redacted entry existing proves the row was embedded over
		// SAFE text, not skipped.
		const screenedBody = gateCandidate(RAW_SECRET).screen!.text;
		expect(screenedBody).not.toContain(SENTINEL);
		const redactedKey = cacheKey(screenedBody, mem.embedder.modelVersion);
		const redactedHits = await count(
			`SELECT count() AS c FROM embedding_cache WHERE hash = $h GROUP ALL;`,
			{ h: redactedKey }
		);
		expect(redactedHits).toBe(1); // embedded over the SAFE redacted text — the only entry
	});

	it('Deliverable (3): the quarantined row is NEVER returned by recall()', async () => {
		const res = await mem.recall(RECALL_QUERY, { project: projectId, k: 50, limit: 50 });
		// The decoy (control) should be returned so we know recall is actually working.
		const texts = res.items.map((i) => i.fenced.text).join('\n');
		expect(texts).toContain('(control)');
		// The sentinel must NOT appear in ANY returned fenced block, and the quarantined id
		// must not be among the returned ids.
		expect(texts).not.toContain(SENTINEL);
		expect(res.items.map((i) => i.id)).not.toContain(quarantinedId);
	});

	it('Deliverable (4): the quarantined row is NEVER returned by loadTier0() — even promoted to tier=0', async () => {
		// Adversarial: promote the quarantined row to Tier-0 (operator/curator action). The
		// loadTier0 screen filter must STILL exclude it — membership is not exemption (§6.8/§10).
		await db.query(`UPDATE $id SET tier = 0;`, { id: rid(quarantinedId) });
		// Also promote the clean decoy to Tier-0 so loadTier0 returns something legitimately.
		await db.query(`UPDATE memory SET tier = 0 WHERE string::contains(content, "(control)");`);

		const t0 = await mem.loadTier0(projectId);
		expect(t0.length).toBeGreaterThan(0); // the clean decoy loads
		const t0Text = t0.map((i) => i.text).join('\n');
		expect(t0Text).not.toContain(SENTINEL);
		expect(t0Text).toContain('(control)');

		// Real excluded-row count: tier-0 rows in the DB vs tier-0 rows loadTier0 surfaced.
		const tier0InDb = await count(`SELECT count() AS c FROM memory WHERE tier = 0 GROUP ALL;`);
		const tier0Quarantined = await count(
			`SELECT count() AS c FROM memory WHERE tier = 0 AND screen_status = "quarantined" GROUP ALL;`
		);
		expect(tier0Quarantined).toBeGreaterThanOrEqual(1); // we planted ≥1
		expect(t0.length).toBe(tier0InDb - tier0Quarantined); // exactly the quarantined ones excluded
	});

	it('Deliverable (5): the quarantined row is EXCLUDED from the knowledge-only export surfaces (D-026)', async () => {
		// The realized export-adjacent reads (DATA-MODEL §7b / DECISIONS D-026(b)): the explorer
		// projections that surface/share memory. NONE may carry a quarantined row.
		const global = await listMemories(db, 500);
		expect(global.map((m) => m.id)).not.toContain(quarantinedId);
		expect(global.some((m) => m.content.includes(SENTINEL))).toBe(false);

		const projRows = await listProjectMemories(db, projectId, 500);
		expect(projRows.map((m) => m.id)).not.toContain(quarantinedId);
		expect(projRows.some((m) => m.content.includes(SENTINEL))).toBe(false);

		// The project graph export draws entities only from NON-quarantined memory rows — its
		// entity sub-select excludes the quarantined row, so no quarantined-derived node leaks.
		const graph = await listProjectGraph(db, projectId, 500);
		expect(graph.nodes.some((n) => n.label.includes(SENTINEL))).toBe(false);

		// Real excluded-row count for the export surface: total project rows vs exported rows.
		const totalProjRows = await count(
			`SELECT count() AS c FROM memory WHERE project = $p GROUP ALL;`,
			{ p: rid(projectId) }
		);
		const quarantinedProjRows = await count(
			`SELECT count() AS c FROM memory WHERE project = $p AND screen_status = "quarantined" GROUP ALL;`,
			{ p: rid(projectId) }
		);
		expect(quarantinedProjRows).toBeGreaterThanOrEqual(1);
		expect(projRows.length).toBe(totalProjRows - quarantinedProjRows); // exactly the quarantined excluded
	});

	// ── SHADOW PATHS: nil / empty / error inputs on the quarantine-bearing read paths ──

	it('shadow path (empty store): recall + exports return honest empty on a project with no memory', async () => {
		const empty = await createProject(db, {
			slug: 'qleak_empty',
			name: 'Empty',
			root_path: 'F:/code/qleak-empty'
		});
		try {
			const res = await mem.recall('anything', { project: empty.id, limit: 10 });
			expect(res.items).toEqual([]);
			expect(res.contextText).toBe('');
			expect(await listProjectMemories(db, empty.id, 50)).toEqual([]);
			const g = await listProjectGraph(db, empty.id, 50);
			expect(g).toEqual({ nodes: [], edges: [] });
		} finally {
			await deleteProject(db, empty.id).catch(() => {});
		}
	});

	it('shadow path (nil/empty input to the screen): empty content is dropped, never persisted', async () => {
		const before = await count(`SELECT count() AS c FROM memory GROUP ALL;`);
		const [r] = await mem.store([{ content: '   ', project: projectId }]);
		expect(r.persisted).toBe(false); // DO-NOT-CAPTURE empty
		expect(await count(`SELECT count() AS c FROM memory GROUP ALL;`)).toBe(before);
	});
});
