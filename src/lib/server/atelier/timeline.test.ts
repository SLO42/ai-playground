// G-C TIMELINE VERIFY — the atelier-wide merged timeline end-to-end against a REAL throwaway
// SurrealDB (D-038 integration vs real DB). Asserts:
//   • CROSS-SOURCE timestamp ordering: message / peer_message / panel_verdict / role_event rows
//     interleave correctly, newest-first, regardless of which table they came from.
//   • SCOPE filter: global includes role_events + every project's rows; a per-project scope
//     filters message (via session.project) + peer_message + panel_verdict to that project and
//     EXCLUDES role_events (project-less workforce audit) and other projects' rows.
//   • PAGINATION bound: a page is at most pageSize; nextBefore pages older deterministically with
//     no dup/skip across the boundary.
//   • The new TURN-KIND mappings: a panel_verdict → a 'verdict' turn (decision+reasons), a
//     role_event → a 'role_event' turn (op+actor), a peer_message → a 'communication' turn, and
//     a pushed-in message origin → 'communication' (the shared classifier, reused).
//   • SHADOW PATHS: empty atelier (honest empty), a bad project scope id (fail-loud at D-016).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { IdentifierError } from '../db/validate';
import { readAtelierTimeline, DEFAULT_PAGE_SIZE } from './timeline';

let tdb: TestDb;
let db: Db;
let seq = 0;

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
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

// ── Seed helpers ─────────────────────────────────────────────────────────────────────
// Timestamps are stamped EXPLICITLY (a fixed base + per-row offset) so the merge order is
// deterministic and independent of insert order / wall-clock.

// Anchor the seed times to ~1 hour ago so every row falls INSIDE the default 7-day window
// (the offsets are seconds apart, deterministically ordered, all recent).
const BASE = Date.now() - 60 * 60 * 1000;
function ts(offsetSec: number): Date {
	return new Date(BASE + offsetSec * 1000);
}

async function freshProject(): Promise<string> {
	const slug = `atl_proj_${++seq}`;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $slug) SET slug = $slug, name = $slug, root_path = "/tmp", status = "active" RETURN id;`,
		{ slug }
	);
	return String(rows[0].id);
}

async function freshRole(): Promise<string> {
	const slug = `atl_role_${++seq}`;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('role', $slug) SET slug = $slug, name = $slug, purpose = "test", status = "active" RETURN id;`,
		{ slug }
	);
	return String(rows[0].id);
}

async function freshRoleVersion(roleId: string): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE role_version SET role = type::thing('role', $r), version = $v, prompt_core = "x",
			prompt_sha = $sha, default_tier = "opus" RETURN id;`,
		{ r: roleId.split(':')[1], v: ++seq, sha: `sha_${seq}` }
	);
	return String(rows[0].id);
}

async function freshSession(opts: { project?: string; role?: string } = {}): Promise<string> {
	const set: string[] = [`kind = "task"`, `status = "running"`, `model = { provider: 'claude', model_id: 'claude-test' }`];
	const bind: Record<string, unknown> = {};
	if (opts.project) {
		set.push(`project = type::thing('project', $pj)`);
		bind.pj = opts.project.split(':')[1];
	}
	if (opts.role) {
		set.push(`role = type::thing('role', $rl)`);
		bind.rl = opts.role.split(':')[1];
	}
	const [rows] = await db.query<[Array<{ id: unknown }>]>(`CREATE session SET ${set.join(', ')} RETURN id;`, bind);
	return String(rows[0].id);
}

async function seedMessage(
	sessionId: string,
	opts: { role?: string; kind?: string; origin?: string; content?: string; at: Date }
): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE message SET session = type::thing('session', $s), role = $role, kind = $kind,
			origin = $origin, content = $content, at = $at RETURN id;`,
		{
			s: sessionId.split(':')[1],
			role: opts.role ?? 'assistant',
			kind: opts.kind ?? 'assistant_text',
			origin: opts.origin ?? 'agent',
			content: opts.content ?? 'hello',
			at: opts.at
		}
	);
	return String(rows[0].id);
}

async function seedPeerMessage(
	from: string,
	to: string,
	opts: { project?: string; body?: string; status?: string; created_at: Date }
): Promise<string> {
	const set: string[] = [
		`from_session = type::thing('session', $f)`,
		`to_kind = "session"`,
		`to_session = type::thing('session', $t)`,
		`body = $body`,
		`status = $status`,
		`created_at = $at`
	];
	const bind: Record<string, unknown> = {
		f: from.split(':')[1],
		t: to.split(':')[1],
		body: opts.body ?? '[FENCED] peer note',
		status: opts.status ?? 'delivered',
		at: opts.created_at
	};
	if (opts.project) {
		set.push(`project = type::thing('project', $pj)`);
		bind.pj = opts.project.split(':')[1];
	}
	const [rows] = await db.query<[Array<{ id: unknown }>]>(`CREATE peer_message SET ${set.join(', ')} RETURN id;`, bind);
	return String(rows[0].id);
}

async function seedVerdict(
	sessionId: string,
	roleId: string,
	roleVersionId: string,
	opts: { project?: string; verdict?: string; reasons?: string[]; confidence?: string; at: Date }
): Promise<string> {
	const set: string[] = [
		`artifact = type::thing('session', $sess)`,
		`artifact_kind = "review_proposal"`,
		`validator_session = type::thing('session', $sess)`,
		`validator_kind = "catalog_role"`,
		`role = type::thing('role', $role)`,
		`role_version = type::thing('role_version', $rv)`,
		`verdict = $v`,
		`reasons = $reasons`,
		`at = $at`
	];
	const bind: Record<string, unknown> = {
		sess: sessionId.split(':')[1],
		role: roleId.split(':')[1],
		rv: roleVersionId.split(':')[1],
		v: opts.verdict ?? 'approve',
		reasons: opts.reasons ?? ['looks correct', 'tests pass'],
		at: opts.at
	};
	if (opts.project) {
		set.push(`project = type::thing('project', $pj)`);
		bind.pj = opts.project.split(':')[1];
	}
	if (opts.confidence) {
		set.push(`confidence = $conf`);
		bind.conf = opts.confidence;
	}
	const [rows] = await db.query<[Array<{ id: unknown }>]>(`CREATE panel_verdict SET ${set.join(', ')} RETURN id;`, bind);
	return String(rows[0].id);
}

async function seedRoleEvent(roleId: string, opts: { op?: string; detail?: Record<string, unknown>; at: Date }): Promise<string> {
	const set: string[] = [`role = type::thing('role', $r)`, `op = $op`, `at = $at`];
	const bind: Record<string, unknown> = { r: roleId.split(':')[1], op: opts.op ?? 'staffed', at: opts.at };
	if (opts.detail) {
		set.push(`detail = $detail`);
		bind.detail = opts.detail;
	}
	const [rows] = await db.query<[Array<{ id: unknown }>]>(`CREATE role_event SET ${set.join(', ')} RETURN id;`, bind);
	return String(rows[0].id);
}

// ── (1) Cross-source ordering + turn-kind mappings ─────────────────────────────────────

describe('readAtelierTimeline — cross-source merge, ordering, turn kinds', () => {
	it('merges all four sources newest-first and maps each to its turn kind', async () => {
		const proj = await freshProject();
		const role = await freshRole();
		const rv = await freshRoleVersion(role);
		const sessionA = await freshSession({ project: proj, role });
		const sessionB = await freshSession({ project: proj });

		// Interleaved across sources, in scrambled insert order; the merge must sort by time.
		const mMsg = await seedMessage(sessionA, { content: 'agent prose', at: ts(10) }); // assistant
		const mPeer = await seedPeerMessage(sessionA, sessionB, { project: proj, created_at: ts(40) });
		const mVerdict = await seedVerdict(sessionA, role, rv, {
			project: proj,
			verdict: 'pushback',
			reasons: ['missing test', 'edge case unhandled'],
			confidence: 'high',
			at: ts(30)
		});
		const mRole = await seedRoleEvent(role, { op: 'swap', detail: { from: 1, to: 2 }, at: ts(20) });

		const page = await readAtelierTimeline(db, { scope: { kind: 'global' } });
		expect(page.complete).toBe(true);

		// Newest-first: peer(40) > verdict(30) > role(20) > msg(10).
		const ids = page.entries.map((e) => e.id);
		expect(ids).toEqual([mPeer, mVerdict, mRole, mMsg]);

		// Turn-kind mappings.
		const byId = new Map(page.entries.map((e) => [e.id, e]));
		expect(byId.get(mMsg)!.turn.kind).toBe('assistant');
		expect(byId.get(mPeer)!.turn.kind).toBe('communication');
		expect(byId.get(mPeer)!.turn.origin).toBe('agent');
		expect(byId.get(mVerdict)!.turn.kind).toBe('verdict');
		expect(byId.get(mVerdict)!.turn.verdict).toEqual({
			decision: 'pushback',
			confidence: 'high',
			reasons: ['missing test', 'edge case unhandled']
		});
		expect(byId.get(mRole)!.turn.kind).toBe('role_event');
		expect(byId.get(mRole)!.turn.op).toBe('swap');

		// Sources + ISO timestamps present (F-013 — serializable strings).
		expect(byId.get(mPeer)!.source).toBe('peer_message');
		expect(byId.get(mVerdict)!.source).toBe('panel_verdict');
		expect(byId.get(mRole)!.source).toBe('role_event');
		for (const e of page.entries) expect(typeof e.at).toBe('string');
	});

	it('a pushed-in message origin (operator interject) maps to a communication turn', async () => {
		const proj = await freshProject();
		const session = await freshSession({ project: proj });
		const id = await seedMessage(session, {
			role: 'system',
			kind: 'assistant_text',
			origin: 'operator',
			content: 'pause and re-check the auth flow',
			at: ts(100)
		});
		const page = await readAtelierTimeline(db, { scope: { kind: 'project', project: proj } });
		const entry = page.entries.find((e) => e.id === id);
		expect(entry).toBeDefined();
		expect(entry!.turn.kind).toBe('communication');
		expect(entry!.turn.origin).toBe('operator');
	});
});

// ── (2) Scope filter: global vs per-project ────────────────────────────────────────────

describe('readAtelierTimeline — scope filter (global vs per-project)', () => {
	it('a per-project scope filters to that project and excludes role_events + other projects', async () => {
		const projX = await freshProject();
		const projY = await freshProject();
		const role = await freshRole();
		const sessX = await freshSession({ project: projX });
		const sessY = await freshSession({ project: projY });

		const xMsg = await seedMessage(sessX, { content: 'x prose', at: ts(210) });
		const yMsg = await seedMessage(sessY, { content: 'y prose', at: ts(220) });
		const xPeer = await seedPeerMessage(sessX, sessX, { project: projX, created_at: ts(230) });
		const yPeer = await seedPeerMessage(sessY, sessY, { project: projY, created_at: ts(240) });
		const roleEv = await seedRoleEvent(role, { op: 'created', at: ts(250) });

		// Per-project X: includes xMsg + xPeer; EXCLUDES y* (other project) AND the role_event.
		const pageX = await readAtelierTimeline(db, { scope: { kind: 'project', project: projX } });
		const xIds = new Set(pageX.entries.map((e) => e.id));
		expect(xIds.has(xMsg)).toBe(true);
		expect(xIds.has(xPeer)).toBe(true);
		expect(xIds.has(yMsg)).toBe(false);
		expect(xIds.has(yPeer)).toBe(false);
		expect(xIds.has(roleEv)).toBe(false);
		// No role_event source leaked into a project scope.
		expect(pageX.entries.every((e) => e.source !== 'role_event')).toBe(true);

		// Global: includes BOTH projects' rows AND the role_event.
		const pageG = await readAtelierTimeline(db, { scope: { kind: 'global' } });
		const gIds = new Set(pageG.entries.map((e) => e.id));
		expect(gIds.has(xMsg)).toBe(true);
		expect(gIds.has(yMsg)).toBe(true);
		expect(gIds.has(roleEv)).toBe(true);
	});
});

// ── (3) Pagination bound ───────────────────────────────────────────────────────────────

describe('readAtelierTimeline — pagination bound (newest-first, cursor)', () => {
	it('a page is at most pageSize and nextBefore pages older with no dup/skip', async () => {
		const proj = await freshProject();
		const session = await freshSession({ project: proj });
		// 5 messages at distinct, increasing times.
		const made: string[] = [];
		for (let i = 0; i < 5; i++) {
			made.push(await seedMessage(session, { content: `m${i}`, at: ts(300 + i) }));
		}
		// page size 2 over this project (only these 5 rows exist for this fresh project's sessions).
		const p1 = await readAtelierTimeline(db, { scope: { kind: 'project', project: proj }, pageSize: 2 });
		expect(p1.entries.length).toBe(2);
		expect(p1.nextBefore).not.toBeNull();
		// Newest two: m4(304), m3(303).
		expect(p1.entries.map((e) => e.id)).toEqual([made[4], made[3]]);

		const p2 = await readAtelierTimeline(db, {
			scope: { kind: 'project', project: proj },
			pageSize: 2,
			before: p1.nextBefore!
		});
		expect(p2.entries.map((e) => e.id)).toEqual([made[2], made[1]]);
		// No overlap across the page boundary.
		const overlap = p2.entries.filter((e) => p1.entries.some((x) => x.id === e.id));
		expect(overlap).toEqual([]);

		const p3 = await readAtelierTimeline(db, {
			scope: { kind: 'project', project: proj },
			pageSize: 2,
			before: p2.nextBefore!
		});
		expect(p3.entries.map((e) => e.id)).toEqual([made[0]]);
		expect(p3.nextBefore).toBeNull(); // last page — short of a full page
	});

	it('the default page size is the spec default (~50)', () => {
		expect(DEFAULT_PAGE_SIZE).toBe(50);
	});
});

// ── (4) Shadow paths ───────────────────────────────────────────────────────────────────

describe('readAtelierTimeline — shadow paths', () => {
	it('an empty project scope yields an honest empty page (complete, no entries)', async () => {
		const proj = await freshProject(); // no sessions/rows
		const page = await readAtelierTimeline(db, { scope: { kind: 'project', project: proj } });
		expect(page.entries).toEqual([]);
		expect(page.nextBefore).toBeNull();
		expect(page.complete).toBe(true);
		expect(page.failedSources).toEqual([]);
	});

	it('a malformed project scope id fails loud at the D-016 boundary (not honest-empty)', async () => {
		await expect(
			readAtelierTimeline(db, { scope: { kind: 'project', project: 'not a record id !!' } })
		).rejects.toBeInstanceOf(IdentifierError);
	});
});
