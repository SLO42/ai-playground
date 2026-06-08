import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { readCatalog, syncScope, syncState, type SyncScope } from './sync';
import {
	ConfigValidationError,
	StaleConfirmError,
	applyEdit,
	planEdit,
	validateContent,
	validateMcpJson,
	validateSettings
} from './write';
import { watchScope } from './watch';

// TASK 2.11 VERIFY (D-010): config MANAGER read-write. The headline checks:
//   (1) a config edit VALIDATES → WRITES → RE-SYNCS the cc_* mirror, with a mandatory
//       diff + confirm step (planEdit produces the diff + confirm token; applyEdit
//       requires it and refuses a stale confirm — "never silently overwrite a hand-edit").
//   (2) invalid config (incl. the v1 mcp__server__:* colon mistake) is rejected before
//       any byte hits disk.
//   (3) an external on-disk edit is detected by the WATCHER.
// Everything read back comes from the LIVE DB (F-008); the .claude tree is a test fixture.
//
// NO live model is needed for the file round-trip + watcher. The deferred LIVE proof is the
// read-back: launch a real session after an edit and assert behavior reflects it (needs a
// CLAUDE_CODE_OAUTH_TOKEN) — built logic is verified here against disk + the mirror.

let tdb: TestDb;
let db: Db;

let root: string;
let claudeDir: string;
let settingsPath: string;
let scope: SyncScope;

const VALID_SETTINGS = JSON.stringify(
	{
		permissions: { allow: ['Bash', 'Read'], deny: ['mcp__github__*'] },
		env: { FOO: 'bar' },
		hooks: {
			PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 10 }] }]
		}
	},
	null,
	2
);

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

	root = mkdtempSync(join(tmpdir(), 'cc-write-'));
	claudeDir = join(root, '.claude');
	mkdirSync(join(claudeDir, 'agents'), { recursive: true });
	settingsPath = join(claudeDir, 'settings.json');
	writeFileSync(settingsPath, VALID_SETTINGS);
	scope = { kind: 'project', claudeDir };
	await syncScope(db, scope);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (root) rmSync(root, { recursive: true, force: true });
});

// ── Validators ────────────────────────────────────────────────────────────────────────

describe('validators reject invalid config before any write (D-010)', () => {
	it('rejects the v1 mcp__server__:* colon mistake in a permission rule', () => {
		const bad = JSON.stringify({ permissions: { deny: ['mcp__github__:*'] } });
		const res = validateSettings(bad);
		expect(res.ok).toBe(false);
		expect(res.issues.some((i) => /colon/.test(i.message))).toBe(true);
	});

	it('accepts a valid mcp__server__tool / mcp__server__* rule', () => {
		expect(validateSettings(JSON.stringify({ permissions: { deny: ['mcp__github__*'] } })).ok).toBe(true);
		expect(
			validateSettings(JSON.stringify({ permissions: { allow: ['mcp__fs__read_file'] } })).ok
		).toBe(true);
	});

	it('rejects malformed JSON and non-object roots', () => {
		expect(validateSettings('{ not json').ok).toBe(false);
		expect(validateSettings('[]').ok).toBe(false);
	});

	it('rejects permissions.deny that is not an array', () => {
		expect(validateSettings(JSON.stringify({ permissions: { deny: 'Bash' } })).ok).toBe(false);
	});

	it('validates .mcp.json server transport', () => {
		expect(validateMcpJson(JSON.stringify({ mcpServers: { fs: { command: 'npx' } } })).ok).toBe(true);
		expect(validateMcpJson(JSON.stringify({ mcpServers: { x: { type: 'carrier-pigeon' } } })).ok).toBe(
			false
		);
		expect(validateMcpJson(JSON.stringify({ mcpServers: { y: {} } })).ok).toBe(false);
	});

	it('validates agent/skill frontmatter requires a name; CLAUDE.md is free text', () => {
		expect(validateContent('agent', '---\nname: coder\n---\nbody').ok).toBe(true);
		expect(validateContent('agent', 'no frontmatter here').ok).toBe(false);
		expect(validateContent('skill', '---\ndescription: missing name\n---\n').ok).toBe(false);
		expect(validateContent('claude_md', 'anything at all').ok).toBe(true);
	});
});

// ── The mandatory diff + confirm round-trip ─────────────────────────────────────────────

describe('planEdit → applyEdit: validate → diff + confirm → write → re-sync (D-010)', () => {
	it('planEdit produces a diff + confirm token and writes nothing', () => {
		const before = readFileSync(settingsPath, 'utf8');
		const next = JSON.stringify(
			{
				permissions: { allow: ['Bash', 'Read', 'Edit'], deny: ['mcp__github__*'] },
				env: { FOO: 'bar' },
				hooks: {
					PreToolUse: [
						{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 10 }] }
					]
				}
			},
			null,
			2
		);
		const plan = planEdit({ kind: 'settings', filePath: settingsPath, content: next });
		expect(plan.validation.ok).toBe(true);
		expect(plan.diff.unchanged).toBe(false);
		// The diff shows the added permission line.
		expect(plan.diff.hunks.some((h) => h.op === '+' && /Edit/.test(h.line))).toBe(true);
		expect(plan.confirmToken).toBeTruthy();
		// Disk is untouched by planEdit.
		expect(readFileSync(settingsPath, 'utf8')).toBe(before);
	});

	it('applyEdit with the plan token writes the file AND re-syncs the mirror', async () => {
		const next = JSON.stringify(
			{
				permissions: { allow: ['Bash', 'Read', 'Edit'], deny: ['mcp__github__*'] },
				env: { FOO: 'bar' },
				hooks: {
					PreToolUse: [
						{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 10 }] }
					]
				}
			},
			null,
			2
		);
		const plan = planEdit({ kind: 'settings', filePath: settingsPath, content: next });
		const res = await applyEdit(db, {
			kind: 'settings',
			filePath: settingsPath,
			content: next,
			confirmToken: plan.confirmToken,
			scope
		});
		expect(res.bytesWritten).toBeGreaterThan(0);

		// (a) the file on disk reflects the edit.
		expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.allow).toEqual([
			'Bash',
			'Read',
			'Edit'
		]);
		// (b) the cc_* MIRROR was re-synced — the new permission is in the DB.
		const [rows] = await db.query<[Array<{ permissions?: Record<string, unknown> }>]>(
			`SELECT permissions FROM cc_settings;`
		);
		expect((rows[0].permissions?.allow as string[]) ?? []).toEqual(['Bash', 'Read', 'Edit']);
		// (c) drift state is back to "synced".
		expect((await syncState(db, scope)).status).toBe('synced');
	});

	it('applyEdit REFUSES a stale confirm — never silently overwrites a hand-edit (D-010)', async () => {
		const next = JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2);
		const plan = planEdit({ kind: 'settings', filePath: settingsPath, content: next });

		// A hand-edit lands on disk AFTER the operator generated the diff.
		writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash', 'WebFetch'] } }, null, 2));

		await expect(
			applyEdit(db, {
				kind: 'settings',
				filePath: settingsPath,
				content: next,
				confirmToken: plan.confirmToken, // stale — file changed under us
				scope
			})
		).rejects.toBeInstanceOf(StaleConfirmError);

		// The hand-edit is intact — our content was NOT written.
		expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.allow).toEqual([
			'Bash',
			'WebFetch'
		]);
	});

	it('applyEdit REFUSES invalid content even with a fresh token', async () => {
		const bad = JSON.stringify({ permissions: { deny: ['mcp__x__:*'] } });
		const plan = planEdit({ kind: 'settings', filePath: settingsPath, content: bad });
		expect(plan.validation.ok).toBe(false);
		await expect(
			applyEdit(db, {
				kind: 'settings',
				filePath: settingsPath,
				content: bad,
				confirmToken: plan.confirmToken,
				scope
			})
		).rejects.toBeInstanceOf(ConfigValidationError);
	});

	it('can create a NEW agent file then re-sync surfaces it in the catalog', async () => {
		const agentPath = join(claudeDir, 'agents', 'reviewer.md');
		const content = '---\nname: reviewer\ndescription: reviews diffs\ncategory: qa\n---\nbody\n';
		const plan = planEdit({ kind: 'agent', filePath: agentPath, content });
		expect(plan.validation.ok).toBe(true);
		await applyEdit(db, {
			kind: 'agent',
			filePath: agentPath,
			content,
			confirmToken: plan.confirmToken,
			scope
		});
		const catalog = await readCatalog(db);
		expect(catalog[0].agents.some((a) => a.name === 'reviewer')).toBe(true);
	});
});

// ── The external-edit watcher ───────────────────────────────────────────────────────────

describe('watchScope detects an external on-disk edit (D-010)', () => {
	it('fires onChange when settings.json is edited outside our write path', async () => {
		const fired: string[] = [];
		const handle = watchScope({
			claudeDir,
			debounceMs: 30,
			onChange: (ev) => fired.push(ev.digest)
		});
		try {
			const baseline = handle.currentDigest();
			// External edit (simulating an editor / another tool touching the file).
			writeFileSync(
				settingsPath,
				JSON.stringify({ permissions: { allow: ['Bash', 'Read', 'Edit', 'Glob'] } }, null, 2)
			);
			// Wait for the debounced fire (poll up to ~2s).
			await waitFor(() => fired.length > 0, 2000);
			expect(fired.length).toBeGreaterThan(0);
			expect(handle.currentDigest()).not.toBe(baseline);
		} finally {
			handle.close();
		}
	});

	it('does NOT fire for a no-op touch (same content → same digest)', async () => {
		const fired: number[] = [];
		const handle = watchScope({
			claudeDir,
			debounceMs: 30,
			onChange: () => fired.push(Date.now())
		});
		try {
			const same = readFileSync(settingsPath, 'utf8');
			writeFileSync(settingsPath, same); // rewrite identical bytes
			await sleep(300);
			expect(fired.length).toBe(0);
		} finally {
			handle.close();
		}
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) return;
		await sleep(20);
	}
}
