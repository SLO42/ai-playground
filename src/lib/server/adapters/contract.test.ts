import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { runPublisherContract, runDeployContract } from './contract';
import {
	NpmPublisherAdapter,
	ThunderstorePublisherAdapter,
	GitHubReleasesPublisherAdapter,
	StaticHostDeployTarget
} from './builtins';
import { getAdapterRegistry, resetAdapterRegistry } from './index';
import type { AdapterRunResult, PublisherAdapter } from './types';
import type { GitHubClient, AuthStatus } from '../sync/gh-client';

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
	// A COMPLETE valid Thunderstore package (12.2 deepened the rules: website_url + dependencies
	// fields required, a 256×256 PNG icon, a README.md).
	await writeFile(
		join(tsDir, 'manifest.json'),
		JSON.stringify({
			name: 'MyMod',
			version_number: '0.4.0',
			website_url: '',
			description: 'a mod',
			dependencies: []
		}),
		'utf8'
	);
	await writeFile(join(tsDir, 'README.md'), '# MyMod\n', 'utf8');
	await writeFile(join(tsDir, 'icon.png'), make256Png());
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

describe('github-releases publisher — contract', () => {
	it('passes the publisher contract (fake gh client, no network/creds)', async () => {
		// A fake gh client — unauthenticated + a resolvable repo, so probe is dry-run-capable.
		const fake: GitHubClient = {
			async isAuthenticated(): Promise<AuthStatus> {
				return { ok: false, reason: 'GitHub CLI is not authenticated' };
			},
			async resolveRepo() {
				return 'acme/widget';
			},
			async listIssues() {
				return [];
			},
			async createIssue() {
				throw new Error('not used');
			},
			async updateIssue() {}
		};
		const report = await runPublisherContract(new GitHubReleasesPublisherAdapter(fake), {
			cwd: tsDir // any dir works; config.repo not needed since resolveRepo returns one
		});
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

describe('contract harness — a FAILED dry-run must explain why (13.4c regression)', () => {
	/**
	 * A fixture publisher whose dry-runs FAIL (ok:false) with the given warnings. Every other
	 * contract obligation is met (honest probe reason, honest validate blockers, a plan, a
	 * summary) so the ONLY thing under test is the :honest-failure rule.
	 */
	function failingPublisher(warnings: string[]): PublisherAdapter {
		const result: AdapterRunResult = {
			target: 'example:pkg',
			dryRun: true,
			ok: false,
			summary: 'publish failed', // generic, non-empty — satisfies :honest-summary on its own
			steps: ['resolve target', 'attempt publish'],
			warnings
		};
		return {
			id: 'failing-fixture',
			label: 'Failing Fixture',
			kind: 'publish',
			secrets: () => [],
			probe: async () => ({ available: false, reason: 'fixture adapter — never available' }),
			validate: async () => ({ ok: false, blockers: ['fixture: not publishable'], warnings: [] }),
			package: async () => ({ ...result }),
			publish: async () => ({ ...result })
		};
	}

	it('REJECTS a dishonest failing adapter — ok:false with NO failure reason in warnings', async () => {
		// Before 13.4c the :honest-failure check was dominated by :honest-summary (a non-empty
		// summary made it vacuously pass), so this dishonest adapter sailed through the harness.
		const report = await runPublisherContract(failingPublisher([]), { cwd: emptyDir });
		expect(report.ok).toBe(false);
		const names = report.violations.map((v) => v.name);
		expect(names).toContain('package:honest-failure');
		expect(names).toContain('publish:honest-failure');
	});

	it('a whitespace-only warning is NOT an explanation', async () => {
		const report = await runPublisherContract(failingPublisher(['   ']), { cwd: emptyDir });
		expect(report.violations.map((v) => v.name)).toContain('publish:honest-failure');
	});

	it('PASSES an honest failing adapter — ok:false + a real failure reason in warnings', async () => {
		const report = await runPublisherContract(
			failingPublisher(['EXAMPLE_TOKEN is not set — the registry target cannot be resolved']),
			{ cwd: emptyDir }
		);
		expect(report.violations, JSON.stringify(report.violations)).toHaveLength(0);
		expect(report.ok).toBe(true);
	});
});

describe('registry singleton', () => {
	it('seeds the built-ins + fails CLOSED on an unknown id', () => {
		resetAdapterRegistry();
		const reg = getAdapterRegistry();
		expect(reg.getPublisher('npm').id).toBe('npm');
		expect(reg.getPublisher('thunderstore').id).toBe('thunderstore');
		expect(reg.getPublisher('github-releases').id).toBe('github-releases');
		expect(reg.getDeployer('static-host').id).toBe('static-host');
		expect(reg.has('publish', 'npm')).toBe(true);
		expect(reg.has('publish', 'nope')).toBe(false);
		expect(() => reg.getPublisher('does-not-exist')).toThrow(/no publish adapter registered/);
		expect(() => reg.getDeployer('does-not-exist')).toThrow(/no deploy adapter registered/);
	});
});

/** Build a real 256×256 PNG (solid color) so the Thunderstore icon rule passes (12.2). */
function make256Png(): Buffer {
	const W = 256,
		H = 256;
	function crc32(buf: Buffer): number {
		let c = ~0;
		for (let i = 0; i < buf.length; i++) {
			c ^= buf[i];
			for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
		}
		return ~c >>> 0;
	}
	function chunk(type: string, data: Buffer): Buffer {
		const t = Buffer.from(type, 'ascii');
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length, 0);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
		return Buffer.concat([len, t, data, crc]);
	}
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const row = Buffer.alloc(1 + W * 4);
	const raw = Buffer.concat(Array.from({ length: H }, () => row));
	return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
