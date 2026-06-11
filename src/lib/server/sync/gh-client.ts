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
	/**
	 * TASK 16.2 — ALL open issues + PRs (NO label filter): the arrival-detection read
	 * (PM-SPEC §3 event ②). OPTIONAL: a client without it performs no arrival
	 * detection (the adapter then omits SyncResult.arrivals — an honest absence).
	 */
	listOpenItems?(
		repo: string,
		cwd: string
	): Promise<{ issues: OpenItem[]; prs: OpenItem[] }>;
}

/** One open issue/PR head — the minimal arrival-detection shape (TASK 16.2). */
export interface OpenItem {
	number: number;
	title: string;
	url: string;
}

// ── GitHub Projects (v2) board operations (TASK 11.4 — project-BOARD sync) ─────────
// The board sync maps an Atelier task's STATUS to a GitHub Projects (v2) board column (a
// single-select "Status" field option). One-way push: it ensures each synced task's issue is
// an item on the board and sets the item's Status field to the configured column. All the
// real gh calls go through runGh (array args, no shell — D-008); creds are operator-supplied
// (D-026). The full op set is small and injectable so the contract suite exercises the
// adapter against a fake board with NO network.

/** A board column option (a single-select field option on the project board). */
export interface BoardColumn {
	/** The option's stable node id (used to set an item's status). */
	id: string;
	/** The human column name (e.g. "Todo", "In Progress", "Done") — what the config maps to. */
	name: string;
}

/** The resolved board: its node id, the Status field id, and its column options. */
export interface BoardInfo {
	/** The Projects (v2) board node id. */
	projectId: string;
	/** The single-select "Status" field node id (null if the board has no Status field). */
	statusFieldId: string | null;
	columns: BoardColumn[];
}

/** A board item — the link between an issue and its row on the board. */
export interface BoardItem {
	/** The board item node id (the thing whose Status we set). */
	itemId: string;
}

/** The GitHub Projects (v2) board operations the board-sync adapter depends on. */
export interface GitHubBoardClient {
	/** Resolve a board (by owner + number) — its Status field + columns. Null if not found. */
	resolveBoard(owner: string, number: number, cwd: string): Promise<BoardInfo | null>;
	/** Ensure an issue is an item on the board (idempotent); returns the item id. */
	addIssueToBoard(boardId: string, issueUrl: string, cwd: string): Promise<BoardItem>;
	/** Set a board item's single-select Status to the given option id (idempotent). */
	setItemStatus(
		boardId: string,
		itemId: string,
		statusFieldId: string,
		optionId: string,
		cwd: string
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

	/**
	 * TASK 16.2 — ALL open issues + PRs (no label filter), for arrival detection.
	 * Two bounded reads (`gh issue list` / `gh pr list`, --limit 200), array args via
	 * runGh (no shell — D-008). A failure THROWS — the adapter catches and records it
	 * as a non-fatal run error (detection failure must not fail the sync).
	 */
	async listOpenItems(repo: string, cwd: string): Promise<{ issues: OpenItem[]; prs: OpenItem[] }> {
		assertRepoSlug(repo);
		const list = async (cmd: 'issue' | 'pr'): Promise<OpenItem[]> => {
			const out = await runGh(
				[cmd, 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,title,url'],
				{ cwd, bin: this.#bin }
			);
			if (!out) return [];
			const raw = JSON.parse(out) as Array<{ number: number; title: string; url: string }>;
			return raw.map((i) => ({ number: i.number, title: i.title, url: i.url }));
		};
		return { issues: await list('issue'), prs: await list('pr') };
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

/** An `owner` login — the only board-adjacent string we interpolate; validated at ingress. */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** Validate a GitHub owner login at the boundary (D-008). @throws on a malformed login. */
export function assertOwner(owner: string): string {
	if (typeof owner !== 'string' || !OWNER_RE.test(owner)) {
		throw new Error(`invalid GitHub owner login: ${JSON.stringify(owner)}`);
	}
	return owner;
}

/**
 * The real GitHub Projects (v2) board client (production). Uses `gh project` subcommands
 * (which speak the v2 GraphQL API under the hood) through the runGh boundary — array args,
 * no shell (D-008). Credentials are the operator's gh auth / GH_TOKEN (D-026); a board needs
 * the `project` scope, so an unauthorized token surfaces an honest gh error (F-008).
 */
export class GitHubBoardCliClient implements GitHubBoardClient {
	readonly #bin: string | undefined;
	constructor(opts: { bin?: string } = {}) {
		this.#bin = opts.bin;
	}

	async resolveBoard(owner: string, number: number, cwd: string): Promise<BoardInfo | null> {
		assertOwner(owner);
		if (!Number.isInteger(number) || number <= 0) {
			throw new Error(`invalid board number: ${String(number)}`);
		}
		// `gh project view` gives the board node id; `field-list` gives the Status options.
		let boardId: string;
		try {
			const viewOut = await runGh(
				['project', 'view', String(number), '--owner', owner, '--format', 'json'],
				{ cwd, bin: this.#bin }
			);
			boardId = String((JSON.parse(viewOut) as { id?: string }).id ?? '');
			if (!boardId) return null;
		} catch {
			return null;
		}
		try {
			const fieldsOut = await runGh(
				['project', 'field-list', String(number), '--owner', owner, '--format', 'json'],
				{ cwd, bin: this.#bin }
			);
			const fields = (JSON.parse(fieldsOut) as { fields?: GhField[] }).fields ?? [];
			const status = fields.find((f) => f.name === 'Status' && Array.isArray(f.options));
			return {
				projectId: boardId,
				statusFieldId: status?.id ?? null,
				columns: (status?.options ?? []).map((o) => ({ id: o.id, name: o.name }))
			};
		} catch {
			return { projectId: boardId, statusFieldId: null, columns: [] };
		}
	}

	async addIssueToBoard(boardId: string, issueUrl: string, cwd: string): Promise<BoardItem> {
		// `gh project item-add` is idempotent on the API side (a same-url add returns the item).
		const out = await runGh(
			['project', 'item-add', '--owner', '@me', '--url', issueUrl, '--format', 'json'],
			{ cwd, bin: this.#bin }
		).catch(async () => {
			// `--owner @me` may not match an org board; retry letting gh resolve from the url.
			return runGh(['project', 'item-add', '--url', issueUrl, '--format', 'json'], {
				cwd,
				bin: this.#bin
			});
		});
		const itemId = String((JSON.parse(out) as { id?: string }).id ?? '');
		if (!itemId) throw new Error(`could not resolve board item id for ${issueUrl}`);
		return { itemId };
	}

	async setItemStatus(
		boardId: string,
		itemId: string,
		statusFieldId: string,
		optionId: string,
		cwd: string
	): Promise<void> {
		await runGh(
			[
				'project',
				'item-edit',
				'--id',
				itemId,
				'--project-id',
				boardId,
				'--field-id',
				statusFieldId,
				'--single-select-option-id',
				optionId,
				'--format',
				'json'
			],
			{ cwd, bin: this.#bin }
		);
	}
}

interface GhFieldOption {
	id: string;
	name: string;
}
interface GhField {
	id: string;
	name: string;
	options?: GhFieldOption[];
}
