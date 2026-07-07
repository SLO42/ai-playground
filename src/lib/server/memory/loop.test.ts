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
	enqueueReview,
	ReviewForkShapeError,
	type MemoryWriteSurface,
	type SkillCandidate,
	type WrittenSkill
} from './loop';
import type { ExtractFn, MemoryCandidate, StoredMemory } from './store';
import { activeWorkItemId } from '../orchestrator/workqueue';

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
	it('the write surface exposes ONLY writeMemories + writeSkill + writeConcepts — no db/exec/git/fs handle', () => {
		// Structural proof: the capability object the fork receives has exactly the three
		// whitelisted write methods and no escape hatch (no `db`, `query`, `exec`, `git`, `fs`).
		const keys = Object.keys(surface).sort();
		expect(keys).toEqual(['writeConcepts', 'writeMemories', 'writeSkill']);
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
			},
			async writeConcepts(c): Promise<import('./concepts').StoredConcept[]> {
				calls.push(`writeConcepts:${c.length}`);
				return c.map(() => ({ id: '', persisted: true, deduped: false, screenStatus: 'clean' as const }));
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

// ── RED-TEAM follow-ups (wave-v2.2b-b deferral ledger) ───────────────────────────

describe('RT-1 (F-008) enqueueReview dedup catch — swallow ONLY the unique-violation, re-raise the rest', () => {
	it('a real dedup collision (UNIQUE index already contains) coalesces to a null no-op', async () => {
		// Enqueue once, then again with the SAME session ⇒ the work_item_dedup UNIQUE index
		// (dedup_key = the session id) collides; the second call returns null, not a throw.
		const s = await makeSession();
		const first = await enqueueReview(db, { session: s, kind: 'memory', turnText: 'first' });
		expect(first).not.toBeNull();
		// F-057-class regression (pins the corrected workqueue.ts/schema.ts §4.12 comment):
		// enqueueReview is the SOLE active-window RANDOM-id producer that relies on the
		// work_item_dedup UNIQUE index — it does NOT use the deterministic-id enqueue() scheme,
		// so its row id is NOT activeWorkItemId(...). If it is ever routed through enqueue()
		// (making the "sole random-id producer" note stale), this inequality breaks.
		expect(first).not.toBe(activeWorkItemId('memory_review', s, s));
		const second = await enqueueReview(db, { session: s, kind: 'memory', turnText: 'second' });
		expect(second).toBeNull(); // dedup no-op — the real unique-violation signal
		// Exactly ONE pending review for the session (the dedup actually coalesced).
		const [rows] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM work_item WHERE session = $sid GROUP ALL;`,
			{ sid: new StringRecordId(s) }
		);
		expect(rows[0]?.c).toBe(1);
	});

	it('a CREATE error containing the substring "index" but NOT the unique phrase re-raises (the F-008 core)', async () => {
		// Direct unit-level proof of the regex tightening: simulate the SurrealDB layer throwing
		// an HNSW/index-build style error (contains "index", is NOT "already contains/exists").
		const throwingDb = {
			query: async (sql: string) => {
				if (/SELECT kind FROM/.test(sql)) return [[{ kind: 'task' }]];
				throw new Error('There was a problem with the database: the index `memory_vec` is being built');
			}
		} as unknown as Db;
		await expect(
			enqueueReview(throwingDb, { session: sessionId, kind: 'memory', turnText: 't' })
		).rejects.toThrow(/index `memory_vec` is being built/);
	});

	it('a CREATE error in the "already contains"/"already exists" shape coalesces to null', async () => {
		for (const msg of [
			"Database index `work_item_dedup` already contains 'session:abc', with record 'work_item:x'",
			'Database record `work_item:dup` already exists'
		]) {
			const dupDb = {
				query: async (sql: string) => {
					if (/SELECT kind FROM/.test(sql)) return [[{ kind: 'task' }]];
					throw new Error(msg);
				}
			} as unknown as Db;
			expect(await enqueueReview(dupDb, { session: sessionId, kind: 'memory', turnText: 't' })).toBeNull();
		}
	});
});

describe('RT-2 (D-026) screenSkill — the skill NAME is screened too (no raw secret/injection in skill.name)', () => {
	it('a secret in skill.name is REDACTED in the persisted row (never stored raw)', async () => {
		const SECRET = 'sk-ant-abcdefghij1234567890';
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{ name: `deploy with ${SECRET}`, description: 'a fine description', steps: ['do a thing'] }
		];
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		expect(out.skills[0].persisted).toBe(true);
		const [rows] = await db.query<[Array<{ name: string }>]>(`SELECT name FROM $id;`, {
			id: rid(out.skills[0].id)
		});
		expect(rows[0].name).not.toContain(SECRET); // raw secret gone from the name
		expect(rows[0].name).toContain('[REDACTED:anthropic-key]');
	});

	it('a private key pasted into skill.name QUARANTINES the skill (does NOT graduate)', async () => {
		const before = await countSkills();
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{
				name: '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
				description: 'a fine description',
				steps: ['do a thing']
			}
		];
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		expect(out.skills[0].persisted).toBe(false);
		expect(out.skills[0].dropReason).toMatch(/quarantine/);
		expect(await countSkills()).toBe(before); // nothing graduated
	});

	it('a name that is ONLY a redactable secret (empty after redaction)… still has a placeholder so it graduates; a DO-NOT-CAPTURE name drops', async () => {
		// A DO-NOT-CAPTURE phrase in the name (capture:false) blocks graduation — the name is an
		// LLM-authored field and a "the daemon is down" name must not persist.
		const before = await countSkills();
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{ name: 'the gateway is unreachable right now', description: 'd', steps: ['s'] }
		];
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		expect(out.skills[0].persisted).toBe(false);
		expect(await countSkills()).toBe(before);
	});
});

describe('LOW-1 (wave-v2.2b-c) screenSkill name gate — hyphenated identifier names are NOT over-dropped', () => {
	// The DO-NOT-CAPTURE prose gate (captureGate) was authored for PROSE memory claims; its
	// single-word triggers (`down`, `timeout`, `unreachable`) over-fired on legit kebab-case
	// SKILL-NAME tokens, dropping `down-detector` / `retry-on-timeout` etc. The fix: the prose
	// gate applies ONLY to a name that reads like prose (contains whitespace); the secret/PII
	// screen still runs on every name, so an injected secret in a token name is STILL caught.

	it('legit hyphenated names graduate (handle-connection-refused, fix-cannot-resolve, down-detector, retry-on-timeout)', async () => {
		const before = await countSkills();
		const names = [
			'handle-connection-refused',
			'fix-cannot-resolve',
			'down-detector',
			'retry-on-timeout',
			'recover-from-down-stream',
			'resolve-unreachable-host'
		];
		const proposeSkills = async (): Promise<SkillCandidate[]> =>
			names.map((name) => ({ name, description: 'a fine description', steps: ['do a thing'] }));
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		// Every legit hyphenated name graduated (none dropped by the prose gate).
		expect(out.skills.every((s) => s.persisted)).toBe(true);
		expect(out.skills.map((s) => Boolean(s.persisted))).toEqual(names.map(() => true));
		expect(await countSkills()).toBe(before + names.length);
		// The names persisted unredacted (they carry no secret/PII).
		const [rows] = await db.query<[Array<{ name: string }>]>(`SELECT name FROM skill WHERE id IN $ids;`, {
			ids: out.skills.map((s) => rid(s.id))
		});
		const stored = new Set(rows.map((r) => r.name));
		for (const n of names) expect(stored.has(n)).toBe(true);
	});

	it('a secret in a TOKEN-form name (no whitespace) is STILL caught by the secret screen', async () => {
		// Token-form names skip the PROSE gate — but the secret/PII screen runs regardless,
		// so a no-whitespace secret name is redacted in the persisted row (never stored raw).
		const SECRET = 'sk-ant-abcdefghij1234567890';
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{ name: SECRET, description: 'a fine description', steps: ['do a thing'] }
		];
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		expect(out.skills[0].persisted).toBe(true);
		const [rows] = await db.query<[Array<{ name: string }>]>(`SELECT name FROM $id;`, {
			id: rid(out.skills[0].id)
		});
		expect(rows[0].name).not.toContain(SECRET);
		expect(rows[0].name).toContain('[REDACTED:anthropic-key]');
	});

	it('an injection/private-key TOKEN name still QUARANTINES (does NOT graduate)', async () => {
		// A private-key block is multi-token (has whitespace) but the point holds: a real secret
		// in the name blocks graduation even though the prose-gate narrowing landed.
		const before = await countSkills();
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{
				name: '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
				description: 'a fine description',
				steps: ['do a thing']
			}
		];
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		expect(out.skills[0].persisted).toBe(false);
		expect(out.skills[0].dropReason).toMatch(/quarantine/);
		expect(await countSkills()).toBe(before);
	});

	it('a PROSE negative-claim name (whitespace) STILL drops (prose gate preserved)', async () => {
		const before = await countSkills();
		const proposeSkills = async (): Promise<SkillCandidate[]> => [
			{ name: 'the gateway is unreachable right now', description: 'd', steps: ['s'] }
		];
		const out = await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills
		});
		expect(out.skills[0].persisted).toBe(false);
		expect(await countSkills()).toBe(before);
	});
});

describe('RT-3 (D-026) runReviewFork — the injected LLM return is shape-validated (named error, not raw TypeError)', () => {
	it('extract returning a non-array (object) throws a NAMED ReviewForkShapeError', async () => {
		const badExtract = (async () => ({ not: 'an array' })) as unknown as ExtractFn;
		await expect(
			runReviewFork({ payload: { kind: 'memory', turnText: 'turn', session: sessionId }, surface, extract: badExtract })
		).rejects.toBeInstanceOf(ReviewForkShapeError);
	});

	it('extract returning null is NAMED with the seam + received shape (not "map is not a function")', async () => {
		const nullExtract = (async () => null) as unknown as ExtractFn;
		await runReviewFork({
			payload: { kind: 'memory', turnText: 'turn', session: sessionId },
			surface,
			extract: nullExtract
		}).then(
			() => {
				throw new Error('expected throw');
			},
			(err) => {
				expect(err).toBeInstanceOf(ReviewForkShapeError);
				expect((err as ReviewForkShapeError).seam).toBe('extract');
				expect((err as ReviewForkShapeError).received).toBe('null');
				expect((err as Error).message).not.toMatch(/is not a function/);
			}
		);
	});

	it('proposeSkills returning a non-array (string) throws a NAMED ReviewForkShapeError(proposeSkills)', async () => {
		const badSkills = (async () => '[]') as unknown as () => Promise<SkillCandidate[]>;
		await runReviewFork({
			payload: { kind: 'skill', turnText: 'turn', session: sessionId },
			surface,
			extract: noExtract,
			proposeSkills: badSkills
		}).then(
			() => {
				throw new Error('expected throw');
			},
			(err) => {
				expect(err).toBeInstanceOf(ReviewForkShapeError);
				expect((err as ReviewForkShapeError).seam).toBe('proposeSkills');
			}
		);
	});

	it('a well-formed array still works (positive control — the guard does not reject valid returns)', async () => {
		const out = await runReviewFork({
			payload: { kind: 'memory', turnText: 'turn', session: sessionId, project: projectId },
			surface,
			extract: async () => [{ content: 'a valid candidate survives the shape guard' }]
		});
		expect(out.memoryCandidates).toBe(1);
		expect(out.stored[0].persisted).toBe(true);
	});

	// ── element-shape boundary (the array wrapper being valid does NOT make each element trusted) ──
	// Regression for the pass-1-missed MEDIUM: extract→[null] previously hit the provenance spread
	// (`c.project`) and threw an ANONYMOUS `TypeError: Cannot read properties of null (reading
	// 'project')` — instanceof ReviewForkShapeError === false, the exact symptom the class exists to
	// kill. Each malformed-element case must now fail NAMED, with the seam + the bad element index.
	it('a null ELEMENT inside a valid array throws a NAMED ReviewForkShapeError (not a raw TypeError)', async () => {
		const badExtract = (async () => [{ content: 'ok' }, null]) as unknown as ExtractFn;
		await runReviewFork({
			payload: { kind: 'memory', turnText: 'turn', session: sessionId, project: projectId },
			surface,
			extract: badExtract
		}).then(
			() => {
				throw new Error('expected throw');
			},
			(err) => {
				expect(err).toBeInstanceOf(ReviewForkShapeError);
				expect((err as ReviewForkShapeError).seam).toBe('extract');
				expect((err as ReviewForkShapeError).elementIndex).toBe(1);
				expect((err as ReviewForkShapeError).received).toBe('null');
				// The precise symptom the named guard eliminates — never the anonymous TypeError.
				expect((err as Error).message).not.toMatch(/Cannot read properties/);
				expect((err as Error).message).not.toMatch(/is not a function/);
			}
		);
	});

	it('a primitive ELEMENT (number) inside a valid array throws a NAMED ReviewForkShapeError', async () => {
		const badExtract = (async () => [42]) as unknown as ExtractFn;
		await expect(
			runReviewFork({ payload: { kind: 'memory', turnText: 'turn', session: sessionId }, surface, extract: badExtract })
		).rejects.toBeInstanceOf(ReviewForkShapeError);
	});

	it('an object ELEMENT missing the string `content` field throws a NAMED ReviewForkShapeError', async () => {
		const badExtract = (async () => [{ kind: 'note' }]) as unknown as ExtractFn;
		await runReviewFork({
			payload: { kind: 'memory', turnText: 'turn', session: sessionId },
			surface,
			extract: badExtract
		}).then(
			() => {
				throw new Error('expected throw');
			},
			(err) => {
				expect(err).toBeInstanceOf(ReviewForkShapeError);
				expect((err as ReviewForkShapeError).elementIndex).toBe(0);
				expect((err as ReviewForkShapeError).received).toBe('object');
			}
		);
	});

	it('nothing is written when ANY element is malformed (the whole fork fails, no partial write)', async () => {
		const before = await countMemories();
		const badExtract = (async () => [{ content: 'would-be-stored' }, null]) as unknown as ExtractFn;
		await expect(
			runReviewFork({
				payload: { kind: 'memory', turnText: 'turn', session: sessionId, project: projectId },
				surface,
				extract: badExtract
			})
		).rejects.toBeInstanceOf(ReviewForkShapeError);
		// The guard runs BEFORE writeMemories, so the leading valid element is NOT persisted.
		expect(await countMemories()).toBe(before);
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
