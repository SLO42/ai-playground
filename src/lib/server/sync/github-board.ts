// TASK 11.4 — the GitHub project-BOARD SyncAdapter (D-037 extension of the 9.4 reference;
// GAP-ANALYSIS §1.1 / wave v1.7). ONE-WAY push first: it reflects each synced task's STATUS
// onto a GitHub Projects (v2) board column, per a configurable per-project mapping.
//
// It REUSES the 9.4 seam wholesale — the SyncAdapter interface, the SyncRegistry, and the
// `task_sync` issue mappings (listMappings). A board item is anchored on the task's ISSUE
// (so the issue↔task sync must have run first); board sync then sets that issue's board-item
// Status field to the column the project's `board_sync_config` maps its status to. It does
// NOT duplicate the issue logic — it composes it.
//
// HONESTY (F-008): the adapter probes the board (auth + a resolvable board + a Status field);
// when unavailable it returns an honest reason, never a fake sync. Every failure is RECORDED
// (recordSyncIncident) — never swallowed silently. The per-task push collects per-item errors
// without aborting the whole run; the aggregate carries honest counts.
//
// Boundary discipline (D-016): ids pass the db/validate chokepoint via the repos it calls;
// the owner/board-number are validated at the gh-client ingress (assertOwner). Credentials
// are operator-supplied (gh auth / GH_TOKEN, project scope) and never read or logged here.

import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import {
	GitHubBoardCliClient,
	type GitHubBoardClient,
	type BoardInfo
} from './gh-client';
import { listMappings } from './github';
import {
	getBoardConfig,
	recordBoardSyncResult,
	recordSyncIncident,
	type BoardSyncConfigRow
} from './board-repo';
import { listTasksByProject, type TaskRow } from '../tasks/repo';
import type {
	SyncAdapter,
	SyncProbe,
	SyncResult,
	SyncRunOptions,
	SyncItemResult
} from './adapter';

const PROVIDER = 'github-board';

export interface GitHubBoardSyncAdapterOptions {
	/** Inject a fake board client (tests). Default = the real gh project boundary. */
	client?: GitHubBoardClient;
}

/** Derive the board owner login from an `owner/repo` slug. */
function ownerOf(repoSlug: string): string {
	return repoSlug.split('/')[0] ?? '';
}

/**
 * The GitHub project-BOARD adapter. One-way push: task status → board column. Opt-in +
 * configurable per project via `board_sync_config`. Idempotent — adding an issue to a board
 * and setting its Status are both safe to repeat.
 */
export class GitHubBoardSyncAdapter implements SyncAdapter {
	readonly id = PROVIDER;
	readonly label = 'GitHub project board';
	readonly #client: GitHubBoardClient;

	constructor(opts: GitHubBoardSyncAdapterOptions = {}) {
		this.#client = opts.client ?? new GitHubBoardCliClient();
	}

	/**
	 * Honest probe. Board sync is available when: a repo resolves (for the owner), the project
	 * has an ENABLED config with a board number, and the board resolves with a Status field.
	 * The repo is passed in via opts.target on the run; the probe takes the resolved repo from
	 * the caller (the route resolves it once via the issue adapter's probe).
	 */
	async probe(opts: { cwd: string; repo?: string; config?: BoardSyncConfigRow | null }): Promise<SyncProbe> {
		try {
			const config = opts.config;
			if (!config || !config.enabled) {
				return { available: false, reason: 'Board sync is not enabled for this project.' };
			}
			if (config.boardNumber == null) {
				return { available: false, reason: 'No board number configured.' };
			}
			if (!opts.repo) {
				return { available: false, reason: 'No GitHub repository resolved for this project.' };
			}
			const owner = ownerOf(opts.repo);
			const board = await this.#client.resolveBoard(owner, config.boardNumber, opts.cwd);
			if (!board) {
				return {
					available: false,
					reason: `Board #${config.boardNumber} not found for ${owner} (check the number + the gh "project" scope).`
				};
			}
			if (!board.statusFieldId) {
				return { available: false, reason: 'The board has no "Status" field to map columns to.' };
			}
			return { available: true, target: `${owner} · board #${config.boardNumber}` };
		} catch (err) {
			return { available: false, reason: (err as Error).message };
		}
	}

	/**
	 * Push each synced task's status onto its board column. Requires the issue↔task mappings
	 * (the board item is anchored on the issue). Records the honest run result + an incident
	 * on failure. The `direction` is forced to "push" (one-way first); a non-push request is
	 * an honest skip rather than a silent no-op.
	 */
	async sync(db: Db, opts: SyncRunOptions & { repo?: string }): Promise<SyncResult> {
		const projectId = assertRecordId(opts.projectId);
		const dryRun = opts.dryRun ?? false;
		const repo = opts.repo;

		const result: SyncResult = {
			target: repo ? `${ownerOf(repo)} board` : 'board',
			direction: 'push',
			dryRun,
			created: 0,
			updated: 0,
			pulled: 0,
			linked: 0,
			skipped: 0,
			items: [],
			errors: []
		};

		try {
			const config = await getBoardConfig(db, projectId);
			if (!config || !config.enabled) throw new Error('Board sync is not enabled for this project.');
			if (config.boardNumber == null) throw new Error('No board number configured.');
			if (!repo) throw new Error('No GitHub repository resolved for this project.');

			const owner = ownerOf(repo);
			const board = await this.#client.resolveBoard(owner, config.boardNumber, opts.cwd);
			if (!board) throw new Error(`Board #${config.boardNumber} not found for ${owner}.`);
			if (!board.statusFieldId) throw new Error('The board has no "Status" field.');
			result.target = `${owner} · board #${config.boardNumber}`;

			const tasks = await listTasksByProject(db, projectId);
			const mappings = await listMappings(db, projectId, repo);
			const issueUrlByTask = new Map(
				mappings.filter((m) => m.external_url).map((m) => [m.task, m.external_url as string])
			);

			for (const task of tasks) {
				const item = await this.#pushOne(task, {
					board,
					config,
					issueUrl: issueUrlByTask.get(task.id),
					cwd: opts.cwd,
					dryRun
				}).catch((err): SyncItemResult => ({
					taskId: task.id,
					action: 'error',
					error: (err as Error).message
				}));
				result.items.push(item);
				if (item.action === 'updated') result.updated++;
				else if (item.action === 'created') result.created++;
				else if (item.action === 'skipped') result.skipped++;
				else if (item.action === 'error') result.errors.push(`${task.id}: ${item.error}`);
			}

			if (!dryRun) {
				await recordBoardSyncResult(db, projectId, { status: 'ok' });
			}
			return result;
		} catch (err) {
			const message = (err as Error).message;
			result.errors.push(message);
			if (!dryRun) {
				await recordBoardSyncResult(db, projectId, { status: 'error', error: message });
				await recordSyncIncident(db, { project: projectId, adapter: PROVIDER, message }).catch(
					() => {}
				);
			}
			return result;
		}
	}

	/** Push one task's status to its board column. */
	async #pushOne(
		task: TaskRow,
		ctx: {
			board: BoardInfo;
			config: BoardSyncConfigRow;
			issueUrl: string | undefined;
			cwd: string;
			dryRun: boolean;
		}
	): Promise<SyncItemResult> {
		const columnName = ctx.config.mapping[task.status];
		if (!columnName) {
			// No mapping for this status — honest skip (the operator hasn't mapped it).
			return { taskId: task.id, action: 'skipped' };
		}
		if (!ctx.issueUrl) {
			// No issue mapping yet — the issue↔task sync must run first. Honest skip.
			return { taskId: task.id, action: 'skipped' };
		}
		const column = ctx.board.columns.find((c) => c.name === columnName);
		if (!column) {
			throw new Error(`board has no column named "${columnName}" for status "${task.status}"`);
		}
		if (ctx.dryRun) {
			return { taskId: task.id, action: 'updated', externalUrl: ctx.issueUrl };
		}
		const item = await this.#client.addIssueToBoard(ctx.board.projectId, ctx.issueUrl, ctx.cwd);
		await this.#client.setItemStatus(
			ctx.board.projectId,
			item.itemId,
			ctx.board.statusFieldId as string,
			column.id,
			ctx.cwd
		);
		return { taskId: task.id, action: 'updated', externalId: item.itemId, externalUrl: ctx.issueUrl };
	}
}
