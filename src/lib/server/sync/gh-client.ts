// TASK 9.4 — the GitHubClient seam: the typed GitHub operations the adapter needs, with the
// real `gh` CLI impl behind it. Splitting this out lets the adapter's FULL reconcile logic
// run against a fake client in tests (no network, no creds) while production uses the real
// gh boundary (gh.ts). All real calls go through runGh (array args, no shell — D-008).
//
// Credentials (D-026): the real client NEVER reads or logs a token — gh authenticates from
// the operator's own keychain / a GH_TOKEN already in the env (operator-supplied via .env,
// never committed). `isAuthenticated` just asks gh; an unauthenticated CLI yields an honest
// reason (F-008) rather than a thrown stack trace.

import { runGh, GhError, assertRepoSlug } from './gh';

/** A GitHub issue, normalized from gh's JSON (camelCase) to the shape the adapter uses. */
export interface GitHubIssue {
	number: number;
	title: string;
	body: string;
	state: 'open' | 'closed';
	labels: Array<{ name: string }>;
	url: string;
}

/** The reference returned by a create — the issue number + its html url. */
export interface CreatedIssue {
	number: number;
	url: string;
}

/** Whether the CLI is usable + why-not when it isn't (honest degrade). */
export interface AuthStatus {
	ok: boolean;
	reason?: string;
}

/** The GitHub operations the sync adapter depends on (the injectable seam). */
export interface GitHubClient {
	/** Is `gh` installed AND authenticated? Never throws — returns an honest reason. */
	isAuthenticated(cwd: string): Promise<AuthStatus>;
	/** Resolve the `owner/repo` for this working dir, or null if none. Never throws. */
	resolveRepo(cwd: string): Promise<string | null>;
	/** All issues carrying the atelier-task label, in the repo. */
	listIssues(repo: string, cwd: string): Promise<GitHubIssue[]>;
	/** Create an issue; returns its number + url. */
	createIssue(
		repo: string,
		input: { title: string; body: string; labels: string[]; cwd: string }
	): Promise<CreatedIssue>;
	/** Update an issue's state + labels (idempotent — safe to call repeatedly). */
	updateIssue(
		repo: string,
		number: number,
		input: { labels: string[]; state: 'open' | 'closed'; cwd: string }
	): Promise<void>;
}

const SYNC_LABEL = 'atelier-task';
const LABEL_COLOR = '8ab0ab'; // the design-system accent — Atelier-owned labels are visually ours.

/** The real `gh` CLI implementation (production). */
export class GitHubCliClient implements GitHubClient {
	readonly #bin: string | undefined;
	constructor(opts: { bin?: string } = {}) {
		this.#bin = opts.bin;
	}

	async isAuthenticated(cwd: string): Promise<AuthStatus> {
		try {
			await runGh(['auth', 'status'], { cwd, bin: this.#bin });
			return { ok: true };
		} catch (err) {
			const reason =
				err instanceof GhError && err.code === null && err.message.includes('not available')
					? 'GitHub CLI (gh) is not installed.'
					: 'GitHub CLI is not authenticated — run `gh auth login` or set GH_TOKEN.';
			return { ok: false, reason };
		}
	}

	async resolveRepo(cwd: string): Promise<string | null> {
		try {
			const out = await runGh(
				['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
				{ cwd, bin: this.#bin }
			);
			const repo = out.trim();
			return repo ? assertRepoSlug(repo) : null;
		} catch {
			return null;
		}
	}

	async listIssues(repo: string, cwd: string): Promise<GitHubIssue[]> {
		assertRepoSlug(repo);
		const out = await runGh(
			[
				'issue',
				'list',
				'--repo',
				repo,
				'--state',
				'all',
				'--limit',
				'200',
				'--label',
				SYNC_LABEL,
				'--json',
				'number,title,body,state,labels,url'
			],
			{ cwd, bin: this.#bin }
		);
		if (!out) return [];
		const raw = JSON.parse(out) as Array<{
			number: number;
			title: string;
			body?: string;
			state: string;
			labels?: Array<{ name: string }>;
			url: string;
		}>;
		return raw.map((i) => ({
			number: i.number,
			title: i.title,
			body: i.body ?? '',
			state: i.state.toLowerCase() === 'closed' ? 'closed' : 'open',
			labels: i.labels ?? [],
			url: i.url
		}));
	}

	async createIssue(
		repo: string,
		input: { title: string; body: string; labels: string[]; cwd: string }
	): Promise<CreatedIssue> {
		assertRepoSlug(repo);
		await this.#ensureLabels(repo, input.labels, input.cwd);
		// Title is an arg (gh escapes it via the array form); BODY is piped over stdin so its
		// content (which may contain anything) is never parsed by gh's flag tokenizer.
		const args = ['issue', 'create', '--repo', repo, '--title', input.title, '--body-file', '-'];
		for (const l of input.labels) args.push('--label', l);
		const url = (await runGh(args, { cwd: input.cwd, stdin: input.body, bin: this.#bin })).trim();
		const m = url.match(/\/issues\/(\d+)/);
		if (!m) throw new Error(`could not parse issue number from gh output: ${url}`);
		return { number: Number(m[1]), url };
	}

	async updateIssue(
		repo: string,
		number: number,
		input: { labels: string[]; state: 'open' | 'closed'; cwd: string }
	): Promise<void> {
		assertRepoSlug(repo);
		await this.#ensureLabels(repo, input.labels, input.cwd);
		if (input.state === 'closed') {
			await runGh(['issue', 'close', String(number), '--repo', repo], {
				cwd: input.cwd,
				bin: this.#bin
			}).catch(() => {});
		} else {
			await runGh(['issue', 'reopen', String(number), '--repo', repo], {
				cwd: input.cwd,
				bin: this.#bin
			}).catch(() => {});
		}
		const args = ['issue', 'edit', String(number), '--repo', repo];
		for (const l of input.labels) args.push('--add-label', l);
		await runGh(args, { cwd: input.cwd, bin: this.#bin }).catch(() => {});
	}

	/** Create any missing labels (idempotent — `--force` upserts). Best-effort. */
	async #ensureLabels(repo: string, labels: string[], cwd: string): Promise<void> {
		for (const l of labels) {
			await runGh(
				['label', 'create', l, '--repo', repo, '--color', LABEL_COLOR, '--force'],
				{ cwd, bin: this.#bin }
			).catch(() => {});
		}
	}
}
