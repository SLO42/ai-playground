// TASK 9.4 — the GitHub task↔issue SyncAdapter (D-037 reference impl; D-008/D-016/D-026).
//
// Reconciles an Atelier project's `task` rows with GitHub issues, idempotently:
//   • PUSH — a task with no mapping → create an issue (labelled, body carries the task id +
//     status); a mapped task whose status changed → update the issue (state + labels).
//   • PULL — a mapped issue whose state changed → reflect it onto the task's status (via the
//     status state machine, so an illegal transition is skipped honestly, not forced).
//   • DEDUP — the `task_sync` ledger (migration 0024) is the idempotency key. Before
//     creating, we look up the mapping by task; a same-title issue already on GitHub is
//     LINKED (not duplicated). The UNIQUE dedup indexes make a concurrent double-create
//     collide rather than duplicate (D-008 — the TOCTOU class transactions alone don't fix).
//
// The `gh` CLI is reached ONLY through an injectable `GitHubClient` (default = the real
// runGh boundary, gh-client.ts). Tests inject a fake client so the FULL adapter logic +
// the real `task_sync` ledger run against a real SurrealDB with NO network/creds — and the
// live GitHub round-trip is a documented deferred proof.
//
// Boundary discipline: task/project ids pass the db/validate chokepoint (D-016) and bind as
// StringRecordId; the repo slug is validated (gh.assertRepoSlug); every value binds via
// $param. Credentials are never read or logged here (D-026) — gh authenticates itself.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { writeAgentEvent } from '../analytics/events';
import {
	canTransition,
	setStatus,
	TASK_STATUSES,
	type TaskStatus,
	type TaskRow
} from '../tasks/repo';
import { assertRepoSlug } from './gh';
import type {
	SyncAdapter,
	SyncProbe,
	SyncResult,
	SyncRunOptions,
	SyncItemResult,
	SyncDirection
} from './adapter';
import { GitHubCliClient, type GitHubClient, type GitHubIssue } from './gh-client';

const PROVIDER = 'github';
const SYNC_LABEL = 'atelier-task';

// ── status ↔ issue-state mapping ────────────────────────────────────────────────
// A GitHub issue is binary open/closed; an Atelier task has a 7-state machine. We carry the
// finer status as a `status:<s>` label so a round-trip is lossless, and map open/closed to a
// representative task status on pull (respecting the state machine — never forcing it).

/** The label set an issue carries for a task (sync marker + status + priority). */
function labelsForTask(task: Pick<TaskRow, 'status' | 'priority'>): string[] {
	return [SYNC_LABEL, `status:${task.status}`, `priority:${task.priority}`];
}

/** True iff a task status should present as a CLOSED issue (terminal states —
 *  including 16.4's terminal 'withdrawn': a withdrawn proposal that somehow holds a
 *  mapping must close its issue, never be (re-)asserted as OPEN on every sync). */
function isClosedStatus(status: TaskStatus): boolean {
	return status === 'done' || status === 'failed' || status === 'withdrawn';
}

// ── TASK 16.4 fix — the proposal ceremony is INTERNAL (PM-SPEC §4) ───────────────
// pm-proposals' rail: a 'proposed' task "touches nothing external". The push loop
// previously selected EVERY project task unfiltered, so an undecided proposal became
// a real open GitHub issue on the operator's next sync — bypassing the validation/
// brief ceremony at the external boundary. The pull side is fenced for the same
// reason: a GitHub label edit must never decide a proposal (promote/withdraw runs
// verdict-closure + brief ceremony that a bare status write would orphan).

/** Statuses that exist on GitHub at all. 'proposed' is invisible until decided;
 *  an unmapped 'withdrawn' proposal died before ever reaching the mirror. Derived
 *  from the canonical enum so a future widening cannot silently drift past sync. */
const CEREMONY_STATUSES: readonly TaskStatus[] = ['proposed', 'withdrawn'];

/** The statuses a pull may propose onto a task (the lossless `status:<s>` label
 *  round-trip) — the canonical enum MINUS the internal ceremony states. */
const PULLABLE_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
	(s) => !CEREMONY_STATUSES.includes(s)
);

/**
 * Map a GitHub issue back to the task status it implies. Prefer the explicit `status:<s>`
 * label (lossless round-trip); fall back to open→in_progress / closed→done. The CALLER
 * still gates the move through the state machine (canTransition) — this only proposes.
 */
export function issueToTaskStatus(issue: GitHubIssue): TaskStatus {
	const fromLabel = issue.labels
		.map((l) => l.name)
		.find((n) => n.startsWith('status:'))
		?.slice('status:'.length);
	// 16.4 fix: derived from TASK_STATUSES (the inline copy here had drifted from the
	// widened enum); 'proposed'/'withdrawn' stay DELIBERATELY unpullable — a GitHub
	// label edit must not drive the internal proposal ceremony.
	if (fromLabel && (PULLABLE_STATUSES as readonly string[]).includes(fromLabel)) {
		return fromLabel as TaskStatus;
	}
	return issue.state === 'closed' ? 'done' : 'in_progress';
}

/** The issue body for a task — description + a machine-readable footer carrying the link. */
export function issueBodyForTask(task: TaskRow): string {
	return [
		task.description?.trim() || '_No description._',
		'',
		'---',
		`<!-- atelier:task=${task.id} -->`,
		`**Atelier task** \`${task.id}\` · status \`${task.status}\` · priority \`${task.priority}\``,
		'_Synced from Atelier._'
	].join('\n');
}

// ── the sync ledger (task_sync) — the idempotency store ──────────────────────────

interface SyncMappingRow {
	id: string;
	task: string;
	project: string;
	provider: string;
	repo: string;
	external_id: string;
	external_url?: string;
	direction: string;
	last_synced: string;
}

function normMapping(r: Record<string, unknown>): SyncMappingRow {
	return {
		id: String(r.id),
		task: String(r.task),
		project: String(r.project),
		provider: String(r.provider),
		repo: String(r.repo),
		external_id: String(r.external_id),
		external_url: r.external_url != null ? String(r.external_url) : undefined,
		direction: String(r.direction ?? 'both'),
		last_synced: String(r.last_synced)
	};
}

/** All mappings for one project+repo (the read model + the dedup lookup source). */
export async function listMappings(
	db: Db,
	projectId: string,
	repo: string
): Promise<SyncMappingRow[]> {
	const project = new StringRecordId(assertRecordId(projectId));
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT * FROM task_sync WHERE project = $project AND provider = $provider AND repo = $repo ORDER BY last_synced DESC;`,
		{ project, provider: PROVIDER, repo }
	);
	return rows.map(normMapping);
}

/**
 * Upsert one task↔issue mapping (idempotent). Looks up by the (provider, repo, task)
 * dedup; UPDATEs if present, else CREATEs. The UNIQUE indexes on task_sync mean a
 * concurrent double-create collides on insert rather than duplicating (D-008).
 */
async function upsertMapping(
	db: Db,
	input: {
		taskId: string;
		projectId: string;
		repo: string;
		externalId: string;
		externalUrl?: string;
		direction: SyncDirection;
	}
): Promise<void> {
	const task = new StringRecordId(assertRecordId(input.taskId));
	const project = new StringRecordId(assertRecordId(input.projectId));
	// Find an existing mapping for this task in this repo.
	const [existing] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM task_sync WHERE task = $task AND provider = $provider AND repo = $repo LIMIT 1;`,
		{ task, provider: PROVIDER, repo: input.repo }
	);
	const content = {
		task,
		project,
		provider: PROVIDER,
		repo: input.repo,
		external_id: input.externalId,
		...(input.externalUrl !== undefined ? { external_url: input.externalUrl } : {}),
		direction: input.direction,
		last_synced: new Date()
	};
	if (existing.length) {
		const rid = new StringRecordId(assertRecordId(String(existing[0].id)));
		await db.query(`UPDATE $rid MERGE $content;`, { rid, content });
	} else {
		await db.query(`CREATE task_sync CONTENT $content;`, { content });
	}
}

// ── the adapter ──────────────────────────────────────────────────────────────────

export interface GitHubSyncAdapterOptions {
	/** Inject a fake GitHub client (tests). Default = the real gh CLI boundary. */
	client?: GitHubClient;
}

export class GitHubSyncAdapter implements SyncAdapter {
	readonly id = PROVIDER;
	readonly label = 'GitHub Issues';
	readonly #client: GitHubClient;

	constructor(opts: GitHubSyncAdapterOptions = {}) {
		this.#client = opts.client ?? new GitHubCliClient();
	}

	async probe(opts: { cwd: string }): Promise<SyncProbe> {
		// Never throws — an unauthenticated / repo-less project gets an HONEST reason (F-008).
		try {
			const auth = await this.#client.isAuthenticated(opts.cwd);
			if (!auth.ok) {
				return { available: false, reason: auth.reason ?? 'GitHub CLI is not authenticated.' };
			}
			const repo = await this.#client.resolveRepo(opts.cwd);
			if (!repo) {
				return {
					available: false,
					reason: 'No GitHub repository resolved for this project (set a remote or repo_url).'
				};
			}
			return { available: true, target: repo };
		} catch (err) {
			return { available: false, reason: (err as Error).message };
		}
	}

	async sync(db: Db, opts: SyncRunOptions): Promise<SyncResult> {
		const direction: SyncDirection = opts.direction ?? 'both';
		const dryRun = opts.dryRun ?? false;
		const projectId = assertRecordId(opts.projectId);

		const repo = await this.#client.resolveRepo(opts.cwd);
		if (!repo) {
			throw new Error('No GitHub repository resolved for this project.');
		}
		assertRepoSlug(repo);

		const result: SyncResult = {
			target: repo,
			direction,
			dryRun,
			created: 0,
			updated: 0,
			pulled: 0,
			linked: 0,
			skipped: 0,
			items: [],
			errors: []
		};

		// Load the live tasks + the existing mappings + the repo's atelier-labelled issues.
		const tasks = await loadProjectTasks(db, projectId);
		const mappings = await listMappings(db, projectId, repo);
		const issues = await this.#client.listIssues(repo, opts.cwd);

		const mapByTask = new Map(mappings.map((m) => [m.task, m]));
		const mapByExternal = new Map(mappings.map((m) => [m.external_id, m]));
		const issueByNumber = new Map(issues.map((i) => [String(i.number), i]));
		const issueByTitle = new Map(issues.map((i) => [i.title.toLowerCase().trim(), i]));

		// ── PUSH: tasks → issues ──────────────────────────────────────────────────
		if (direction === 'push' || direction === 'both') {
			for (const task of tasks) {
				try {
					const item = await this.#pushOne(db, {
						task,
						repo,
						cwd: opts.cwd,
						dryRun,
						direction,
						projectId,
						existing: mapByTask.get(task.id),
						issueByNumber,
						issueByTitle
					});
					result.items.push(item);
					if (item.action === 'created') result.created++;
					else if (item.action === 'updated') result.updated++;
					else if (item.action === 'linked') result.linked++;
					else if (item.action === 'skipped') result.skipped++;
				} catch (err) {
					const msg = `push ${task.id}: ${(err as Error).message}`;
					result.errors.push(msg);
					result.items.push({ taskId: task.id, action: 'error', error: msg });
				}
			}
		}

		// ── PULL: issues → tasks ──────────────────────────────────────────────────
		if (direction === 'pull' || direction === 'both') {
			// Re-read mappings (push may have added some) so a freshly-created issue can pull back.
			const fresh = await listMappings(db, projectId, repo);
			const freshByExternal = new Map(fresh.map((m) => [m.external_id, m]));
			for (const issue of issues) {
				const mapping = freshByExternal.get(String(issue.number)) ?? mapByExternal.get(String(issue.number));
				if (!mapping) continue; // unmapped issue — pull only what we own a mapping for
				try {
					const item = await this.#pullOne(db, { issue, mapping, dryRun });
					result.items.push(item);
					if (item.action === 'pulled') result.pulled++;
					else if (item.action === 'skipped') result.skipped++;
				} catch (err) {
					const msg = `pull #${issue.number}: ${(err as Error).message}`;
					result.errors.push(msg);
					result.items.push({ taskId: mapping.task, action: 'error', error: msg });
				}
			}
		}

		// ── TASK 16.2 — arrival detection (PM-SPEC §3 event ②) ─────────────────────────
		// An OPEN issue with NO task mapping was born on GitHub (everything pushed from
		// here is mapped the moment it is created/linked above); every OPEN PR is external
		// work arriving (the adapter never creates PRs). Read-only + best-effort: when the
		// client cannot list (or has no listOpenItems), the run records the reason / omits
		// `arrivals` honestly — a detection failure never fails the sync itself.
		if (this.#client.listOpenItems) {
			try {
				const open = await this.#client.listOpenItems(repo, opts.cwd);
				const fresh = await listMappings(db, projectId, repo);
				const mappedIds = new Set(fresh.map((m) => m.external_id));
				result.arrivals = [
					...open.issues
						.filter((i) => !mappedIds.has(String(i.number)))
						.map((i) => ({ kind: 'issue' as const, externalId: String(i.number), title: i.title, url: i.url })),
					...open.prs.map((p) => ({ kind: 'pr' as const, externalId: String(p.number), title: p.title, url: p.url }))
				];
			} catch (err) {
				result.errors.push(`arrival detection: ${(err as Error).message}`);
			}
		}

		// Analytics (first-class): one completion row carrying the how/why of this run.
		await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			detail: {
				ok: result.errors.length === 0,
				summary: `github sync ${direction}${dryRun ? ' (dry-run)' : ''} ${repo}: ` +
					`+${result.created} ~${result.updated} ↓${result.pulled} ⇄${result.linked} ·${result.skipped}`,
				reason: `task↔issue sync (D-037)`
			}
		}).catch(() => {
			/* analytics is best-effort — never fail a sync on a telemetry write */
		});

		return result;
	}

	/** Push one task to its issue (create / update / link / skip). */
	async #pushOne(
		db: Db,
		ctx: {
			task: TaskRow;
			repo: string;
			cwd: string;
			dryRun: boolean;
			direction: SyncDirection;
			projectId: string;
			existing: SyncMappingRow | undefined;
			issueByNumber: Map<string, GitHubIssue>;
			issueByTitle: Map<string, GitHubIssue>;
		}
	): Promise<SyncItemResult> {
		const { task, repo, cwd, dryRun, existing } = ctx;

		// 16.4 fix: an undecided proposal NEVER touches GitHub (create, link, or
		// update) — the ceremony is internal until the panel/operator decides it.
		if (task.status === 'proposed') {
			return { taskId: task.id, action: 'skipped' };
		}
		// 16.4 fix: a withdrawn proposal that never reached the mirror stays off it —
		// creating a brand-new OPEN issue for a dead proposal would be pure noise.
		// (A MAPPED withdrawn task falls through: its issue must close, below.)
		if (!existing && task.status === 'withdrawn') {
			return { taskId: task.id, action: 'skipped' };
		}

		if (existing) {
			// Idempotent UPDATE: reflect the task's current state onto the mapped issue.
			const issue = ctx.issueByNumber.get(existing.external_id);
			const desiredClosed = isClosedStatus(task.status);
			if (!dryRun) {
				await this.#client.updateIssue(repo, Number(existing.external_id), {
					labels: labelsForTask(task),
					state: desiredClosed ? 'closed' : 'open',
					cwd
				});
				await upsertMapping(db, {
					taskId: task.id,
					projectId: ctx.projectId,
					repo,
					externalId: existing.external_id,
					externalUrl: existing.external_url,
					direction: ctx.direction
				});
			}
			return {
				taskId: task.id,
				action: 'updated',
				externalId: existing.external_id,
				externalUrl: existing.external_url ?? issue?.url
			};
		}

		// No mapping yet — but the SAME-TITLE issue may already exist on GitHub: LINK it
		// (dedup) rather than create a duplicate.
		const dup = ctx.issueByTitle.get(task.title.toLowerCase().trim());
		if (dup) {
			if (!dryRun) {
				await upsertMapping(db, {
					taskId: task.id,
					projectId: ctx.projectId,
					repo,
					externalId: String(dup.number),
					externalUrl: dup.url,
					direction: ctx.direction
				});
			}
			return { taskId: task.id, action: 'linked', externalId: String(dup.number), externalUrl: dup.url };
		}

		// Genuinely new — create the issue.
		if (dryRun) {
			return { taskId: task.id, action: 'created' };
		}
		const created = await this.#client.createIssue(repo, {
			title: task.title,
			body: issueBodyForTask(task),
			labels: labelsForTask(task),
			cwd
		});
		await upsertMapping(db, {
			taskId: task.id,
			projectId: ctx.projectId,
			repo,
			externalId: String(created.number),
			externalUrl: created.url,
			direction: ctx.direction
		});
		return {
			taskId: task.id,
			action: 'created',
			externalId: String(created.number),
			externalUrl: created.url
		};
	}

	/** Pull one mapped issue's state back onto its task (via the status state machine). */
	async #pullOne(
		db: Db,
		ctx: { issue: GitHubIssue; mapping: SyncMappingRow; dryRun: boolean }
	): Promise<SyncItemResult> {
		const { issue, mapping, dryRun } = ctx;
		const task = await getTaskRow(db, mapping.task);
		if (!task) {
			return { taskId: mapping.task, action: 'skipped', externalId: mapping.external_id };
		}
		// 16.4 fix: a 'proposed' task is decided ONLY by the validation panel / the
		// operator's brief — never by a GitHub edit (which would skip verdict closure
		// and brief supersession). Honest skip, like an illegal transition.
		if (task.status === 'proposed') {
			return {
				taskId: task.id,
				action: 'skipped',
				externalId: mapping.external_id,
				externalUrl: mapping.external_url ?? issue.url
			};
		}
		const proposed = issueToTaskStatus(issue);
		// Identity or an illegal transition → honest skip (never force an out-of-machine move).
		if (proposed === task.status || !canTransition(task.status, proposed)) {
			return {
				taskId: task.id,
				action: 'skipped',
				externalId: mapping.external_id,
				externalUrl: mapping.external_url ?? issue.url
			};
		}
		if (!dryRun) {
			await setStatus(db, task.id, proposed);
			await upsertMapping(db, {
				taskId: task.id,
				projectId: mapping.project,
				repo: mapping.repo,
				externalId: mapping.external_id,
				externalUrl: mapping.external_url ?? issue.url,
				direction: mapping.direction as SyncDirection
			});
		}
		return {
			taskId: task.id,
			action: 'pulled',
			externalId: mapping.external_id,
			externalUrl: mapping.external_url ?? issue.url
		};
	}
}

// ── task reads (local helpers — keep the adapter self-contained) ──────────────────

function normTaskRow(r: Record<string, unknown>): TaskRow {
	return {
		id: String(r.id),
		project: String(r.project),
		title: String(r.title),
		description: String(r.description ?? ''),
		status: String(r.status) as TaskStatus,
		priority: r.priority as TaskRow['priority'],
		origin: r.origin as TaskRow['origin'],
		...(r.parent != null ? { parent: String(r.parent) } : {}),
		created_at: String(r.created_at),
		updated_at: String(r.updated_at)
	};
}

async function loadProjectTasks(db: Db, projectId: string): Promise<TaskRow[]> {
	const project = new StringRecordId(assertRecordId(projectId));
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT * FROM task WHERE project = $project ORDER BY created_at DESC;`,
		{ project }
	);
	return rows.map(normTaskRow);
}

async function getTaskRow(db: Db, taskId: string): Promise<TaskRow | null> {
	const rid = new StringRecordId(assertRecordId(taskId));
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, { rid });
	return rows.length ? normTaskRow(rows[0]) : null;
}
