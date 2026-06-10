import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpmPublisherAdapter, NPM_SECRET } from './adapter';
import { validatePackage, validatePackageName, isValidVersion } from './spec';
import { computePackPlan, tarballName, flattenName } from './pack';
import { buildNpmPublishPlan, REDACTED_TOKEN } from './api';
import { runPublisherContract } from '../contract';
import { resolverForAdapter } from '../secrets';

// TASK 12.3 VERIFY — the DEEPENED npm PublisherAdapter: real pack selection + name/version rules +
// the exact `npm publish` invocation, all dry-run-by-default with the secret redacted (D-026). No
// real external call occurs.

let pkgDir: string;
let filesDir: string;
let scopedDir: string;
let emptyDir: string;
let badDir: string;

beforeAll(async () => {
	// A package WITHOUT a files array (ignore-fallback path) + a node_modules to prove it's dropped.
	pkgDir = await mkdtemp(join(tmpdir(), 'atelier-npm-pkg-'));
	await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'mypkg', version: '1.2.3', main: 'index.js' }), 'utf8');
	await writeFile(join(pkgDir, 'index.js'), 'module.exports = 1;', 'utf8');
	await writeFile(join(pkgDir, 'README.md'), '# mypkg', 'utf8');
	await writeFile(join(pkgDir, 'package-lock.json'), '{}', 'utf8'); // always-ignored
	await mkdir(join(pkgDir, 'node_modules', 'dep'), { recursive: true });
	await writeFile(join(pkgDir, 'node_modules', 'dep', 'x.js'), 'x', 'utf8'); // always-ignored

	// A package WITH a files allow-list → only dist/ + always-included ship.
	filesDir = await mkdtemp(join(tmpdir(), 'atelier-npm-files-'));
	await writeFile(
		join(filesDir, 'package.json'),
		JSON.stringify({ name: 'libby', version: '0.1.0', files: ['dist'] }),
		'utf8'
	);
	await mkdir(join(filesDir, 'dist'), { recursive: true });
	await writeFile(join(filesDir, 'dist', 'index.js'), 'export default 1;', 'utf8');
	await writeFile(join(filesDir, 'dist', 'index.d.ts'), 'declare const x: number;', 'utf8');
	await writeFile(join(filesDir, 'src.ts'), 'const x = 1;', 'utf8'); // excluded by files[]
	await writeFile(join(filesDir, 'LICENSE'), 'MIT', 'utf8'); // always-included

	// A scoped package (defaults to restricted access).
	scopedDir = await mkdtemp(join(tmpdir(), 'atelier-npm-scoped-'));
	await writeFile(
		join(scopedDir, 'package.json'),
		JSON.stringify({ name: '@acme/widget', version: '2.0.0-rc.1', files: ['index.js'] }),
		'utf8'
	);
	await writeFile(join(scopedDir, 'index.js'), '1', 'utf8');

	emptyDir = await mkdtemp(join(tmpdir(), 'atelier-npm-empty-'));

	// A private + bad-name + bad-version package — every blocker at once.
	badDir = await mkdtemp(join(tmpdir(), 'atelier-npm-bad-'));
	await writeFile(
		join(badDir, 'package.json'),
		JSON.stringify({ name: 'Bad Name!', version: 'not-semver', private: true }),
		'utf8'
	);
});

afterAll(async () => {
	for (const d of [pkgDir, filesDir, scopedDir, emptyDir, badDir]) {
		await rm(d, { recursive: true, force: true }).catch(() => {});
	}
});

describe('npm spec — name/version/package validation', () => {
	it('validates names (scoped + unscoped + the npm rules)', () => {
		expect(validatePackageName('mypkg').ok).toBe(true);
		expect(validatePackageName('@scope/pkg')).toEqual({ ok: true, scope: '@scope' });
		expect(validatePackageName('UpperCase').ok).toBe(false);
		expect(validatePackageName('has space').ok).toBe(false);
		expect(validatePackageName('_leadingUnderscore').ok).toBe(false);
		expect(validatePackageName('').ok).toBe(false);
		expect(validatePackageName('a'.repeat(215)).ok).toBe(false);
	});

	it('validates SemVer (the publishable subset)', () => {
		expect(isValidVersion('1.0.0')).toBe(true);
		expect(isValidVersion('2.3.4-rc.1')).toBe(true);
		expect(isValidVersion('1.0.0+build.5')).toBe(true);
		expect(isValidVersion('1.0')).toBe(false);
		expect(isValidVersion('01.0.0')).toBe(false);
		expect(isValidVersion('x')).toBe(false);
	});

	it('collects EVERY blocker for a private + bad-name + bad-version package', () => {
		const v = validatePackage({ name: 'Bad Name!', version: 'nope', private: true });
		expect(v.ok).toBe(false);
		expect(v.blockers.join(' ')).toMatch(/private/);
		expect(v.blockers.join(' ')).toMatch(/name/);
		expect(v.blockers.join(' ')).toMatch(/version/);
	});

	it('resolves publishConfig.registry + scoped access default', () => {
		const v = validatePackage({ name: '@acme/widget', version: '1.0.0', publishConfig: { registry: 'https://npm.acme.dev/' } });
		expect(v.ok).toBe(true);
		expect(v.registry).toBe('https://npm.acme.dev/');
		expect(v.access).toBe('restricted'); // scoped defaults to restricted
		expect(v.warnings.join(' ')).toMatch(/restricted/);

		const pub = validatePackage({ name: '@acme/widget', version: '1.0.0', publishConfig: { access: 'public' } });
		expect(pub.access).toBe('public');
	});
});

describe('npm pack — file selection semantics', () => {
	it('flattens scoped names + names the tarball', () => {
		expect(flattenName('@scope/pkg')).toBe('scope-pkg');
		expect(flattenName('plain')).toBe('plain');
		expect(tarballName('@scope/pkg', '1.0.0')).toBe('scope-pkg-1.0.0.tgz');
	});

	it('files[] allow-list ships ONLY matching paths + always-included', async () => {
		const pkg = { name: 'libby', version: '0.1.0', files: ['dist'] };
		const plan = await computePackPlan({ cwd: filesDir, pkg });
		expect(plan.usedFilesArray).toBe(true);
		expect(plan.files).toContain('package.json'); // always
		expect(plan.files).toContain('LICENSE'); // always-included
		expect(plan.files).toContain('dist/index.js'); // matched by files[]
		expect(plan.files).toContain('dist/index.d.ts');
		expect(plan.files).not.toContain('src.ts'); // excluded by files[]
		expect(plan.tarball).toBe('libby-0.1.0.tgz');
	});

	it('no files[] → ignore-fallback drops node_modules + lockfiles, keeps source', async () => {
		const pkg = { name: 'mypkg', version: '1.2.3', main: 'index.js' };
		const plan = await computePackPlan({ cwd: pkgDir, pkg });
		expect(plan.usedFilesArray).toBe(false);
		expect(plan.files).toContain('index.js');
		expect(plan.files).toContain('README.md');
		expect(plan.files).toContain('package.json');
		expect(plan.files).not.toContain('package-lock.json'); // always-ignored
		expect(plan.files.some((f) => f.startsWith('node_modules/'))).toBe(false);
	});

	it('handles a `**` .gitignore glob without crashing (live-found regex bug)', async () => {
		// A `.gitignore` containing `**/node_modules` once produced an invalid `/^**/.../` regex.
		const dir = await mkdtemp(join(tmpdir(), 'atelier-npm-glob-'));
		await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'g', version: '1.0.0' }), 'utf8');
		await writeFile(join(dir, 'keep.js'), '1', 'utf8');
		await writeFile(join(dir, '.gitignore'), '**/node_modules\n*.log\n', 'utf8');
		await writeFile(join(dir, 'debug.log'), 'x', 'utf8');
		const plan = await computePackPlan({ cwd: dir, pkg: { name: 'g', version: '1.0.0' } });
		expect(plan.files).toContain('keep.js');
		expect(plan.files).not.toContain('debug.log'); // matched by *.log glob
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	it('is deterministic (sorted) for fixed inputs', async () => {
		const pkg = { name: 'libby', version: '0.1.0', files: ['dist'] };
		const a = await computePackPlan({ cwd: filesDir, pkg });
		const b = await computePackPlan({ cwd: filesDir, pkg });
		expect(a.files).toEqual(b.files);
		expect([...a.files].sort()).toEqual(a.files);
	});
});

describe('npm publish invocation — exact shape, secret redacted', () => {
	it('builds the exact argv + registry PUT + .npmrc line with the token redacted', () => {
		const plan = buildNpmPublishPlan({
			name: '@scope/pkg',
			version: '1.0.0',
			registry: 'https://registry.npmjs.org/',
			access: 'public',
			tarball: 'scope-pkg-1.0.0.tgz',
			tokenPresent: false
		});
		expect(plan.argv).toEqual(['npm', 'publish', '--access', 'public', '--tag', 'latest']);
		expect(plan.registryPut).toBe('PUT https://registry.npmjs.org/%40scope%2Fpkg');
		expect(plan.npmrcLine).toContain(REDACTED_TOKEN);
		expect(plan.npmrcLine).not.toMatch(/[A-Za-z0-9]{20,}/); // no real token-looking value
	});

	it('passes a non-default registry explicitly', () => {
		const plan = buildNpmPublishPlan({
			name: 'p',
			version: '1.0.0',
			registry: 'https://npm.acme.dev/',
			access: 'restricted',
			tarball: 'p-1.0.0.tgz',
			tokenPresent: true,
			tag: 'next'
		});
		expect(plan.argv).toContain('--registry');
		expect(plan.argv).toContain('https://npm.acme.dev/');
		expect(plan.tag).toBe('next');
	});
});

describe('npm adapter — contract + behavior', () => {
	it('passes the publisher contract (no creds needed for dry-run)', async () => {
		const report = await runPublisherContract(new NpmPublisherAdapter(), { cwd: pkgDir });
		expect(report.violations, JSON.stringify(report.violations)).toHaveLength(0);
		expect(report.ok).toBe(true);
	});

	it('probes available + names the artifact; honest about a missing token', async () => {
		const a = new NpmPublisherAdapter();
		const secrets = resolverForAdapter({}, a);
		const probe = await a.probe({ cwd: pkgDir, secrets });
		expect(probe.available).toBe(true);
		expect(probe.target).toBe('npm:mypkg');
		expect(probe.reason).toMatch(/NPM_TOKEN/);
	});

	it('package() lists the REAL pack file selection', async () => {
		const a = new NpmPublisherAdapter();
		const secrets = resolverForAdapter({}, a);
		const pkg = await a.package({ projectId: 'project:x', cwd: filesDir, dryRun: true, secrets });
		expect(pkg.ok).toBe(true);
		expect(pkg.artifact).toEqual({ name: 'libby', version: '0.1.0' });
		expect(pkg.steps.join('\n')).toMatch(/dist\/index\.js/);
		expect(pkg.steps.join('\n')).toMatch(/libby-0\.1\.0\.tgz/);
	});

	it('dry-run publish emits the exact invocation; the secret is never rendered', async () => {
		const a = new NpmPublisherAdapter();
		const secrets = resolverForAdapter({ NPM_TOKEN: 'super-secret-token-value-123' }, a);
		const res = await a.publish({ projectId: 'project:x', cwd: pkgDir, dryRun: true, secrets });
		expect(res.dryRun).toBe(true);
		expect(res.ok).toBe(true);
		const text = [res.summary, ...res.steps, ...res.warnings].join('\n');
		expect(text).toMatch(/npm publish --access/);
		expect(text).not.toContain('super-secret-token-value-123'); // D-026 — value never leaks
	});

	it('a real (non-dry-run) publish is HONEST-deferred (no external call, ok:false)', async () => {
		const a = new NpmPublisherAdapter();
		const secrets = resolverForAdapter({ NPM_TOKEN: 'tok' }, a);
		const res = await a.publish({ projectId: 'project:x', cwd: pkgDir, dryRun: false, secrets });
		expect(res.dryRun).toBe(false);
		expect(res.ok).toBe(false);
		expect(res.warnings.join(' ')).toMatch(/not performed in this track/);
	});

	it('refuses a private package + an invalid name/version with honest blockers', async () => {
		const a = new NpmPublisherAdapter();
		const secrets = resolverForAdapter({}, a);
		const probe = await a.probe({ cwd: badDir, secrets });
		expect(probe.available).toBe(false);
		expect(probe.reason).toMatch(/private/);
		const v = await a.validate({ projectId: 'project:x', cwd: badDir, dryRun: true, secrets });
		expect(v.ok).toBe(false);
		expect(v.blockers.length).toBeGreaterThanOrEqual(2);
	});

	it('is honest when there is no package.json', async () => {
		const a = new NpmPublisherAdapter();
		const secrets = resolverForAdapter({}, a);
		const probe = await a.probe({ cwd: emptyDir, secrets });
		expect(probe.available).toBe(false);
		expect(probe.reason).toMatch(/package\.json/);
	});

	it('confines secrets — reading an undeclared name throws (D-026)', async () => {
		const a = new NpmPublisherAdapter();
		const secrets = resolverForAdapter({}, a);
		expect(() => secrets.has(NPM_SECRET)).not.toThrow();
		expect(() => secrets.has('OTHER')).toThrow();
	});
});
