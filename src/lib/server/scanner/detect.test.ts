import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectEcosystem, slugify, readRepoUrl, buildCommandFor } from './detect';

// TASK 1.1 (detect half): pure ecosystem/mod detection over fixture directories.
// No DB, no spawn — fixtures are real temp dirs with marker files.

let workdir: string;

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), 'scanner-detect-'));
});
afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

function fixture(name: string, files: Record<string, string>): string {
	const dir = join(workdir, name);
	mkdirSync(dir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe('slugify', () => {
	it('lowercases and snake-cases', () => {
		expect(slugify('My Cool Project')).toBe('my_cool_project');
		expect(slugify('rounds-mod')).toBe('rounds_mod');
		expect(slugify('ai-playground-v2')).toBe('ai_playground_v2');
	});
	it('prefixes when starting with a digit (record-id safety)', () => {
		expect(slugify('3d-engine')).toBe('p_3d_engine');
	});
});

describe('detectEcosystem — language/build detection', () => {
	it('detects a TypeScript/npm project', () => {
		const dir = fixture('ts-app', {
			'package.json': '{"name":"x"}',
			'tsconfig.json': '{}'
		});
		const d = detectEcosystem(dir);
		expect(d.ecosystem).toContain('typescript');
		expect(d.buildTool).toBe('npm');
		expect(d.testCommand).toBe('npm test');
		expect(d.slug).toBe('ts_app');
		expect(d.name).toBe('ts-app');
	});

	it('detects plain JavaScript when no tsconfig', () => {
		const dir = fixture('js-app', { 'package.json': '{}' });
		const d = detectEcosystem(dir);
		expect(d.ecosystem).toContain('javascript');
		expect(d.ecosystem).not.toContain('typescript');
		expect(d.buildTool).toBe('npm');
	});

	it('detects Rust/cargo', () => {
		const dir = fixture('rust-lib', { 'Cargo.toml': '[package]' });
		const d = detectEcosystem(dir);
		expect(d.ecosystem).toEqual(['rust']);
		expect(d.buildTool).toBe('cargo');
		expect(d.testCommand).toBe('cargo test');
	});

	it('detects Java/gradle', () => {
		const dir = fixture('java-app', { 'build.gradle': '' });
		const d = detectEcosystem(dir);
		expect(d.ecosystem).toContain('java');
		expect(d.buildTool).toBe('gradle');
	});

	it('detects C#/dotnet via .csproj', () => {
		const dir = fixture('cs-app', { 'App.csproj': '<Project/>' });
		const d = detectEcosystem(dir);
		expect(d.ecosystem).toContain('csharp');
		expect(d.buildTool).toBe('dotnet');
	});

	it('detects Python', () => {
		const dir = fixture('py-app', { 'pyproject.toml': '' });
		const d = detectEcosystem(dir);
		expect(d.ecosystem).toContain('python');
		expect(d.testCommand).toBe('pytest');
	});

	it('returns an empty ecosystem for an unrecognized directory', () => {
		const dir = fixture('mystery', { 'README.md': 'hi' });
		const d = detectEcosystem(dir);
		expect(d.ecosystem).toEqual([]);
		expect(d.buildTool).toBeUndefined();
	});

	it('throws on a non-directory / missing path', () => {
		expect(() => detectEcosystem(join(workdir, 'does-not-exist'))).toThrow();
	});
});

describe('detectEcosystem — mod framework detection', () => {
	it('detects a BepInEx/Thunderstore mod (SWIP profile shape)', () => {
		const dir = fixture('rounds-mod', {
			'src/SWIP.csproj': '<Project/>',
			'thunderstore/manifest.json': '{"name":"SWIP"}'
		});
		const d = detectEcosystem(dir);
		expect(d.ecosystem).toContain('csharp');
		expect(d.ecosystem).toContain('bepinex');
		expect(d.modType).toBe('bepinex');
	});

	it('detects a NeoForge Minecraft mod', () => {
		const dir = fixture('mc-mod', {
			'build.gradle': '',
			'src/main/resources/META-INF/neoforge.mods.toml': ''
		});
		const d = detectEcosystem(dir);
		expect(d.ecosystem).toContain('java');
		expect(d.modType).toBe('neoforge');
		expect(d.ecosystem).toContain('neoforge');
	});
});

describe('readRepoUrl', () => {
	it('reads a remote url from .git/config', () => {
		const dir = fixture('with-git', {
			'.git/config': '[remote "origin"]\n\turl = https://github.com/x/y.git\n'
		});
		expect(readRepoUrl(dir)).toBe('https://github.com/x/y.git');
	});
	it('returns undefined when no git config', () => {
		const dir = fixture('no-git', { 'package.json': '{}' });
		expect(readRepoUrl(dir)).toBeUndefined();
	});
});

describe('buildCommandFor — bare detected tool → REAL build invocation (release-gate safety)', () => {
	it("maps 'dotnet' to a real `dotnet build` (NOT the bare no-op launcher)", () => {
		const cmd = buildCommandFor('dotnet');
		expect(cmd).not.toBeNull();
		expect(cmd!.file).toBe('dotnet');
		expect(cmd!.args[0]).toBe('build'); // bare `dotnet` exits 0 without building — must carry 'build'.
		expect(cmd!.args.length).toBeGreaterThan(0);
	});

	it('maps every buildable detected tool to a multi-token invocation (verb present)', () => {
		for (const [tool, file] of [
			['npm', 'npm'],
			['cargo', 'cargo'],
			['gradle', 'gradle'],
			['maven', 'mvn'],
			['go', 'go']
		] as const) {
			const cmd = buildCommandFor(tool);
			expect(cmd, tool).not.toBeNull();
			expect(cmd!.file).toBe(file);
			expect(cmd!.args.length, tool).toBeGreaterThan(0); // never the bare tool with no args.
		}
	});

	it("returns null for the un-buildable 'pip' (Python has no single standard build) — FAIL CLOSED", () => {
		expect(buildCommandFor('pip')).toBeNull();
	});

	it('returns null for unknown/empty/nil tools (shadow paths) — FAIL CLOSED', () => {
		expect(buildCommandFor('frobnicate')).toBeNull();
		expect(buildCommandFor('')).toBeNull();
		expect(buildCommandFor('   ')).toBeNull();
		expect(buildCommandFor(undefined)).toBeNull();
		expect(buildCommandFor(null)).toBeNull();
	});

	it('is case-insensitive and trims whitespace around the tool name', () => {
		expect(buildCommandFor('  DotNet ')!.args[0]).toBe('build');
	});

	it('returns a fresh args array each call (no shared mutable state)', () => {
		const a = buildCommandFor('dotnet')!;
		a.args.push('--mutated');
		const b = buildCommandFor('dotnet')!;
		expect(b.args).not.toContain('--mutated');
	});
});
