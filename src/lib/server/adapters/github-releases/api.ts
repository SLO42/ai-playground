// TASK 12.3 — the EXACT GitHub release request the publish WOULD send (dry-run produces it; NO
// live call in this track — D-026). GitHub releases are created two equivalent ways; we model
// BOTH so the dry-run is honest about exactly what runs:
//   • the `gh release create` CLI invocation (how the 9.4 gh-client plumbing already auths —
//     operator's gh keychain / GH_TOKEN, never read or logged here, D-026); and
//   • the underlying REST payload (POST /repos/{owner}/{repo}/releases) the CLI performs, so the
//     surface shows the precise tag/name/body/draft/prerelease the release version carries.
//
// Asset attachment maps to `gh release create … <asset> …` (CLI uploads each file) ≡ the REST
// `POST {upload_url}?name=<asset>` per asset. We model the asset list; the bytes upload at the
// real-call site. The body is the REUSED 11.2 changelog Markdown (changelog.ts) — GitHub renders
// it, so it ships as raw Markdown.

/** The release metadata a per-project target + the resolved changelog supply. */
export interface GitHubReleaseConfig {
	/** owner/repo — resolved from the project's git remote (gh) or config.repo. */
	repo: string;
	/** The git tag the release points at (e.g. "v1.4.0"). Required. */
	tag: string;
	/** The release title (defaults to the tag when unset). */
	title?: string;
	/** Mark as a draft (unpublished) release. */
	draft?: boolean;
	/** Mark as a pre-release. */
	prerelease?: boolean;
	/** The commitish the tag is created at, when the tag does not exist yet. */
	targetCommitish?: string;
	/** Asset file paths (relative to cwd) to attach to the release. */
	assets?: string[];
}

/** One described request in the release plan (CLI form + the REST form it performs). */
export interface PlannedReleaseRequest {
	step: string;
	/** The `gh` CLI argv (no shell — array form, mirrors the 9.4 runGh boundary). */
	argv?: string[];
	/** The REST method + path the CLI performs under the hood. */
	method?: 'POST';
	url?: string;
	/** A non-secret JSON body description (the token never appears — gh auths from the env). */
	body?: Record<string, unknown>;
	note?: string;
}

/** The full dry-run release plan: the resolved metadata + the ordered requests. */
export interface GitHubReleasePlan {
	repo: string;
	tag: string;
	title: string;
	draft: boolean;
	prerelease: boolean;
	/** The release body Markdown (the REUSED 11.2 changelog), or '' when none (honest). */
	body: string;
	bodySource: 'config' | 'CHANGELOG.md' | 'none';
	assets: string[];
	requests: PlannedReleaseRequest[];
	/** True iff the gh CLI is authenticated (presence only — D-026). */
	authenticated: boolean;
}

export interface BuildReleasePlanInput {
	config: GitHubReleaseConfig;
	/** The resolved release body Markdown (changelog.ts), or null for an honest empty. */
	body: string | null;
	bodySource: 'config' | 'CHANGELOG.md' | 'none';
	/** Whether the gh CLI is authenticated (presence only — never a token, D-026). */
	authenticated: boolean;
}

/** A GitHub owner/repo slug (validated upstream by gh.ts assertRepoSlug). */
function ownerRepo(repo: string): { owner: string; name: string } {
	const [owner, name] = repo.split('/');
	return { owner: owner ?? '', name: name ?? '' };
}

/**
 * Build the exact GitHub release request plan a real publish WOULD send. Deterministic, pure, no
 * network/shell. The token never appears — gh authenticates from the operator's env (D-026); the
 * plan records WHAT runs (the gh argv + the REST POST + the per-asset uploads), not the secret.
 */
export function buildReleasePlan(input: BuildReleasePlanInput): GitHubReleasePlan {
	const cfg = input.config;
	const title = cfg.title?.trim() || cfg.tag;
	const draft = cfg.draft ?? false;
	const prerelease = cfg.prerelease ?? false;
	const assets = (cfg.assets ?? []).map(String).filter(Boolean);
	const body = input.body ?? '';
	const { owner, name } = ownerRepo(cfg.repo);

	// The gh CLI invocation (the 9.4 plumbing's form): body piped via --notes-file - (stdin) so
	// its content is never parsed by gh's flag tokenizer (mirrors gh-client createIssue, D-008).
	const argv = [
		'gh',
		'release',
		'create',
		cfg.tag,
		'--repo',
		cfg.repo,
		'--title',
		title,
		'--notes-file',
		'-'
	];
	if (draft) argv.push('--draft');
	if (prerelease) argv.push('--prerelease');
	if (cfg.targetCommitish) argv.push('--target', cfg.targetCommitish);
	for (const a of assets) argv.push(a);

	const requests: PlannedReleaseRequest[] = [
		{
			step: 'create-release',
			argv,
			method: 'POST',
			url: `POST /repos/${owner}/${name}/releases`,
			body: {
				tag_name: cfg.tag,
				name: title,
				body: body ? `${body.slice(0, 80)}${body.length > 80 ? '…' : ''}` : '',
				draft,
				prerelease,
				...(cfg.targetCommitish ? { target_commitish: cfg.targetCommitish } : {})
			},
			note: 'Creates the release; the body Markdown is piped via --notes-file - (stdin) so it is never tokenized. gh authenticates from the operator env (D-026).'
		}
	];
	for (const asset of assets) {
		requests.push({
			step: 'upload-asset',
			method: 'POST',
			url: `POST {release.upload_url}?name=${encodeURIComponent(asset.split('/').pop() ?? asset)}`,
			note: `Uploads "${asset}" as a release asset (gh release create attaches it inline).`
		});
	}

	return {
		repo: cfg.repo,
		tag: cfg.tag,
		title,
		draft,
		prerelease,
		body,
		bodySource: input.bodySource,
		assets,
		requests,
		authenticated: input.authenticated
	};
}

/** Render the plan as ordered human-readable step lines for the dry-run surface (no secret). */
export function releasePlanToSteps(plan: GitHubReleasePlan): string[] {
	const lines: string[] = [];
	for (const r of plan.requests) {
		if (r.argv) lines.push(r.argv.join(' '));
		else if (r.url) lines.push(r.url);
		else lines.push(r.step);
	}
	return lines;
}
