import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubReleasesPublisherAdapter, GITHUB_SECRET } from './adapter';
import { buildReleasePlan } from './api';
import { resolveReleaseBody } from './changelog';
import { runPublisherContract } from '../contract';
import { resolverForAdapter } from '../secrets';
import type {
	GitHubClient,
	GitHubIssue,
	CreatedIssue,
	AuthStatus
} from '../../sync/gh-client';

// TASK 12.3 VERIFY — the GitHub-releases PublisherAdapter. It REUSES the 9.4 gh client (injected
// here as a FAKE — no network/creds) + the 11.2 changelog source (config.body / CHANGELOG.md). The
// dry-run produces the EXACT gh release request shape; the real call is gated + deferred (no API
// hit in this track).

/** A fake GitHubClient — configurable auth + resolved repo. No network. */
function fakeClient(opts: { authed: boolean; repo: string | null }): GitHubClient {
	return {
		async isAuthenticated(): Promise<AuthStatus> {
			return opts.authed ? { ok: true } : { ok: false, reason: 'GitHub CLI is not authenticated' };
		},
		async resolveRepo(): Promise<string | null> {
			return opts.repo;
		},
		async listIssues(): Promise<GitHubIssue[]> {
			return [];
		},
		async createIssue(): Promise<CreatedIssue> {
			throw new Error('not used');
		},
		async updateIssue(): Promise<void> {}
	};
}

let cwd: string;
let noChangelogDir: string;

beforeAll(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'atelier-gh-rel-'));
	await writeFile(join(cwd, 'CHANGELOG.md'), '## v1.4.0\n\n- A real change\n- Another change\n', 'utf8');
	await writeFile(join(cwd, 'dist.zip'), 'fake-asset-bytes', 'utf8');
	noChangelogDir = await mkdtemp(join(tmpdir(), 'atelier-gh-nocl-'));
});

afterAll(async () => {
	await rm(cwd, { recursive: true, force: true }).catch(() => {});
	await rm(noChangelogDir, { recursive: true, force: true }).catch(() => {});
});

describe('changelog body resolver — REUSES the 11.2 source, honest fallback', () => {
	it('prefers the pipeline-supplied config.body (the generated changelog)', async () => {
		const r = await resolveReleaseBody(cwd, { body: '## Generated\n\n- from the changelog session' });
		expect(r.source).toBe('config');
		expect(r.body).toMatch(/from the changelog session/);
	});

	it('falls back to CHANGELOG.md when no config.body', async () => {
		const r = await resolveReleaseBody(cwd, {});
		expect(r.source).toBe('CHANGELOG.md');
		expect(r.body).toMatch(/A real change/);
	});

	it('is honestly empty when neither source exists', async () => {
		const r = await resolveReleaseBody(noChangelogDir, {});
		expect(r.source).toBe('none');
		expect(r.body).toBeNull();
	});
});

describe('release plan — exact gh request shape, token never rendered', () => {
	it('builds the gh release-create argv + REST POST + per-asset uploads', () => {
		const plan = buildReleasePlan({
			config: { repo: 'acme/widget', tag: 'v1.4.0', title: 'Widget 1.4', assets: ['dist.zip'] },
			body: '## notes',
			bodySource: 'config',
			authenticated: true
		});
		const create = plan.requests.find((r) => r.step === 'create-release');
		expect(create?.argv).toEqual([
			'gh',
			'release',
			'create',
			'v1.4.0',
			'--repo',
			'acme/widget',
			'--title',
			'Widget 1.4',
			'--notes-file',
			'-',
			'dist.zip'
		]);
		expect(create?.url).toBe('POST /repos/acme/widget/releases');
		expect(plan.requests.some((r) => r.step === 'upload-asset')).toBe(true);
		// The token NEVER appears anywhere in the plan (gh auths from the env — D-026).
		expect(JSON.stringify(plan)).not.toMatch(/Bearer|GH_TOKEN=|ghp_/);
	});

	it('title defaults to the tag; draft/prerelease flags are honored', () => {
		const plan = buildReleasePlan({
			config: { repo: 'a/b', tag: 'v0.1.0', draft: true, prerelease: true },
			body: null,
			bodySource: 'none',
			authenticated: false
		});
		expect(plan.title).toBe('v0.1.0');
		const create = plan.requests[0];
		expect(create.argv).toContain('--draft');
		expect(create.argv).toContain('--prerelease');
	});
});

describe('github-releases adapter — contract + behavior', () => {
	it('passes the publisher contract (fake client, no creds)', async () => {
		const adapter = new GitHubReleasesPublisherAdapter(fakeClient({ authed: false, repo: 'acme/widget' }));
		const report = await runPublisherContract(adapter, { cwd });
		expect(report.violations, JSON.stringify(report.violations)).toHaveLength(0);
		expect(report.ok).toBe(true);
	});

	it('probe is available (dry-run-capable) but honest about missing auth', async () => {
		const adapter = new GitHubReleasesPublisherAdapter(fakeClient({ authed: false, repo: 'acme/widget' }));
		const secrets = resolverForAdapter({}, adapter);
		const probe = await adapter.probe({ cwd, secrets, config: { tag: 'v1.4.0' } });
		expect(probe.available).toBe(true);
		expect(probe.target).toBe('github:acme/widget');
		expect(probe.reason).toMatch(/not authenticated/i);
	});

	it('probe fails CLOSED-honest when no repo resolves', async () => {
		const adapter = new GitHubReleasesPublisherAdapter(fakeClient({ authed: true, repo: null }));
		const secrets = resolverForAdapter({}, adapter);
		const probe = await adapter.probe({ cwd, secrets, config: {} });
		expect(probe.available).toBe(false);
		expect(probe.reason).toMatch(/repo/i);
	});

	it('validate blocks a missing tag; warns on a missing body + missing asset', async () => {
		const adapter = new GitHubReleasesPublisherAdapter(fakeClient({ authed: true, repo: 'acme/widget' }));
		const secrets = resolverForAdapter({}, adapter);
		const v = await adapter.validate({ projectId: 'project:x', cwd: noChangelogDir, dryRun: true, secrets, config: { assets: ['missing.zip'] } });
		expect(v.ok).toBe(false);
		expect(v.blockers.join(' ')).toMatch(/tag/);
		// With a tag but no changelog, body is a warning not a blocker.
		const v2 = await adapter.validate({ projectId: 'project:x', cwd: noChangelogDir, dryRun: true, secrets, config: { tag: 'v1.0.0', assets: ['missing.zip'] } });
		expect(v2.ok).toBe(true);
		expect(v2.warnings.join(' ')).toMatch(/body|missing\.zip/);
	});

	it('package() assembles the release using the REUSED changelog source', async () => {
		const adapter = new GitHubReleasesPublisherAdapter(fakeClient({ authed: true, repo: 'acme/widget' }));
		const secrets = resolverForAdapter({}, adapter);
		const pkg = await adapter.package({ projectId: 'project:x', cwd, dryRun: true, secrets, config: { tag: 'v1.4.0', assets: ['dist.zip'] } });
		expect(pkg.ok).toBe(true);
		expect(pkg.artifact).toEqual({ name: 'acme/widget', version: 'v1.4.0' });
		expect(pkg.steps.join('\n')).toMatch(/CHANGELOG\.md/);
		expect(pkg.steps.join('\n')).toMatch(/dist\.zip/);
	});

	it('dry-run publish emits the exact request shape (gh auths from env — no token rendered)', async () => {
		const adapter = new GitHubReleasesPublisherAdapter(fakeClient({ authed: true, repo: 'acme/widget' }));
		const secrets = resolverForAdapter({ GH_TOKEN: 'ghp_supersecretvalue000' }, adapter);
		const res = await adapter.publish({ projectId: 'project:x', cwd, dryRun: true, secrets, config: { tag: 'v1.4.0' } });
		expect(res.dryRun).toBe(true);
		expect(res.ok).toBe(true);
		const text = [res.summary, ...res.steps, ...res.warnings].join('\n');
		expect(text).toMatch(/gh release create/);
		expect(text).not.toContain('ghp_supersecretvalue000'); // D-026 — token never leaks
	});

	it('a real (non-dry-run) publish is HONEST-deferred (no API call, ok:false)', async () => {
		const adapter = new GitHubReleasesPublisherAdapter(fakeClient({ authed: true, repo: 'acme/widget' }));
		const secrets = resolverForAdapter({}, adapter);
		const res = await adapter.publish({ projectId: 'project:x', cwd, dryRun: false, secrets, config: { tag: 'v1.4.0' } });
		expect(res.dryRun).toBe(false);
		expect(res.ok).toBe(false);
		expect(res.warnings.join(' ')).toMatch(/not performed in this track/);
	});

	it('secrets() declares GH_TOKEN (advisory) — confinement holds', async () => {
		const adapter = new GitHubReleasesPublisherAdapter(fakeClient({ authed: true, repo: 'acme/widget' }));
		expect(adapter.secrets().some((s) => s.envVar === GITHUB_SECRET)).toBe(true);
		const secrets = resolverForAdapter({}, adapter);
		expect(() => secrets.has('UNDECLARED')).toThrow();
	});
});
