// Tests for the agent-library disk index + the name/slug usage bridge.
//
// Disk read: recursive scan of nested .claude/agents/**/*.md, frontmatter parse, and the
// PATH-CONFINED single-file reader (traversal fails closed). Usage bridge: the honest
// name === role.slug ⋈ session fold (calls / status split / last-used / avg duration), and
// the absences that must read as null (no role link skipped; avg null when nothing ended).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createRole } from '../workforce/repo';
import {
	agentLibraryAgentsDir,
	listLibraryAgents,
	readLibraryAgentContent
} from './library';
import { agentUsageBySlug } from './usage';

// ── Disk read (no DB) ─────────────────────────────────────────────────────────────
describe('agent-library — disk index', () => {
	let root: string;
	let claudeDir: string;
	let env: NodeJS.ProcessEnv;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'agentlib-'));
		claudeDir = join(root, '.claude');
		// Nested layout (the real library nests agents under category subdirs).
		mkdirSync(join(claudeDir, 'agents', 'development'), { recursive: true });
		mkdirSync(join(claudeDir, 'agents', 'core'), { recursive: true });
		writeFileSync(
			join(claudeDir, 'agents', 'development', 'atelier-developer.md'),
			'---\nname: atelier-developer\ntype: development\ncolor: "#FF6B35"\npriority: high\ndescription: Full-stack specialist\ncapabilities:\n  - code_generation\n  - refactoring\n---\n# Atelier Developer\n\nUse this when building Atelier features.\n'
		);
		// No `name` in frontmatter → falls back to filename stem; category from subdir.
		writeFileSync(
			join(claudeDir, 'agents', 'core', 'coder.md'),
			'---\ntype: developer\n---\nWrite clean code.\n'
		);
		env = { AGENT_LIBRARY_CLAUDE_DIR: claudeDir };
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it('resolves the agents dir from AGENT_LIBRARY_CLAUDE_DIR', () => {
		expect(agentLibraryAgentsDir(env)).toBe(join(claudeDir, 'agents'));
	});

	it('returns null when the env path has no agents/ subdir', () => {
		expect(agentLibraryAgentsDir({ AGENT_LIBRARY_CLAUDE_DIR: root })).toBeNull();
	});

	it('lists nested agents recursively and parses frontmatter + capabilities', () => {
		const list = listLibraryAgents(env);
		expect(list.map((a) => a.name)).toEqual(['atelier-developer', 'coder']); // sorted by name
		const dev = list.find((a) => a.name === 'atelier-developer')!;
		expect(dev.type).toBe('development');
		expect(dev.color).toBe('#FF6B35');
		expect(dev.priority).toBe('high');
		expect(dev.description).toBe('Full-stack specialist');
		expect(dev.capabilities).toEqual(['code_generation', 'refactoring']);
		expect(dev.relPath).toBe('development/atelier-developer.md');
	});

	it('falls back to filename stem for name and subdir for category', () => {
		const coder = listLibraryAgents(env).find((a) => a.relPath === 'core/coder.md')!;
		expect(coder.name).toBe('coder');
		expect(coder.category).toBe('core');
		expect(coder.capabilities).toEqual([]);
	});

	it('reads one agent file: body (when-to-use) + raw, by relPath', () => {
		const c = readLibraryAgentContent('development/atelier-developer.md', env)!;
		expect(c).not.toBeNull();
		expect(c.whenToUse).toContain('Use this when building Atelier features.');
		expect(c.whenToUse).not.toContain('name: atelier-developer'); // frontmatter stripped from body
		expect(c.raw).toContain('name: atelier-developer'); // raw keeps it
	});

	it('confines the path — traversal / non-.md / missing fail closed (null)', () => {
		expect(readLibraryAgentContent('../../etc/passwd', env)).toBeNull();
		expect(readLibraryAgentContent('development/../../../secret.md', env)).toBeNull();
		expect(readLibraryAgentContent('development/atelier-developer.txt', env)).toBeNull();
		expect(readLibraryAgentContent('development/nope.md', env)).toBeNull();
		expect(readLibraryAgentContent('', env)).toBeNull();
	});

	it('returns [] honestly when the library is unresolvable', () => {
		expect(listLibraryAgents({ AGENT_LIBRARY_CLAUDE_DIR: join(root, 'does-not-exist') })).toEqual([]);
	});
});

// ── Usage bridge (DB) ───────────────────────────────────────────────────────────────
describe('agent-library — usage bridge (name === role.slug ⋈ session)', () => {
	let tdb: TestDb;
	let db: Db;

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
	});
	afterAll(async () => {
		await db.close().catch(() => {});
		await tdb.teardown();
	});
	beforeEach(async () => {
		await db.query('DELETE session; DELETE role;');
	});

	async function seedSession(roleId: string, status: string, startMs: number, endMs: number | null) {
		await db.query(
			`CREATE session CONTENT {
			   kind: "task", runtime: "claude-code",
			   model: { provider: "anthropic", model_id: "claude-opus-4-8" },
			   role: $role, status: $status,
			   started_at: <datetime>$start
			   ${endMs != null ? ', ended_at: <datetime>$end' : ''}
			 } RETURN NONE;`,
			{
				role: new StringRecordId(roleId),
				status,
				start: new Date(startMs).toISOString(),
				...(endMs != null ? { end: new Date(endMs).toISOString() } : {})
			}
		);
	}

	it('folds calls / status split / last-used / avg duration per slug', async () => {
		const role = await createRole(db, {
			slug: 'atelier-developer',
			name: 'Atelier Developer',
			purpose: 'build'
		});
		const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
		await seedSession(role.id, 'done', t0, t0 + 60_000); // 60s
		await seedSession(role.id, 'failed', t0 + 3_600_000, t0 + 3_600_000 + 120_000); // 120s, newer
		await seedSession(role.id, 'running', t0 + 7_200_000, null); // no end → not in avg

		const map = await agentUsageBySlug(db);
		const u = map.get('atelier-developer')!;
		expect(u).toBeTruthy();
		expect(u.calls).toBe(3);
		expect(u.done).toBe(1);
		expect(u.failed).toBe(1);
		expect(u.running).toBe(1);
		expect(u.roleName).toBe('Atelier Developer');
		// last-used = the newest start (the running session at t0+2h)
		expect(new Date(u.lastUsedAt!).getTime()).toBe(t0 + 7_200_000);
		// avg over the two sessions that ended: (60s + 120s)/2 = 90s
		expect(u.avgDurationMs).toBe(90_000);
	});

	it('avg duration is null when no session both started and ended', async () => {
		const role = await createRole(db, { slug: 'lonely', name: 'Lonely', purpose: 'x' });
		await seedSession(role.id, 'running', Date.now(), null);
		const u = (await agentUsageBySlug(db)).get('lonely')!;
		expect(u.calls).toBe(1);
		expect(u.avgDurationMs).toBeNull();
	});

	it('skips sessions with no role link (cannot bridge) and leaves unmatched names absent', async () => {
		await db.query(
			`CREATE session CONTENT {
			   kind: "chat", runtime: "claude-code",
			   model: { provider: "anthropic", model_id: "x" }, status: "done"
			 } RETURN NONE;`
		);
		const map = await agentUsageBySlug(db);
		expect(map.size).toBe(0); // a roleless session contributes nothing
		expect(map.get('atelier-developer')).toBeUndefined(); // unmapped → loader shows "no runs yet"
	});
});
