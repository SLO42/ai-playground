import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	detectEcosystem,
	slugify,
	readRepoUrl,
	buildCommandFor,
	testCommandFor,
	npmScriptCommandFor
} from './detect';

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

describe('testCommandFor — bare tool → REAL test command ONLY when a test target exists (HB-2)', () => {
	it("dotnet + a *.Tests.csproj → 'dotnet test'", () => {
		const dir = fixture('cs-with-tests', {
			'src/App.csproj': '<Project/>',
			'test/App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"/>'
		});
		expect(testCommandFor('dotnet', dir)).toBe('dotnet test');
	});

	it('dotnet + a csproj referencing a test SDK (no Tests-named file) → cmd', () => {
		const dir = fixture('cs-test-sdk', {
			'App.csproj':
				'<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0"/></ItemGroup></Project>'
		});
		expect(testCommandFor('dotnet', dir)).toBe('dotnet test');
	});

	it('dotnet + a csproj referencing xunit → cmd', () => {
		const dir = fixture('cs-xunit', {
			'App.csproj': '<Project><PackageReference Include="xunit" Version="2.6.0"/></Project>'
		});
		expect(testCommandFor('dotnet', dir)).toBe('dotnet test');
	});

	it("dotnet with a plain *.csproj but NO test project → null (ROUNDS shape — honest skip)", () => {
		const dir = fixture('cs-no-tests', { 'src/SWIP.csproj': '<Project Sdk="Microsoft.NET.Sdk"/>' });
		expect(testCommandFor('dotnet', dir)).toBeNull();
	});

	it('dotnet with NO csproj at all → null', () => {
		const dir = fixture('cs-empty', { 'README.md': 'hi' });
		expect(testCommandFor('dotnet', dir)).toBeNull();
	});

	it("npm with a real scripts.test → 'npm test'", () => {
		const dir = fixture('npm-real-test', {
			'package.json': JSON.stringify({ scripts: { test: 'vitest run' } })
		});
		expect(testCommandFor('npm', dir)).toBe('npm test');
	});

	it('npm with the npm-init default no-test stub → null (would always exit 1)', () => {
		const dir = fixture('npm-stub-test', {
			'package.json': JSON.stringify({
				scripts: { test: 'echo "Error: no test specified" && exit 1' }
			})
		});
		expect(testCommandFor('npm', dir)).toBeNull();
	});

	it('npm with no scripts.test → null', () => {
		const dir = fixture('npm-no-test', { 'package.json': JSON.stringify({ scripts: { build: 'x' } }) });
		expect(testCommandFor('npm', dir)).toBeNull();
	});

	it("cargo with a Cargo.toml → 'cargo test' (cargo test is 0 with zero tests)", () => {
		const dir = fixture('cargo-crate', { 'Cargo.toml': '[package]' });
		expect(testCommandFor('cargo', dir)).toBe('cargo test');
	});

	it("go with a go.mod → 'go test ./...' (go test is 0 with zero tests)", () => {
		const dir = fixture('go-mod', { 'go.mod': 'module x' });
		expect(testCommandFor('go', dir)).toBe('go test ./...');
	});

	it('gradle / maven / pip → null (no cheap no-false-fail probe — fail-closed skip)', () => {
		const g = fixture('gradle-app', { 'build.gradle': '' });
		expect(testCommandFor('gradle', g)).toBeNull();
		const m = fixture('maven-app', { 'pom.xml': '<project/>' });
		expect(testCommandFor('maven', m)).toBeNull();
		const p = fixture('pip-app', { 'pyproject.toml': '' });
		expect(testCommandFor('pip', p)).toBeNull();
	});

	it('unknown / nil tool or nil root → null (shadow paths) — FAIL CLOSED', () => {
		const dir = fixture('any-dir', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
		expect(testCommandFor('frobnicate', dir)).toBeNull();
		expect(testCommandFor('', dir)).toBeNull();
		expect(testCommandFor('   ', dir)).toBeNull();
		expect(testCommandFor(undefined, dir)).toBeNull();
		expect(testCommandFor(null, dir)).toBeNull();
		expect(testCommandFor('npm', undefined)).toBeNull();
		expect(testCommandFor('npm', null)).toBeNull();
		expect(testCommandFor('npm', '')).toBeNull();
	});

	it('is case-insensitive / trims the tool name', () => {
		const dir = fixture('cargo-case', { 'Cargo.toml': '[package]' });
		expect(testCommandFor('  CARGO ', dir)).toBe('cargo test');
	});

	it('never returns a bare/again-unbuildable token (always a multi-token command or null)', () => {
		const dir = fixture('cargo-bare-check', { 'Cargo.toml': '[package]' });
		const cmd = testCommandFor('cargo', dir);
		expect(cmd).not.toBeNull();
		expect(cmd!.trim().split(/\s+/).length).toBeGreaterThan(1); // 'cargo test', not bare 'cargo'.
	});
});

// PCG-1 — the lint/typecheck resolver the pre-commit gate uses. The rule it encodes: `npm run lint`
// on a package with no `lint` script exits NON-ZERO ("Missing script"), which as a gate step would
// be a FALSE RED failing every project that simply does not lint. So it resolves ONLY a declared,
// non-empty script and honestly returns null otherwise.
describe('npmScriptCommandFor — an npm script step resolves ONLY when the script is declared', () => {
	it('a declared script → `npm run <script>`', () => {
		const dir = fixture('npm-scripts', {
			'package.json': JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } })
		});
		expect(npmScriptCommandFor(dir, 'lint')).toBe('npm run lint');
		expect(npmScriptCommandFor(dir, 'typecheck')).toBe('npm run typecheck');
	});

	it('EMPTY: an undeclared script → null (never a false RED for a project that does not lint)', () => {
		const dir = fixture('npm-scripts-partial', {
			'package.json': JSON.stringify({ scripts: { build: 'vite build' } })
		});
		expect(npmScriptCommandFor(dir, 'lint')).toBeNull();
		expect(npmScriptCommandFor(dir, 'typecheck')).toBeNull();
	});

	it('EMPTY: a declared-but-blank script, and a package with no scripts block at all → null', () => {
		const blank = fixture('npm-blank-script', {
			'package.json': JSON.stringify({ scripts: { lint: '   ' } })
		});
		const none = fixture('npm-no-scripts', { 'package.json': JSON.stringify({ name: 'x' }) });
		expect(npmScriptCommandFor(blank, 'lint')).toBeNull();
		expect(npmScriptCommandFor(none, 'lint')).toBeNull();
	});

	it('UPSTREAM ERROR: malformed JSON / no package.json / nil inputs → null, never a throw', () => {
		const bad = fixture('npm-bad-json', { 'package.json': '{ not json' });
		const empty = fixture('npm-nothing', { 'README.md': '#' });
		expect(npmScriptCommandFor(bad, 'lint')).toBeNull();
		expect(npmScriptCommandFor(empty, 'lint')).toBeNull();
		expect(npmScriptCommandFor(undefined, 'lint')).toBeNull();
		expect(npmScriptCommandFor(null, 'lint')).toBeNull();
		expect(npmScriptCommandFor('', 'lint')).toBeNull();
		expect(npmScriptCommandFor(join(tmpdir(), 'pcg-absent-dir-77'), 'lint')).toBeNull();
		expect(npmScriptCommandFor(empty, '  ')).toBeNull();
	});
});
