import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { StringRecordId } from 'surrealdb';
import type { RuntimeEvent } from '../runtime/index';
import {
	captureSnapshotSafe,
	projectRelativePath,
	fileTurnFromToolUse,
	captureFileTurnSnapshot
} from './file-snapshot-capture';
import { normFileSnapshot } from './file-snapshot';

// FILE-SNAPSHOT-SPEC §3 (FS-2) — the capture-point glue. Pure helpers are unit-tested without a DB;
// the best-effort wrapper + the transcript pairing orchestrator are integration-tested vs a REAL
// throwaway SurrealDB so the D-026/D-016/F-008/F-014 rails are proven against the real schema.

// ─────────────────────────────────────────────────────────────────────────────────────
// PURE — projectRelativePath (D-016 coercion of an ABSOLUTE tool path).
// ─────────────────────────────────────────────────────────────────────────────────────

describe('projectRelativePath (D-016 — relativize an absolute tool path)', () => {
	const root = process.platform === 'win32' ? 'C:\\proj\\demo' : '/proj/demo';
	it('relativizes an in-project absolute path, normalizing separators to /', () => {
		const abs = join(root, 'src', 'a.ts');
		expect(projectRelativePath(abs, root)).toBe('src/a.ts');
	});
	it('returns null for a path OUTSIDE the project root (honest, not an escape)', () => {
		const outside = process.platform === 'win32' ? 'C:\\other\\x.ts' : '/other/x.ts';
		expect(projectRelativePath(outside, root)).toBeNull();
	});
	it('returns null for the root itself and for nil/empty inputs (shadow paths)', () => {
		expect(projectRelativePath(root, root)).toBeNull();
		expect(projectRelativePath('', root)).toBeNull();
		expect(projectRelativePath(join(root, 'a.ts'), '')).toBeNull();
		// @ts-expect-error nil shadow path
		expect(projectRelativePath(undefined, root)).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────
// PURE — fileTurnFromToolUse (which tool turns are file turns + what content).
// ─────────────────────────────────────────────────────────────────────────────────────

describe('fileTurnFromToolUse (§3 b — file-turn detection)', () => {
	it('Write → wrote disposition with the new content', () => {
		const t = fileTurnFromToolUse('Write', { file_path: '/p/a.ts', content: 'hi\n' });
		expect(t).toEqual({ path: '/p/a.ts', content: 'hi\n', tool: 'Write', disposition: 'wrote' });
	});
	it('Edit → wrote disposition, content from new_string', () => {
		const t = fileTurnFromToolUse('Edit', { file_path: '/p/b.ts', new_string: 'after', old_string: 'before' });
		expect(t?.disposition).toBe('wrote');
		expect(t?.content).toBe('after');
	});
	it('Read → read disposition with empty content (body comes in the result)', () => {
		const t = fileTurnFromToolUse('Read', { file_path: '/p/c.ts' });
		expect(t).toEqual({ path: '/p/c.ts', content: '', tool: 'Read', disposition: 'read' });
	});
	it('a write tool with no content yields an honest empty body, never a fabricated one', () => {
		const t = fileTurnFromToolUse('Write', { file_path: '/p/d.ts' });
		expect(t?.content).toBe('');
	});
	it('non-file tools (Bash/Grep/Glob) are NOT file turns', () => {
		expect(fileTurnFromToolUse('Bash', { command: 'ls' })).toBeNull();
		expect(fileTurnFromToolUse('Grep', { pattern: 'x' })).toBeNull();
		expect(fileTurnFromToolUse('Glob', { pattern: '**' })).toBeNull();
	});
	it('a file tool with no path is not a file turn (nil shadow path)', () => {
		expect(fileTurnFromToolUse('Read', {})).toBeNull();
		expect(fileTurnFromToolUse('Write', { content: 'x' })).toBeNull();
		expect(fileTurnFromToolUse('', { file_path: '/p/x' })).toBeNull();
		expect(fileTurnFromToolUse('Read', null)).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────
// captureSnapshotSafe — NEVER throws (F-014), even on a bad path / bad db.
// ─────────────────────────────────────────────────────────────────────────────────────

describe('captureSnapshotSafe (best-effort, never throws — F-014)', () => {
	it('swallows a SnapshotPathError (escaping path) and returns null', async () => {
		// A null db would throw inside captureSnapshot AFTER the path check; the path check fires first
		// for an escaping path, so this proves the wrapper catches the named error without a DB at all.
		const res = await captureSnapshotSafe(null as never, { path: '../../etc/passwd', content: 'x' });
		expect(res).toBeNull();
	});
	it('swallows a DB error (null db on a valid path) and returns null', async () => {
		const res = await captureSnapshotSafe(null as never, { path: 'ok.ts', content: 'x' });
		expect(res).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────
// INTEGRATION — the transcript pairing orchestrator vs a REAL SurrealDB.
// ─────────────────────────────────────────────────────────────────────────────────────

const toolUse = (name: string, args: unknown): RuntimeEvent => ({ type: 'tool_call', name, args, needsConfirm: false });
const toolResult = (name: string, output: string): RuntimeEvent => ({ type: 'tool_result', name, ok: true, output });

describe('captureFileTurnSnapshot (integration, real SurrealDB)', () => {
	let tdb: TestDb;
	let db: Db;
	let root: string;

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
		root = realpathSync(await mkdtemp(join(tmpdir(), 'fs2-')));
	}, 90_000);

	afterAll(async () => {
		await db?.close().catch(() => {});
		await tdb?.teardown();
		if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
	});

	async function snapFor(capturedBy: string) {
		const [rows] = await db.query<[Record<string, unknown>[]]>(
			`SELECT * FROM file_snapshot WHERE captured_by = $by;`,
			{ by: capturedBy }
		);
		return rows.map(normFileSnapshot);
	}

	it('Write tool_use → captures the new content linked to the message turn', async () => {
		const abs = join(root, 'src', 'w.ts');
		const pending = await captureFileTurnSnapshot(db, {
			ev: toolUse('Write', { file_path: abs, content: 'export const x = 1;\n' }),
			messageId: 'message:w1',
			projectRoot: root,
			projectId: 'project:demo',
			pendingReadAbsPath: null
		});
		expect(pending).toBeNull(); // a write does not defer
		const snaps = await snapFor('message:w1');
		expect(snaps).toHaveLength(1);
		expect(snaps[0].path).toBe('src/w.ts');
		expect(snaps[0].content).toBe('export const x = 1;\n');
	});

	it('Read tool_use defers, the paired tool_result captures what the agent SAW', async () => {
		const abs = join(root, 'src', 'r.ts');
		// 1. Read tool_use → defers, returns the absolute path as the pending pairing.
		const pending = await captureFileTurnSnapshot(db, {
			ev: toolUse('Read', { file_path: abs }),
			messageId: 'message:r1',
			projectRoot: root,
			projectId: 'project:demo',
			pendingReadAbsPath: null
		});
		expect(pending).toBe(abs);
		// No snapshot yet on the tool_use turn.
		expect(await snapFor('message:r1')).toHaveLength(0);
		// 2. The following tool_result carries the body → captured, linked to the RESULT turn.
		const after = await captureFileTurnSnapshot(db, {
			ev: toolResult('Read', 'the file body the agent saw\n'),
			messageId: 'message:r2',
			projectRoot: root,
			projectId: 'project:demo',
			pendingReadAbsPath: pending
		});
		expect(after).toBeNull(); // pairing consumed
		const snaps = await snapFor('message:r2');
		expect(snaps).toHaveLength(1);
		expect(snaps[0].path).toBe('src/r.ts');
		expect(snaps[0].content).toBe('the file body the agent saw\n');
	});

	it('RED-TEAM (D-026): a secret an agent wrote is screened (marker), never raw', async () => {
		const abs = join(root, '.env');
		const secret = '-----BEGIN RSA PRIVATE KEY-----\nMIIDEEPSECRET\n-----END RSA PRIVATE KEY-----\n';
		await captureFileTurnSnapshot(db, {
			ev: toolUse('Write', { file_path: abs, content: secret }),
			messageId: 'message:sec1',
			projectRoot: root,
			projectId: 'project:demo',
			pendingReadAbsPath: null
		});
		const snaps = await snapFor('message:sec1');
		expect(snaps).toHaveLength(1);
		expect(snaps[0].is_marker).toBe(true);
		expect(snaps[0].content).not.toContain('MIIDEEPSECRET');
	});

	it('a file OUTSIDE the project root is honestly NOT snapshotted (D-016)', async () => {
		const outside = process.platform === 'win32' ? 'C:\\elsewhere\\x.ts' : '/elsewhere/x.ts';
		const pending = await captureFileTurnSnapshot(db, {
			ev: toolUse('Write', { file_path: outside, content: 'data' }),
			messageId: 'message:out1',
			projectRoot: root,
			projectId: 'project:demo',
			pendingReadAbsPath: null
		});
		expect(pending).toBeNull();
		expect(await snapFor('message:out1')).toHaveLength(0); // no fabricated/escaping snapshot
	});

	it('a non-file tool (Bash) snapshots nothing and clears the pending pairing', async () => {
		const pending = await captureFileTurnSnapshot(db, {
			ev: toolUse('Bash', { command: 'echo hi' }),
			messageId: 'message:bash1',
			projectRoot: root,
			projectId: 'project:demo',
			pendingReadAbsPath: '/p/stale.ts'
		});
		expect(pending).toBeNull();
		expect(await snapFor('message:bash1')).toHaveLength(0);
	});

	it('a non-tool event (log/thinking) clears a pending Read pairing (no mis-pair)', async () => {
		const pending = await captureFileTurnSnapshot(db, {
			ev: { type: 'log', message: 'thinking aloud' },
			messageId: 'message:log1',
			projectRoot: root,
			projectId: 'project:demo',
			pendingReadAbsPath: '/p/stale.ts'
		});
		expect(pending).toBeNull();
		expect(await snapFor('message:log1')).toHaveLength(0);
	});

	it('a tool_result with NO pending Read snapshots nothing (a non-file tool result)', async () => {
		const pending = await captureFileTurnSnapshot(db, {
			ev: toolResult('Bash', 'command output'),
			messageId: 'message:res1',
			projectRoot: root,
			projectId: 'project:demo',
			pendingReadAbsPath: null
		});
		expect(pending).toBeNull();
		expect(await snapFor('message:res1')).toHaveLength(0);
	});

	it('dedup: re-capturing the same Write content stores ONE row (content-addressed)', async () => {
		const abs = join(root, 'dup2.ts');
		const base = { content: 'same body\n', projectRoot: root, projectId: 'project:demo', pendingReadAbsPath: null };
		await captureFileTurnSnapshot(db, { ev: toolUse('Write', { file_path: abs, content: 'same body\n' }), messageId: 'message:d1', ...base });
		await captureFileTurnSnapshot(db, { ev: toolUse('Write', { file_path: abs, content: 'same body\n' }), messageId: 'message:d2', ...base });
		const [rows] = await db.query<[{ c: number }[]]>(
			`SELECT count() AS c FROM file_snapshot WHERE path = 'dup2.ts' AND project = $p GROUP ALL;`,
			{ p: new StringRecordId('project:demo') }
		);
		expect(rows[0].c).toBe(1); // identical content for the same path+project = one row
	});
});
