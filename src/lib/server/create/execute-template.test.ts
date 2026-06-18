import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { getProject } from '../projects/repo';
import { listTasksByProject } from '../tasks/repo';
import { getCapabilityNeeds } from '../workforce/capability-match';
import { getPm } from '../projects/pm-repo';
import {
	executeTemplateCreation,
	TemplateNotFoundError,
	ProjectExistsError,
	ScaffoldPathError,
	ScaffoldSecretError,
	ScaffoldFailedError,
	ConcurrentCreateError
} from './execute';
import * as templates from './templates';
import type { ProjectTemplate } from './templates';
import type { CommandRunner } from '../orchestrator/post-task';

// CT-3 (CREATE-SPEC) — the TEMPLATE EXECUTE half. Run vs a REAL throwaway SurrealDB + a REAL temp
// CODE_ROOT (real git init / real scaffold writing the REAL template content / real scanProject
// ingest — NO agent spend; the file-map comes from the pure template.generate). Covers the happy
// path (PM + no-PM, REAL content materialized — the key difference from the AI path's stubs), the
// honest unknown-template error, idempotent same-slug fail-closed, and the four redTeam invariants:
// D-018 `../` param-path-escape, D-026 secret-in-generated-content, F-040 concurrent same-slug, and
// the F-008 mid-scaffold-failure → no phantom row + incident.

let tdb: TestDb;
let db: Db;
let codeRoot: string;

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
	codeRoot = realpathSync(await mkdtemp(join(tmpdir(), 'ct3-root-')));
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (codeRoot) await rm(codeRoot, { recursive: true, force: true }).catch(() => {});
});

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/** A synthetic hostile template for the redTeam cases (spied into getTemplate). */
function hostileTemplate(id: string, fileMap: Record<string, string>): ProjectTemplate {
	return {
		id,
		name: 'Hostile',
		description: 'redTeam fixture',
		language: 'TypeScript',
		icon: 'x',
		tags: [],
		params: [],
		generate: () => ({ ...fileMap })
	};
}

describe('executeTemplateCreation — happy path (PM requested, fork 3)', () => {
	it('materializes REAL template content on disk, git-commits, ingests from DISK, hires PM', async () => {
		const res = await executeTemplateCreation(db, {
			templateId: 'go',
			name: 'ct3 go pm',
			description: 'A small Go service.',
			params: { projectType: 'binary', includeCI: false, moduleName: 'example.com/ct3' },
			codeRoot,
			pm: { name: 'Ada', answers: [] }
		});

		expect(res.projectId).toBe('project:ct3_go_pm');
		expect(res.taskStatus).toBe('proposed'); // PM requested → 'proposed' (D-039 panel).
		expect(res.commitSha).toBeTruthy();

		// REAL template content on disk (NOT a placeholder stub — the key difference from the AI path).
		const root = join(codeRoot, 'ct3_go_pm');
		expect(await exists(join(root, '.git'))).toBe(true);
		const goMod = await readFile(join(root, 'go.mod'), 'utf8');
		expect(goMod).toContain('module example.com/ct3'); // the REAL generated content, verbatim.
		const mainGo = await readFile(join(root, 'main.go'), 'utf8');
		expect(mainGo).toContain('package main');
		expect(mainGo).toContain('Hello from ct3 go pm'); // name flowed into the real file body.

		// F-008: row reflects DISK (ecosystem detected from the real scaffold), root_path is on-disk.
		const row = await getProject(db, res.projectId);
		expect(row).not.toBeNull();
		expect(row!.root_path).toBe(realpathSync(root));
		expect(row!.create_status).toBe('complete');
		// Plan macro derived from the template + brief (honest, not fabricated boilerplate).
		expect(row!.plan?.purpose).toBe('A small Go service.');

		// Capability needs mapped from template.language (no fabricated defect classes — F-008).
		const needs = await getCapabilityNeeds(db, res.projectId);
		expect(needs.languages).toContain('go');
		expect(needs.defect_classes).toEqual([]);

		// PM hired with a charter derived from the template + brief.
		const pm = await getPm(db, res.projectId);
		expect(pm).not.toBeNull();
		expect(pm!.charter).toContain('ct3 go pm');
		expect(res.pm?.pm.name).toBe('Ada');
	}, 60_000);
});

describe('executeTemplateCreation — happy path (no PM)', () => {
	it('no PM requested → no PM hired, founding tasks honestly empty (registry templates carry none)', async () => {
		const res = await executeTemplateCreation(db, {
			templateId: 'blank',
			name: 'ct3 blank',
			description: 'An empty project.',
			codeRoot
		});
		expect(res.taskStatus).toBe('ready'); // no PM → 'ready'.
		expect(res.pm).toBeUndefined();
		expect(res.taskIds.length).toBe(0); // honest: the blank template provides no founding tasks.
		const root = join(codeRoot, 'ct3_blank');
		const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8');
		expect(claude).toContain('An empty project.'); // REAL template content materialized.
		expect(await getPm(db, res.projectId)).toBeNull();
		expect((await listTasksByProject(db, res.projectId)).length).toBe(0);
	}, 60_000);
});

describe('executeTemplateCreation — unknown template (honest named error)', () => {
	it('an unknown template id throws TemplateNotFoundError before any disk touch / lock', async () => {
		await expect(
			executeTemplateCreation(db, { templateId: 'does-not-exist', name: 'ct3 unknown', codeRoot })
		).rejects.toBeInstanceOf(TemplateNotFoundError);
		expect(await getProject(db, 'project:ct3_unknown')).toBeNull();
		expect(await exists(join(codeRoot, 'ct3_unknown'))).toBe(false);
	}, 60_000);
});

describe('executeTemplateCreation — idempotent fail-closed', () => {
	it('a second create with the same slug throws ProjectExistsError, never overwrites', async () => {
		await executeTemplateCreation(db, { templateId: 'blank', name: 'ct3 dup', codeRoot });
		await expect(
			executeTemplateCreation(db, { templateId: 'blank', name: 'ct3 dup', codeRoot })
		).rejects.toBeInstanceOf(ProjectExistsError);
		// The first scaffold survives untouched (no last-writer overwrite).
		expect(await exists(join(codeRoot, 'ct3_dup', '.git'))).toBe(true);
	}, 60_000);
});

describe('executeTemplateCreation — redTeam D-018 param injects `../` into a generated path', () => {
	// The shared pipeline's resolveEntry re-confines EVERY generated path key under the project root,
	// so even if a template emitted an escaping key (a param flowing `../` into a path), it fails
	// CLOSED (ScaffoldPathError) before any escaping write — no phantom row, nothing written outside.
	it('an escaping generated path fails closed (ScaffoldPathError), no row, nothing escapes', async () => {
		const spy = vi
			.spyOn(templates, 'getTemplate')
			.mockReturnValue(
				hostileTemplate('go', { 'CLAUDE.md': '# ok\n', '../../etc/pwned.txt': 'escaped' })
			);
		try {
			await expect(
				executeTemplateCreation(db, { templateId: 'go', name: 'ct3 escape', codeRoot })
			).rejects.toBeInstanceOf(ScaffoldPathError);
		} finally {
			spy.mockRestore();
		}
		expect(await getProject(db, 'project:ct3_escape')).toBeNull();
		expect(await exists(join(codeRoot, 'ct3_escape'))).toBe(false);
		expect(await exists(join(codeRoot, '..', '..', 'etc', 'pwned.txt'))).toBe(false);
	}, 60_000);
});

describe('executeTemplateCreation — redTeam D-026 param becomes a literal secret in a generated file', () => {
	// A param value that lands a literal credential into a generated file's CONTENT must HARD-throw at
	// the per-file scaffold screen (ScaffoldSecretError) before the file is written — env NAMES only.
	it('a literal secret in generated content HARD-throws (ScaffoldSecretError), no row, no dir', async () => {
		// Token assembled at runtime so the source carries no contiguous provider-token pattern.
		const secret = 'sk-' + 'ant-' + 'deadbeefdeadbeefdeadbeef';
		const spy = vi
			.spyOn(templates, 'getTemplate')
			.mockReturnValue(
				hostileTemplate('blank', { 'CLAUDE.md': `# x\nuse ${secret} for auth\n` })
			);
		try {
			await expect(
				executeTemplateCreation(db, { templateId: 'blank', name: 'ct3 secret', codeRoot })
			).rejects.toBeInstanceOf(ScaffoldSecretError);
		} finally {
			spy.mockRestore();
		}
		expect(await getProject(db, 'project:ct3_secret')).toBeNull();
		expect(await exists(join(codeRoot, 'ct3_secret'))).toBe(false);
	}, 60_000);
});

describe('executeTemplateCreation — redTeam F-040 concurrent same-slug (loser never deletes winner)', () => {
	it('a second same-slug create while the lock is held fails closed and CANNOT delete the first scaffold', async () => {
		// Winner: a real, committed project.
		const wres = await executeTemplateCreation(db, {
			templateId: 'blank',
			name: 'ct3 toctou',
			codeRoot
		});
		expect(wres.projectId).toBe('project:ct3_toctou');
		expect(await exists(join(codeRoot, 'ct3_toctou', '.git'))).toBe(true);

		// Exercise the LOCK path (the TOCTOU window): delete the row, re-hold the lock as an in-flight
		// winner, then run the loser. It must fail CLOSED and never rm -rf the winner's live scaffold.
		await db.query(`DELETE project:ct3_toctou;`);
		await db.query(`CREATE create_lock:ct3_toctou CONTENT { holder: $h } RETURN AFTER;`, {
			h: 'winner-in-flight'
		});

		await expect(
			executeTemplateCreation(db, { templateId: 'blank', name: 'ct3 toctou', codeRoot })
		).rejects.toBeInstanceOf(ConcurrentCreateError);

		// The winner's live scaffold + .git SURVIVE — ownership-gated cleanup never touched a dir the
		// loser did not create this run (the exact corruption F-040 forbids).
		expect(await exists(join(codeRoot, 'ct3_toctou', '.git'))).toBe(true);
		expect(await exists(join(codeRoot, 'ct3_toctou', 'CLAUDE.md'))).toBe(true);

		await db.query(`DELETE create_lock:ct3_toctou;`);
	}, 60_000);
});

describe('executeTemplateCreation — honest partial failure (F-008)', () => {
	it('a git failure mid-scaffold → ScaffoldFailedError + incident + NO phantom row + dir removed', async () => {
		const failingRun: CommandRunner = async (file, args) => {
			if (file === 'git' && args.includes('commit')) {
				return { code: 1, stdout: '', stderr: 'simulated commit failure' };
			}
			return { code: 0, stdout: '', stderr: '' };
		};
		const before = await countIncidents();
		await expect(
			executeTemplateCreation(db, {
				templateId: 'blank',
				name: 'ct3 partial',
				codeRoot,
				run: failingRun
			})
		).rejects.toBeInstanceOf(ScaffoldFailedError);

		expect(await getProject(db, 'project:ct3_partial')).toBeNull(); // no phantom row (F-008).
		expect((await listTasksByProject(db, 'project:ct3_partial')).length).toBe(0);
		expect(await exists(join(codeRoot, 'ct3_partial'))).toBe(false); // partial dir removed.
		expect(await countIncidents()).toBe(before + 1); // incident logged (NEVER silent).
	}, 60_000);
});

/** Count `incident` rows (the honest-failure signal). */
async function countIncidents(): Promise<number> {
	const [rows] = await db.query<[Array<{ n: number }>]>(`SELECT count() AS n FROM incident GROUP ALL;`);
	return rows.length ? rows[0].n : 0;
}
