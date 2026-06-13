import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { FakeEmbedder } from './embed';
import {
	runReviewFork,
	makeWriteSurface,
	type MemoryWriteSurface,
	type SkillCandidate,
	type WrittenSkill
} from './loop';
import type { ExtractFn, MemoryCandidate, StoredMemory } from './store';

// TASK 2.5 / D-027 §2.1 — the review-memory WRITER FORK, against a LIVE throwaway SurrealDB
// with the real §4 schema (memory, skill, memory_history). The embedder is the deterministic
// FakeEmbedder (no Ollama in this sandbox). The review LLM call is the injected `extract` /
// `proposeSkills` seam (mocked — a mock in a TEST is allowed, F-008).
//
// The two D-038 proof obligations:
//   (A) The fork CANNOT write outside the memory/skill whitelist (§2.1) — it is handed ONLY
//       the narrow MemoryWriteSurface; it has no Db/exec/git/fs. We prove (1) the surface has
//       no escape-hatch method, and (2) a fork run touches ONLY memory/skill tables.
//   (B) The fork CANNOT launder an unscreened secret — a secret in an extracted candidate is
//       redacted/quarantined (never embedded raw); a secret in a skill body blocks graduation.
// Plus shadow paths: nil/blank turn, empty candidate set, LLM throw (no fake-success).

let tdb: TestDb;
let db: Db;
let projectId: string;
let sessionId: string;
let surface: MemoryWriteSurface;

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
	const p = await createProject(db, { slug: 'fork_demo', name: 'Fork Demo', root_path: 'F:/code/fork-demo' });
	projectId = p.id;
	sessionId = await makeSession();
	surface = makeWriteSurface(db, new FakeEmbedder());
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

describe('§2.1 writer fork — ADD-only memory write through the screen-before-embed surface', () => {
	it('mines a turn and writes the extracted candidates (screened, embedded, m0033 provenance)', async () => {
		const extract: ExtractFn = async () => [
			{ content: 'the build command is npm run build' },
			{ content: 'SvelteKit 2 uses Svelte 5 runes' }
		];
		const out = await runReviewFork({
			payload: { kind: 'memory', turnText: 'turn body', session: sessionId, project: projectId },
			surface,
			extract
		});
		expect(out.memoryCandidates).toBe(2);
		expect(out.stored.every((s) => s.persisted)).toBe(true);
		// Read back: rows exist, screened clean, embedded, and carry the originating session.
		const [rows] = await db.query<[Array<{ screen_status: string; embedding: number[]; session: unknown }>]>(
			`SELECT screen_status, embedding, session FROM memory WHERE id IN $ids;`,
			{ ids: out.stored.map((s) => rid(s.id)) }
		);
		expect(rows).toHaveLength(2);
		for (const r of rows) {
			expect(r.screen_status).toBe('clean');
			expect(r.embedding).toHaveLength(1024);
			expect(String(r.session)).toBe(sessionId); // m0033 provenance stamped by the fork
		}
	});

	it('carries the fork project/session onto a candidate that omits them', async () => {
		const extract: ExtractFn = async () => [{ content: 'reuse db/validate.ts at the boundary' }];
		const out = await runReviewFork({
			payload: { kind: 'memory', turnText: 'x', session: sessionId, project: projectId },
			surface,
			extract
		});
		const [rows] = await db.query<[Array<{ project: unknown; session: unknown }>]>(
			`SELECT project, session FROM $id;`,
			{ id: rid(out.stored[0].id) }
		);
		expect(String(rows[0].project)).toBe(projectId);
		expect(String(rows[0].session)).toBe(sessionId);
	});
});

describe('(B) the fork CANNOT launder an unscreened secret', () => {
	it('a secret in an extracted candidate is REDACTED before embed (raw key never stored)', async () => {
		const SECRET = 'sk-ant-abcdefghij1234567890';
		const extract: ExtractFn = async () => [
			{ content: `to call the API use the key ${SECRET} in the header` }
		];
		const out = await runReviewFork({
			payload: { kind: 'memory', turnText: 'leaky turn', session: sessionId, project: projectId },
			surface,
			extract
		});
		expect(out.stored[0].persisted).toBe(true);
		expect(out.stored[0].screenStatus).toBe('redacted');
		const [rows] = await db.query<[Array<{ content: string }>]>(`SELECT content FROM $id;`, {
			id: rid(out.stored[0].id)
		});
		// The raw secret is GONE; the redaction placeholder is in its place.
		expect(rows[0].content).not.toContain(SECRET);
		expect(rows[0].content).toContain('[REDACTED:anthropic-key]');
		// And the audit row never holds the raw secret either (§6.9).
		const [hist] = await db.query<[Array<{ after: { content: string } }>]>(
			`SELECT after FROM memory_history WHERE memory = $m AND op = "add";`,
			{ m: rid(out.stored[0].id) }
		);
		expect(hist.some((h) => h.after.content.includes(SECRET))).toBe(false);
	});

	it('a private key in a SKILL body blocks graduation (skill is NOT written raw)', async () => {
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{
				name: 'deploy-flow',
				description: 'Deploy using the stored key',
				steps: [
					'run the deploy script',
					'-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----'
				]
			}
		];
		const before = await countSkills();
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'a turn proposing a poisoned skill', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		expect(out.skillCandidates).toBe(1);
		expect(out.skills[0].persisted).toBe(false);
		expect(out.skills[0].dropReason).toMatch(/quarantine/);
		expect(await countSkills()).toBe(before); // nothing graduated
	});

	it('a clean skill DOES graduate (positive control), screened', async () => {
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{ name: 'run-tests', description: 'Run the project test suite', steps: ['npm test', 'check exit code'] }
		];
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'a turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		expect(out.skills[0].persisted).toBe(true);
		const [rows] = await db.query<[Array<{ name: string; status: string; steps: string[] }>]>(
			`SELECT name, status, steps FROM $id;`,
			{ id: rid(out.skills[0].id) }
		);
		expect(rows[0].name).toBe('run-tests');
		expect(rows[0].status).toBe('active');
		expect(rows[0].steps).toEqual(['npm test', 'check exit code']);
	});
});

describe('(A) the fork CANNOT write outside the memory/skill whitelist (§2.1)', () => {
	it('the write surface exposes ONLY writeMemories + writeSkill — no db/exec/git/fs handle', () => {
		// Structural proof: the capability object the fork receives has exactly the two
		// whitelisted methods and no escape hatch (no `db`, `query`, `exec`, `git`, `fs`).
		const keys = Object.keys(surface).sort();
		expect(keys).toEqual(['writeMemories', 'writeSkill']);
		const asRecord = surface as unknown as Record<string, unknown>;
		for (const forbidden of ['db', 'query', 'exec', 'git', 'fs', 'spawn', 'run']) {
			expect(asRecord[forbidden]).toBeUndefined();
		}
	});

	it('a fork given a SPY surface can only reach the two whitelisted methods (no other call)', async () => {
		// Behavioural proof: even a fork driven by a hostile extractor/proposer can only ever
		// call through the surface — there is no other capability in scope. We hand it a spy
		// surface and assert the ONLY effects are writeMemories/writeSkill calls.
		const calls: string[] = [];
		const spy: MemoryWriteSurface = {
			async writeMemories(c: MemoryCandidate[]): Promise<StoredMemory[]> {
				calls.push(`writeMemories:${c.length}`);
				return c.map(() => ({ id: '', screenStatus: 'clean' as const, persisted: true }));
			},
			async writeSkill(s: SkillCandidate): Promise<WrittenSkill> {
				calls.push(`writeSkill:${s.name}`);
				return { id: '', persisted: true };
			}
		};
		const hostileExtract: ExtractFn = async () => [{ content: 'rm -rf / ; git push --force' }];
		const hostileSkills = async (): Promise<SkillCandidate[]> => [
			{ name: 'evil', description: 'exec a shell', steps: ['execFile("rm", ["-rf", "/"])'] }
		];
		await runReviewFork({
			payload: { kind: 'combined', turnText: 'attack', session: sessionId },
			surface: spy,
			extract: hostileExtract,
			proposeSkills: hostileSkills
		});
		// The hostile content was treated as DATA — it flowed into writeMemories/writeSkill
		// (where it would be screened), and NO other capability was touched (there is none).
		expect(calls).toEqual(['writeMemories:1', 'writeSkill:evil']);
	});

	it('combined kind drives BOTH paths against the live surface', async () => {
		const extract: ExtractFn = async () => [{ content: 'the lint command is npm run lint' }];
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{ name: 'lint-fix', description: 'Lint and fix', steps: ['npm run lint -- --fix'] }
		];
		const out = await runReviewFork({
			payload: { kind: 'combined', turnText: 'turn', session: sessionId, project: projectId },
			surface,
			extract,
			proposeSkills
		});
		expect(out.stored[0].persisted).toBe(true);
		expect(out.skills[0].persisted).toBe(true);
	});
});

describe('shadow paths — nil / empty / upstream error', () => {
	it('blank turnText ⇒ no extraction, nothing written (nil-input shadow)', async () => {
		const before = await countMemories();
		let called = false;
		const extract: ExtractFn = async () => {
			called = true;
			return [{ content: 'should never run' }];
		};
		const out = await runReviewFork({
			payload: { kind: 'memory', turnText: '   ', session: sessionId },
			surface,
			extract
		});
		expect(called).toBe(false);
		expect(out.stored).toEqual([]);
		expect(out.memoryCandidates).toBe(0);
		expect(await countMemories()).toBe(before);
	});

	it('extractor returns [] ⇒ empty result, nothing written (empty-input shadow)', async () => {
		const before = await countMemories();
		const out = await runReviewFork({
			payload: { kind: 'memory', turnText: 'a turn with nothing durable', session: sessionId },
			surface,
			extract: async () => []
		});
		expect(out.stored).toEqual([]);
		expect(out.memoryCandidates).toBe(0);
		expect(await countMemories()).toBe(before);
	});

	it('an extractor THROW propagates (no fake-success swallow, F-008) — upstream-error shadow', async () => {
		const boom: ExtractFn = async () => {
			throw new Error('review LLM unreachable');
		};
		await expect(
			runReviewFork({ payload: { kind: 'memory', turnText: 'x', session: sessionId }, surface, extract: boom })
		).rejects.toThrow(/review LLM unreachable/);
	});

	it('a per-skill write failure is isolated — one bad skill never drops the rest', async () => {
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{ name: 'good', description: 'a fine skill', steps: ['do a thing'] },
			{ name: '', description: 'no name → not graduatable', steps: [] }, // dropped, not thrown
			{ name: 'good2', description: 'another fine skill', steps: ['do another thing'] }
		];
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		expect(out.skills).toHaveLength(3);
		expect(out.skills[0].persisted).toBe(true);
		expect(out.skills[1].persisted).toBe(false); // dropped (empty name/steps)
		expect(out.skills[2].persisted).toBe(true);
	});

	it("kind='memory' with no proposeSkills writes no skill; kind='skill' with no extractor writes no memory", async () => {
		const memOnly = await runReviewFork({
			payload: { kind: 'memory', turnText: 'turn', session: sessionId, project: projectId },
			surface,
			extract: async () => [{ content: 'memory-only path note' }]
		});
		expect(memOnly.skills).toEqual([]);
		const skillOnly = await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills: async () => [{ name: 'sk', description: 'd', steps: ['s'] }]
		});
		expect(skillOnly.stored).toEqual([]);
		expect(skillOnly.memoryCandidates).toBe(0);
	});
});

// ── helpers ────────────────────────────────────────────────────────────────────

/** An extractor that must NOT be called on a skill-only run (asserts the guard). */
const noExtract: ExtractFn = async () => {
	throw new Error('extract should not be called on a skill-only fork');
};

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

async function countMemories(): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM memory GROUP ALL;`);
	return rows[0]?.c ?? 0;
}

async function countSkills(): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM skill GROUP ALL;`);
	return rows[0]?.c ?? 0;
}

async function makeSession(): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT {
		   kind: "task", model: { provider: "claude", model_id: "claude-opus-4-8" }, runtime: "claude-code"
		 } RETURN AFTER;`
	);
	return String(rows[0].id);
}
