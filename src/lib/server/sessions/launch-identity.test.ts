// SPAWN-IDENTITY (LB-2 write half) — the session row is BORN with an identity.
//
// THE DEFECT. `launchSession` is the only `CREATE session` on the launch path (the gauntlet
// CREATEs its own interview rows). It stamped `agent` (the pool SLOT id) and `specialist`, and
// deliberately skipped `role` because m0069/m0070 recorded that "role is stamped LATER by
// workforce activation". Nothing in `src/` ever performed that later stamp — so a launched
// session's role was never stamped at all, and every surface that names a session fell through
// to the intent slug (~30 identical `code-write` chips) or a bare id tail.
//
// WHAT THESE TESTS PROVE, against a REAL SurrealDB (a stubDb cannot: it would not enforce the
// `record<role>` link type, and would pass green on a string):
//   • role / role_version / specialist / a purposeful agent name LAND at CREATE, as real links.
//   • the spawn agent_event carries WHO and WHY (analytics first-class), including the slot id
//     that `session.agent` no longer holds — so provenance survives the rename.
//   • the shadow paths: a spawn with NONE of the new config is byte-identical to before, blank
//     strings are omitted rather than persisted as "", and a malformed role id fails BEFORE the
//     row exists (no half-identified session — the re-run/interrupt contract).
//
// The runtime is a scripted mock (no creds, no network) — a mocked runtime in a TEST is allowed;
// every asserted value is read back from the live throwaway DB (F-008).

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
import { launchSession, type LaunchInput } from './launch';

let tdb: TestDb;
let db: Db;
let projectId: string;
let taskId: string;

/** A scripted backend with a per-instance ccSessionId (the session_dedup UNIQUE index keys on it). */
function scriptedBackend(): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	const ccSessionId = `cc_id_${Math.random().toString(36).slice(2, 12)}`;
	return {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'token_usage', input: 10, output: 5 };
					yield { type: 'done', result: { ok: true, summary: 'done', ccSessionId } };
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return {
				ccSessionId: req.ccSessionId,
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'done', result: { ok: true, summary: 'resumed' } };
				},
				async cancel() {}
			};
		},
		async interject() {}
	};
}

function runtime() {
	return new ClaudeCodeRuntime({
		backend: scriptedBackend(),
		harnessConfigRoot: 'F:/code/ident/.harness-cc'
	});
}

function baseInput(over: Partial<LaunchInput> = {}): LaunchInput {
	return {
		projectId,
		taskId,
		agentId: 'sonnet-1',
		model: { provider: 'claude', modelId: 'claude-sonnet-4-6', tier: 'sonnet' },
		// A READ class keeps the shared project root — the fixture root_path is not a git repo,
		// and WI-2 worktree isolation is proven in launch.test.ts, not here.
		intent: 'code-read',
		budgets: { thinking: 'low', toolCalls: 5, concurrency: 1 },
		toolPolicy: { allow: ['Read'] },
		...over
	};
}

/** CREATE a real role + role_version pair so the stamped links resolve to real rows. */
async function seedRole(slug: string): Promise<{ role: string; version: string }> {
	const [r] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE role CONTENT { slug: $slug, name: $slug, purpose: "identity test role" } RETURN AFTER;`,
		{ slug }
	);
	const role = String(r[0].id);
	const [v] = await db.query<[Array<{ id: unknown }>]>(`CREATE role_version CONTENT $c RETURN AFTER;`, {
		c: {
			role: new StringRecordId(role),
			version: 1,
			prompt_core: 'x',
			prompt_sha: `sha_${slug}`,
			default_tier: 'sonnet'
		}
	});
	return { role, version: String(v[0].id) };
}

async function readSession(sessionId: string): Promise<Record<string, unknown>> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
		rid: new StringRecordId(sessionId)
	});
	return rows[0];
}

async function readSpawnDetail(sessionId: string): Promise<Record<string, unknown>> {
	const [rows] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
		`SELECT detail FROM agent_event WHERE session = $sid AND type = 'spawn' LIMIT 1;`,
		{ sid: new StringRecordId(sessionId) }
	);
	return rows[0]?.detail ?? {};
}

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
	const p = await createProject(db, { slug: 'ident', name: 'Identity Host', root_path: 'F:/code/ident' });
	projectId = p.id;
	const t = await createTask(db, {
		project: projectId,
		title: 'Unblock the stalled task',
		description: 'Read the queue and report.'
	});
	taskId = t.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('launchSession — the HR identity is stamped AT CREATE (not deferred)', () => {
	it('persists role + role_version as REAL record links when the route resolved them', async () => {
		const { role, version } = await seedRole('security-officer');
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtime(),
			input: baseInput({ roleId: role, roleVersionId: version })
		});

		const sess = await readSession(res.sessionId);
		expect(String(sess.role)).toBe(role);
		expect(String(sess.role_version)).toBe(version);

		// A true record LINK, not a string: FETCH resolves it to the role row's own fields. This
		// is what a stubDb test cannot prove — it is the whole reason this suite needs real Surreal.
		const [joined] = await db.query<[Array<{ slug: unknown; name: unknown }>]>(
			`SELECT role.slug AS slug, role.name AS name FROM $rid;`,
			{ rid: new StringRecordId(res.sessionId) }
		);
		expect(joined[0].slug).toBe('security-officer');
		expect(joined[0].name).toBe('security-officer');
	});

	it('omits both columns for an unstaffed spawn — an honest "no role", never a guess', async () => {
		const res = await launchSession({ db, bus: new EventBus(), runtime: runtime(), input: baseInput() });
		const sess = await readSession(res.sessionId);
		// option<T> rejects an explicit NULL, so "absent" must mean the key was never written.
		expect(sess.role ?? null).toBeNull();
		expect(sess.role_version ?? null).toBeNull();
	});

	it('UPSTREAM-ERROR: a malformed role id refuses BEFORE the row exists (no half-identity)', async () => {
		const before = await db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM session GROUP ALL;`);
		const countBefore = before[0][0]?.c ?? 0;

		await expect(
			launchSession({
				db,
				bus: new EventBus(),
				runtime: runtime(),
				input: baseInput({ roleId: 'not a record id' })
			})
		).rejects.toThrow();

		// The interrupt/re-run contract: a refused launch leaves NO observable half-state — no
		// phantom running session to reap, nothing for a re-run to trip over.
		const after = await db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM session GROUP ALL;`);
		expect(after[0][0]?.c ?? 0).toBe(countBefore);
	});
});

describe('launchSession — the agent identity conveys PURPOSE, not the tier bucket', () => {
	it('stamps the pool slot NAME on session.agent when the route supplied one', async () => {
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtime(),
			input: baseInput({ agentName: 'builder', agentPurpose: 'Everyday feature work, fixes and code review' })
		});
		const sess = await readSession(res.sessionId);
		expect(sess.agent).toBe('builder');
		// The slot id is the RUNTIME key and must be unchanged on the spawn request.
		expect(sess.agent).not.toBe('sonnet-1');
	});

	it('NIL config: with no agentName the slot id is stamped exactly as before (F-053)', async () => {
		const res = await launchSession({ db, bus: new EventBus(), runtime: runtime(), input: baseInput() });
		expect((await readSession(res.sessionId)).agent).toBe('sonnet-1');
	});

	it('EMPTY config: a blank agentName falls back to the slot id, never persists ""', async () => {
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtime(),
			input: baseInput({ agentName: '   ' })
		});
		expect((await readSession(res.sessionId)).agent).toBe('sonnet-1');
	});

	it('stamps a deliberately routed specialist (m0070) and omits a blank one', async () => {
		const withOne = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtime(),
			input: baseInput({ specialist: 'atelier-developer' })
		});
		expect((await readSession(withOne.sessionId)).specialist).toBe('atelier-developer');

		const blank = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtime(),
			input: baseInput({ specialist: '  ' })
		});
		expect((await readSession(blank.sessionId)).specialist ?? null).toBeNull();
	});
});

describe('launchSession — the spawn event explains WHO ran it (analytics first-class)', () => {
	it('records the slot id, name, purpose, specialist and role on the spawn agent_event', async () => {
		const { role, version } = await seedRole('release-captain');
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime: runtime(),
			input: baseInput({
				agentName: 'builder',
				agentPurpose: 'Everyday feature work, fixes and code review',
				specialist: 'atelier-developer',
				roleId: role,
				roleVersionId: version
			})
		});
		const detail = await readSpawnDetail(res.sessionId);
		// The pre-change keys are untouched…
		expect(detail.intent).toBe('code-read');
		expect(detail.reason).toBe('spawn for code-read');
		// …and the slot id survives the rename of `session.agent`, so provenance is complete.
		expect(detail.agentSlot).toBe('sonnet-1');
		expect(detail.agentName).toBe('builder');
		expect(detail.agentPurpose).toBe('Everyday feature work, fixes and code review');
		expect(detail.specialist).toBe('atelier-developer');
		expect(detail.role).toBe(role);
		expect(detail.roleVersion).toBe(version);
	});

	it('NIL: an unwired spawn emits the pre-change detail plus the slot id — no empty keys', async () => {
		const res = await launchSession({ db, bus: new EventBus(), runtime: runtime(), input: baseInput() });
		const detail = await readSpawnDetail(res.sessionId);
		expect(Object.keys(detail).sort()).toEqual(['agentSlot', 'intent', 'reason']);
		expect(detail.agentSlot).toBe('sonnet-1');
	});
});
