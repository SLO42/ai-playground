// TASK 13.5 findings 1+2 — regression tests for the config-editor write boundary.
//
// Finding 1 (SECURITY medium): the confinement ANCHOR (claudeDir) was taken from an
// untrusted form field and never checked against the real catalog scopes — a crafted
// POST could anchor the editor anywhere on disk and write settings/agent/skill files
// there. `resolveConfigTargetFromCatalog` must reject any claudeDir not in the
// server-side scope set (fail closed). These tests FAIL against the old code, which
// resolved whatever claudeDir the request supplied.
//
// Finding 2 (SECURITY low): the old isInside() was lexical (path.resolve) — a symlink
// INSIDE the scope could redirect the write outside it. Confinement is now realpath-
// aware (reused guardrails resolveConfinedTarget): the symlink test below PASSES the
// old lexical check and must now be refused.
//
// All offline/synchronous — a real temp directory tree, no DB, no server.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	resolveConfigTarget,
	resolveConfigTargetFromCatalog,
	matchAllowedScope,
	ConfigTargetError,
	type AllowedScope
} from './config-target';

let root: string;
let claudeDir: string; // the LEGIT project scope (in the catalog)
let evilDir: string; // a real directory that is NOT a catalog scope
let scopes: AllowedScope[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'cfg-target-'));
	claudeDir = join(root, 'proj', '.claude');
	mkdirSync(join(claudeDir, 'agents'), { recursive: true });
	mkdirSync(join(claudeDir, 'skills'), { recursive: true });
	writeFileSync(join(claudeDir, 'settings.json'), '{}', 'utf8');
	writeFileSync(join(claudeDir, 'agents', 'helper.md'), '---\nname: helper\n---\n', 'utf8');
	evilDir = join(root, 'evil', '.claude');
	mkdirSync(evilDir, { recursive: true });
	scopes = [{ kind: 'project', path: claudeDir, project: 'project:demo' }];
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('resolveConfigTargetFromCatalog — the anchor comes from the CATALOG, never the form (finding 1)', () => {
	it('REJECTS a forged claudeDir that is not a catalog scope — even a real directory (fail closed)', () => {
		for (const kind of ['settings', 'mcp_json', 'claude_md'] as const) {
			expect(() => resolveConfigTargetFromCatalog(scopes, { kind, claudeDir: evilDir })).toThrow(
				ConfigTargetError
			);
		}
		expect(() =>
			resolveConfigTargetFromCatalog(scopes, {
				kind: 'agent',
				claudeDir: evilDir,
				explicitPath: join(evilDir, 'agents', 'x.md')
			})
		).toThrow(ConfigTargetError);
	});

	it('REJECTS every claudeDir when the catalog is empty (no scopes ⇒ no writes)', () => {
		expect(() =>
			resolveConfigTargetFromCatalog([], { kind: 'settings', claudeDir })
		).toThrow(ConfigTargetError);
	});

	it('resolves a LEGIT catalog scope, carrying the catalog kind/project (not form fields)', () => {
		const t = resolveConfigTargetFromCatalog(scopes, { kind: 'settings', claudeDir });
		expect(t.filePath).toBe(join(claudeDir, 'settings.json'));
		expect(t.scope.kind).toBe('project');
		expect(t.scope.project).toBe('project:demo');
	});

	it('anchors resolution on the CATALOG path — the submitted claudeDir is only a lookup key', () => {
		// Same scope submitted with flipped separators + case: matched (Windows-insensitive),
		// but the resolved file path derives from the catalog's canonical spelling.
		const variant = claudeDir.replace(/\\/g, '/').toUpperCase();
		const matched = matchAllowedScope(scopes, variant);
		expect(matched?.path).toBe(claudeDir);
		const t = resolveConfigTargetFromCatalog(scopes, { kind: 'claude_md', claudeDir: variant });
		expect(t.filePath).toBe(join(root, 'proj', 'CLAUDE.md'));
	});

	it('matchAllowedScope rejects empty / unrelated paths', () => {
		expect(matchAllowedScope(scopes, '')).toBeNull();
		expect(matchAllowedScope(scopes, '   ')).toBeNull();
		expect(matchAllowedScope(scopes, evilDir)).toBeNull();
	});
});

describe('resolveConfigTarget — realpath-aware confinement (finding 2, D-018)', () => {
	it('still rejects a lexical `..` escape for agent/skill explicit paths', () => {
		expect(() =>
			resolveConfigTarget({
				kind: 'agent',
				claudeDir,
				scopeKind: 'project',
				explicitPath: join(claudeDir, 'agents', '..', '..', '..', 'evil', 'x.md')
			})
		).toThrow(ConfigTargetError);
	});

	it('rejects an explicit path under a DIFFERENT directory outright', () => {
		expect(() =>
			resolveConfigTarget({
				kind: 'skill',
				claudeDir,
				scopeKind: 'project',
				explicitPath: join(evilDir, 'skills', 'x.md')
			})
		).toThrow(ConfigTargetError);
	});

	it('REJECTS a symlink inside the scope whose REAL target is outside (the lexical-check bypass)', () => {
		const outside = join(root, 'outside-secret.md');
		writeFileSync(outside, 'OUTSIDE', 'utf8');
		const link = join(claudeDir, 'agents', 'link.md');
		try {
			symlinkSync(outside, link);
		} catch {
			return; // symlinks unsupported in this environment — covered by the .. tests
		}
		// Lexically `link` is inside the scope (the OLD check allowed it); the realpath-aware
		// confinement must refuse, because the write would land OUTSIDE the scope.
		expect(() =>
			resolveConfigTarget({ kind: 'agent', claudeDir, scopeKind: 'project', explicitPath: link })
		).toThrow(ConfigTargetError);
	});

	it('allows a not-yet-existing file under the scope (a create) — settings/new agent', () => {
		const t = resolveConfigTarget({
			kind: 'agent',
			claudeDir,
			scopeKind: 'project',
			explicitPath: join(claudeDir, 'agents', 'brand-new.md')
		});
		expect(t.filePath).toBe(join(claudeDir, 'agents', 'brand-new.md'));
	});

	it('fails CLOSED when the scope directory itself does not exist (unresolvable root)', () => {
		const ghost = join(root, 'ghost', '.claude');
		expect(() =>
			resolveConfigTarget({ kind: 'settings', claudeDir: ghost, scopeKind: 'project' })
		).toThrow(ConfigTargetError);
	});
});
