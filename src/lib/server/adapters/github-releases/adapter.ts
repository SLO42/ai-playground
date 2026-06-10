// TASK 12.3 — the GitHub-releases PublisherAdapter (D-037). Ships a tagged GitHub release with a
// generated changelog body + attached artifacts. It REUSES two existing seams rather than
// rebuilding them:
//   • the 9.4 GitHub client/credential plumbing (gh-client.ts GitHubClient: isAuthenticated +
//     resolveRepo, all via the no-shell runGh boundary, operator creds D-026) — injected so the
//     contract suite + unit tests run against a fake client with NO network/creds;
//   • the 11.2 changelog render SOURCE (release/pipeline.ts getReleaseChangelogMarkdown, surfaced
//     via changelog.ts resolveReleaseBody) for the release BODY — NOT a duplicate renderer.
//
// It implements the 12.1 `PublisherAdapter` contract:
//   • probe()    — honest availability: gh authenticated + a resolvable owner/repo + a tag in
//                  config. NEVER throws (a gh failure degrades to available:false + a reason).
//   • validate() — preconditions WITHOUT creating a release: repo resolvable, tag present, body
//                  source available, assets exist (advisory).
//   • package()  — ASSEMBLE the release: resolve repo + tag + title + the changelog body + the
//                  asset list, and report exactly what the release WOULD contain (no API call).
//   • publish()  — the EXACT GitHub release request SHAPE behind dry-run-by-default (api.ts): the
//                  `gh release create` argv + the REST POST + per-asset uploads (token NEVER
//                  rendered — D-026). A real publish is GATED (D-018/D-024) + needs gh auth, and
//                  is NOT executed in this track (honest deferred-live-proof).
//
// Filesystem touches are confined to cwd (CHANGELOG.md fallback + asset existence checks). gh
// calls go through the injected client (the real one uses runGh — no shell, D-008).

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	AdapterProbe,
	AdapterRunOptions,
	AdapterRunResult,
	PackageResult,
	PublishValidation,
	PublisherAdapter,
	SecretRequirement,
	SecretResolver
} from '../types';
import { GitHubCliClient, type GitHubClient } from '../../sync/gh-client';
import { resolveReleaseBody } from './changelog';
import { buildReleasePlan, releasePlanToSteps, type GitHubReleaseConfig } from './api';

/**
 * The env-var the operator supplies for a real GitHub release (presence advisory only — D-026).
 * gh ALSO auths from the operator's `gh auth` keychain, so this is `required:false`: a probe is
 * authoritative via `gh auth status`, and GH_TOKEN is just the env path to the same auth.
 */
export const GITHUB_SECRET = 'GH_TOKEN';

/** Read the release config from the per-project target config blob. */
function readReleaseConfig(config: Record<string, unknown> | undefined, repo: string): GitHubReleaseConfig {
	const c = config ?? {};
	const out: GitHubReleaseConfig = { repo, tag: '' };
	if (typeof c.tag === 'string') out.tag = c.tag.trim();
	if (typeof c.title === 'string') out.title = c.title;
	if (typeof c.draft === 'boolean') out.draft = c.draft;
	if (typeof c.prerelease === 'boolean') out.prerelease = c.prerelease;
	if (typeof c.targetCommitish === 'string') out.targetCommitish = c.targetCommitish;
	if (Array.isArray(c.assets)) out.assets = c.assets.map(String).filter(Boolean);
	return out;
}

/** True iff a file exists under cwd (for honest asset-existence warnings). */
async function exists(cwd: string, rel: string): Promise<boolean> {
	try {
		await access(join(cwd, rel));
		return true;
	} catch {
		return false;
	}
}

export class GitHubReleasesPublisherAdapter implements PublisherAdapter {
	readonly id = 'github-releases';
	readonly label = 'GitHub releases';
	readonly kind = 'publish' as const;

	readonly #client: GitHubClient;

	/** The gh client is injectable so tests run against a fake (no network/creds). */
	constructor(client: GitHubClient = new GitHubCliClient()) {
		this.#client = client;
	}

	secrets(): SecretRequirement[] {
		return [
			{
				envVar: GITHUB_SECRET,
				label: 'GitHub token',
				purpose: 'Authenticates the GitHub release API (gh also uses the operator gh-auth keychain). Optional if gh is already logged in.',
				required: false
			}
		];
	}

	/** Resolve owner/repo: config.repo (validated by gh.ts upstream) or the git remote via gh. */
	async #resolveRepo(cwd: string, config?: Record<string, unknown>): Promise<string | null> {
		const fromConfig = config && typeof config.repo === 'string' ? config.repo.trim() : '';
		if (fromConfig) return fromConfig;
		try {
			return await this.#client.resolveRepo(cwd);
		} catch {
			return null;
		}
	}

	async probe(opts: { cwd: string; secrets: SecretResolver; config?: Record<string, unknown> }): Promise<AdapterProbe> {
		let auth: { ok: boolean; reason?: string };
		try {
			auth = await this.#client.isAuthenticated(opts.cwd);
		} catch (err) {
			auth = { ok: false, reason: (err as Error).message };
		}
		const repo = await this.#resolveRepo(opts.cwd, opts.config);
		if (!repo) {
			return {
				available: false,
				reason: 'No GitHub repo resolved — set config.repo ("owner/name") or run inside a git repo with a GitHub remote.'
			};
		}
		const tag = opts.config && typeof opts.config.tag === 'string' ? opts.config.tag.trim() : '';
		// The adapter can PACKAGE/dry-run even unauthenticated; only a REAL publish needs auth.
		if (!auth.ok) {
			return {
				available: true,
				target: `github:${repo}`,
				reason: `${auth.reason ?? 'GitHub CLI is not authenticated'} — package + dry-run only until you authenticate (gh auth login or set ${GITHUB_SECRET}).`
			};
		}
		return {
			available: true,
			target: `github:${repo}`,
			...(tag ? {} : { reason: 'config.tag is not set — set the release tag (e.g. "v1.0.0") before publishing.' })
		};
	}

	async validate(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PublishValidation> {
		const blockers: string[] = [];
		const warnings: string[] = [];

		const repo = await this.#resolveRepo(opts.cwd, opts.config);
		if (!repo) {
			blockers.push('No GitHub repo resolved — set config.repo ("owner/name") or run inside a git repo with a GitHub remote.');
		}
		const cfg = readReleaseConfig(opts.config, repo ?? '');
		if (!cfg.tag) {
			blockers.push('config.tag is required — the git tag the release points at (e.g. "v1.4.0").');
		}

		// Body source: the reused changelog. An absent body is a WARNING (a release can have an
		// empty body), surfaced honestly so the operator knows the changelog step produced nothing.
		const resolved = await resolveReleaseBody(opts.cwd, opts.config);
		if (resolved.source === 'none') {
			warnings.push('No release body — neither a pipeline-supplied changelog (config.body) nor a CHANGELOG.md was found. The release would have an empty body.');
		}

		// Assets: warn (don't block) on any declared asset that does not exist.
		for (const a of cfg.assets ?? []) {
			if (!(await exists(opts.cwd, a))) {
				warnings.push(`Declared asset "${a}" was not found under the project root — it will not be attached.`);
			}
		}

		// Auth is advisory at validate-time (a dry-run never needs it).
		let auth: { ok: boolean; reason?: string };
		try {
			auth = await this.#client.isAuthenticated(opts.cwd);
		} catch (err) {
			auth = { ok: false, reason: (err as Error).message };
		}
		if (!auth.ok) {
			warnings.push(`${auth.reason ?? 'GitHub CLI is not authenticated'} — a real publish will fail until you authenticate.`);
		}

		return { ok: blockers.length === 0, blockers, warnings };
	}

	async package(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PackageResult> {
		const repo = await this.#resolveRepo(opts.cwd, opts.config);
		const cfg = readReleaseConfig(opts.config, repo ?? '');
		const resolved = await resolveReleaseBody(opts.cwd, opts.config);
		const v = await this.validate(opts);

		const target = repo ? `github:${repo}` : 'github:(unresolved)';
		if (!v.ok) {
			return {
				target,
				dryRun: true,
				ok: false,
				summary: `Release not assembled — ${v.blockers.length} blocker(s): ${v.blockers.join('; ')}`,
				steps: v.blockers.map((b) => `  ✗ ${b}`),
				warnings: v.warnings
			};
		}

		const title = cfg.title?.trim() || cfg.tag;
		const bodyLines =
			resolved.body == null
				? ['Body: (empty — no generated changelog or CHANGELOG.md)']
				: [`Body source: ${resolved.source} (${resolved.body.length} chars of Markdown)`];
		const assetLines =
			(cfg.assets ?? []).length === 0
				? ['Assets: (none declared)']
				: [`Assets (${cfg.assets!.length}):`, ...cfg.assets!.map((a) => `  • ${a}`)];

		return {
			target,
			dryRun: true,
			ok: true,
			summary: `Assembled GitHub release ${cfg.tag} "${title}" for ${repo} — body from ${resolved.source}, ${(cfg.assets ?? []).length} asset(s).`,
			steps: [
				`Repo: ${repo}`,
				`Tag: ${cfg.tag}`,
				`Title: ${title}`,
				`Draft: ${cfg.draft ?? false} · Pre-release: ${cfg.prerelease ?? false}`,
				...bodyLines,
				...assetLines
			],
			warnings: v.warnings,
			artifact: { name: repo!, version: cfg.tag }
		};
	}

	async publish(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<AdapterRunResult> {
		const dryRun = opts.dryRun ?? true;
		const repo = await this.#resolveRepo(opts.cwd, opts.config);
		const v = await this.validate(opts);
		const target = repo ? `github:${repo}` : 'github:(unresolved)';

		if (!v.ok) {
			return {
				target,
				dryRun,
				ok: false,
				summary: `Not publishable: ${v.blockers.join('; ')}`,
				steps: ['Resolve the GitHub release preconditions before any API call:', ...v.blockers.map((b) => `  ✗ ${b}`)],
				warnings: v.warnings
			};
		}

		const cfg = readReleaseConfig(opts.config, repo!);
		const resolved = await resolveReleaseBody(opts.cwd, opts.config);
		let auth: { ok: boolean; reason?: string };
		try {
			auth = await this.#client.isAuthenticated(opts.cwd);
		} catch (err) {
			auth = { ok: false, reason: (err as Error).message };
		}

		const plan = buildReleasePlan({
			config: cfg,
			body: resolved.body,
			bodySource: resolved.source,
			authenticated: auth.ok
		});
		const requestSteps = [
			`GitHub release ${plan.tag} "${plan.title}" → ${plan.repo}`,
			`Request shape (gh authenticates from the operator env — token never rendered, D-026):`,
			...releasePlanToSteps(plan).map((s) => `  → ${s}`)
		];
		const warnings = [...v.warnings];

		if (dryRun) {
			return {
				target,
				dryRun: true,
				ok: true,
				summary: `Dry-run: would create GitHub release ${plan.tag} on ${plan.repo} (body from ${plan.bodySource}, ${plan.assets.length} asset(s)). gh auth: ${auth.ok ? 'authenticated' : 'NOT authenticated'}.`,
				steps: requestSteps,
				warnings
			};
		}

		// Real publish: GATED (the driver enforces the confirm token) + DEFERRED in this track — no
		// external GitHub call is made. The request shape is fully prepared; the live release lands
		// when the operator's gh is authenticated and they confirm.
		return {
			target,
			dryRun: false,
			ok: false,
			summary: `GitHub release ${plan.tag} on ${plan.repo} prepared but NOT executed in this track — real release creation deferred to operator credentials.`,
			steps: requestSteps,
			warnings: [
				...warnings,
				`Real GitHub release not performed in this track — authenticate gh (gh auth login or set ${GITHUB_SECRET}) and confirm the gated action (D-026/D-018). The request shape above is exactly what would be sent (the token is never rendered — gh auths from the env).`
			]
		};
	}
}
