import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPublisherContract, runDeployContract } from './contract';
import {
	NpmPublisherAdapter,
	ThunderstorePublisherAdapter,
	StaticHostDeployTarget
} from './builtins';
import { getAdapterRegistry, resetAdapterRegistry } from './index';

// TASK 12.1 VERIFY — the contract harness (used by 12.2/12.3) + the built-in adapters. Each
// built-in must PASS the contract: probe never throws, dry-run is non-mutating + honest, the
// resolver is confined (D-026). No real external call occurs.

let npmDir: string;
let tsDir: string;
let emptyDir: string;

beforeAll(async () => {
	npmDir = await mkdtemp(join(tmpdir(), 'atelier-npm-'));
	await writeFile(
		join(npmDir, 'package.json'),
		JSON.stringify({ name: '@scope/pkg', version: '1.2.3', files: ['dist'] }),
		'utf8'
	);
	tsDir = await mkdtemp(join(tmpdir(), 'atelier-ts-'));
	await writeFile(
		join(tsDir, 'manifest.json'),
		JSON.stringify({ name: 'MyMod', version_number: '0.4.0', description: 'a mod' }),
		'utf8'
	);
	emptyDir = await mkdtemp(join(tmpdir(), 'atelier-empty-'));
});

afterAll(async () => {
	await rm(npmDir, { recursive: true, force: true }).catch(() => {});
	await rm(tsDir, { recursive: true, force: true }).catch(() => {});
	await rm(emptyDir, { recursive: true, force: true }).catch(() => {});
});

describe('npm publisher — contract', () => {
	it('passes the publisher contract with a real package.json', async () => {
		const report = await runPublisherContract(new NpmPublisherAdapter(), { cwd: npmDir });
		expect(report.violations, JSON.stringify(report.violations)).toHaveLength(0);
		expect(report.ok).toBe(true);
	});

	it('probes available + names the artifact (no creds needed for dry-run)', async () => {
		const a = new NpmPublisherAdapter();
		const { resolverForAdapter } = await import('./secrets');
		const secrets = resolverForAdapter({}, a);
		const probe = await a.probe({ cwd: npmDir, secrets });
		expect(probe.available).toBe(true);
		expect(probe.target).toBe('npm:@scope/pkg');
		// honest: NPM_TOKEN unset → reason mentions dry-run-only
		expect(probe.reason).toMatch(/NPM_TOKEN/);

		const pkg = await a.package({ projectId: 'project:x', cwd: npmDir, dryRun: true, secrets });
		expect(pkg.artifact).toEqual({ name: '@scope/pkg', version: '1.2.3' });
		expect(pkg.dryRun).toBe(true);
	});

	it('a real (non-dry-run) publish is HONEST-deferred (no external call, ok:false)', async () => {
		const a = new NpmPublisherAdapter();
		const { resolverForAdapter } = await import('./secrets');
		const secrets = resolverForAdapter({ NPM_TOKEN: 'tok' }, a);
		const res = await a.publish({ projectId: 'project:x', cwd: npmDir, dryRun: false, secrets });
		expect(res.dryRun).toBe(false);
		expect(res.ok).toBe(false);
		expect(res.warnings.join(' ')).toMatch(/not performed in this track/);
	});

	it('probe is honest when there is no package.json', async () => {
		const a = new NpmPublisherAdapter();
		const { resolverForAdapter } = await import('./secrets');
		const probe = await a.probe({ cwd: emptyDir, secrets: resolverForAdapter({}, a) });
		expect(probe.available).toBe(false);
		expect(probe.reason).toMatch(/package\.json/);
	});
});

describe('thunderstore publisher — contract', () => {
	it('passes the publisher contract with a real manifest.json', async () => {
		const report = await runPublisherContract(new ThunderstorePublisherAdapter(), { cwd: tsDir });
		expect(report.violations, JSON.stringify(report.violations)).toHaveLength(0);
		expect(report.ok).toBe(true);
	});
});

describe('static-host deploy target — contract', () => {
	it('passes the deploy contract', async () => {
		const report = await runDeployContract(new StaticHostDeployTarget(), {
			cwd: emptyDir,
			env: {}
		});
		expect(report.violations, JSON.stringify(report.violations)).toHaveLength(0);
		expect(report.ok).toBe(true);
	});

	it('status() is honestly "unknown" until a real deploy lands', async () => {
		const a = new StaticHostDeployTarget();
		const { resolverForAdapter } = await import('./secrets');
		const s = await a.status({ cwd: emptyDir, secrets: resolverForAdapter({}, a) });
		expect(s.state).toBe('unknown');
	});
});

describe('registry singleton', () => {
	it('seeds the built-ins + fails CLOSED on an unknown id', () => {
		resetAdapterRegistry();
		const reg = getAdapterRegistry();
		expect(reg.getPublisher('npm').id).toBe('npm');
		expect(reg.getPublisher('thunderstore').id).toBe('thunderstore');
		expect(reg.getDeployer('static-host').id).toBe('static-host');
		expect(reg.has('publish', 'npm')).toBe(true);
		expect(reg.has('publish', 'nope')).toBe(false);
		expect(() => reg.getPublisher('does-not-exist')).toThrow(/no publish adapter registered/);
		expect(() => reg.getDeployer('does-not-exist')).toThrow(/no deploy adapter registered/);
	});
});
