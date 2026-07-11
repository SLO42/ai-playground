// TASK 9.4 — /projects/[id]/sync, the GitHub task↔issue sync surface (D-037; F-008; D-026).
//
// Serves the sync surface for one project: the resolved GitHub target + auth state (an
// HONEST probe — F-008/D-019, never a fabricated "connected"), the existing task↔issue
// mappings (each a REAL `task_sync` row), and a form to run a sync (push / pull / both,
// with a dry-run preview). The `?/sync` action drives the reference SyncAdapter (github),
// which is idempotent (dedup by the stored mapping) and degrades honestly when gh is
// unauthenticated. Credentials are operator-supplied (gh auth / GH_TOKEN), never committed
// (D-026) — the server never reads or echoes a token.
//
// Live: the SSE `task` / `task_sync` watchers re-invalidate this loader so a sync that
// changes a task status (pull) or adds a mapping (push) updates the surface in place.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { getProject } from '$lib/server/projects/repo';
import { TASK_STATUSES } from '$lib/server/tasks/repo';
import {
	getSyncRegistry,
	listMappings,
	getBoardConfig,
	saveBoardConfig,
	recordSyncIncident,
	listSyncIncidents,
	GitHubBoardSyncAdapter,
	type SyncProbe,
	type SyncResult,
	type BoardSyncConfigRow,
	type SyncIncidentRow
} from '$lib/server/sync';
import { assertRecordId } from '$lib/server/db/validate';
import { activePmTriggerEngine } from '$lib/server/projects/pm-triggers';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

const ADAPTER_ID = 'github';
const DIRECTIONS = ['push', 'pull', 'both'] as const;
type Direction = (typeof DIRECTIONS)[number];

interface MappingView {
	taskId: string;
	externalId: string;
	externalUrl?: string;
	direction: string;
	lastSynced: string;
}

export interface SyncPageData {
	connected: boolean;
	projectId: string;
	projectName?: string;
	repoUrl?: string;
	/** The adapter's honest probe (available + target, or unavailable + reason). */
	probe?: SyncProbe;
	mappings: MappingView[];
	directions: readonly Direction[];
	/** The set of task statuses — the rows of the board-column mapping form. */
	taskStatuses: readonly string[];
	/** The project's board-sync config (opt-in mapping + honest last-run status), or null. */
	boardConfig: BoardSyncConfigRow | null;
	/** The board adapter's honest probe (available + target, or unavailable + reason). */
	boardProbe?: SyncProbe;
	/** Recent sync incidents (failures — never silent, F-008). */
	incidents: SyncIncidentRow[];
	error?: string;
}

export const load: PageServerLoad = async ({ params, depends }): Promise<SyncPageData> => {
	depends('app:sync');
	depends('app:tasks');

	let projectId: string;
	try {
		projectId = assertRecordId(`project:${params.id}`);
	} catch {
		throw error(404, 'invalid project id');
	}

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			projectId,
			mappings: [],
			directions: DIRECTIONS,
			taskStatuses: TASK_STATUSES,
			boardConfig: null,
			incidents: []
		};
	}

	try {
		const project = await getProject(db, projectId);
		if (!project) throw error(404, 'project not found');

		const adapter = getSyncRegistry().get(ADAPTER_ID);
		// Probe is side-effect-free + never throws (honest degrade). The project root is the
		// cwd gh resolves the repo from.
		const probe = await adapter.probe({ cwd: project.root_path });
		// Mappings are read against the probed target when available; otherwise we still show
		// any previously-synced mappings for the repo derived from repo_url, honestly.
		const repo = probe.target ?? repoFromUrl(project.repo_url);
		const mappings = repo ? await listMappings(db, projectId, repo) : [];

		// Board sync (TASK 11.4): the per-project opt-in config + an honest board probe + the
		// recorded incidents (failures, never silent — F-008).
		const boardConfig = await getBoardConfig(db, projectId);
		const boardAdapter = new GitHubBoardSyncAdapter();
		const boardProbe = await boardAdapter.probe({
			cwd: project.root_path,
			...(repo ? { repo } : {}),
			config: boardConfig
		});
		const incidents = await listSyncIncidents(db, projectId);

		return {
			connected: true,
			projectId,
			projectName: project.name,
			...(project.repo_url ? { repoUrl: project.repo_url } : {}),
			probe,
			mappings: mappings.map((m) => ({
				taskId: m.task,
				externalId: m.external_id,
				...(m.external_url ? { externalUrl: m.external_url } : {}),
				direction: m.direction,
				lastSynced: m.last_synced
			})),
			directions: DIRECTIONS,
			taskStatuses: TASK_STATUSES,
			boardConfig,
			boardProbe,
			incidents
		};
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return {
			connected: false,
			projectId,
			mappings: [],
			directions: DIRECTIONS,
			taskStatuses: TASK_STATUSES,
			boardConfig: null,
			incidents: [],
			error: (err as Error).message
		};
	}
};

/** Derive an `owner/repo` slug from a GitHub repo_url, or undefined. */
function repoFromUrl(url?: string): string | undefined {
	if (!url) return undefined;
	const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?\/?$/);
	return m?.[1];
}

export const actions: Actions = {
	/**
	 * Run a GitHub task↔issue sync (D-037 reference adapter). Idempotent (dedup by the stored
	 * mapping), honest when unauthenticated (F-008). The project id is the route param
	 * (validated); the direction + dryRun come from the form (validated against the enum).
	 */
	sync: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { sync: { error: 'invalid project id' } });
		}

		const form = await request.formData();
		const rawDir = form.get('direction');
		const direction: Direction = DIRECTIONS.includes(rawDir as Direction)
			? (rawDir as Direction)
			: 'both';
		const dryRun = form.get('dryRun') === 'on';

		const db = tryGetDb();
		if (!db) {
			return fail(503, { sync: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		const project = await getProject(db, projectId);
		if (!project) return fail(404, { sync: { error: 'project not found' } });

		const adapter = getSyncRegistry().get(ADAPTER_ID);
		// Honest precheck: if gh is unauthenticated / no repo, surface the reason — never a fake run.
		const probe = await adapter.probe({ cwd: project.root_path });
		if (!probe.available) {
			return fail(409, { sync: { error: probe.reason ?? 'GitHub sync is not available.' } });
		}

		try {
			const result: SyncResult = await adapter.sync(db, {
				projectId,
				cwd: project.root_path,
				direction,
				dryRun
			});

			// TASK 16.2 (PM-SPEC §3 event ②): forward detected GitHub issue/PR arrivals to
			// the live PM trigger engine. The engine applies EVERY gate itself (D-004 mode,
			// hired PM, authority, persistent dedup); no engine (degraded boot / manual-only
			// mode) is an honest no-op. A dry-run previews — it never wakes the PM.
			if (!dryRun && result.arrivals?.length) {
				const engine = activePmTriggerEngine();
				if (engine) {
					await engine
						.githubArrival(projectId, result.arrivals)
						.catch((err) => console.warn(`[sync] pm arrival trigger failed: ${(err as Error).message}`));
				}
			}

			return {
				sync: {
					ok: true as const,
					target: result.target,
					direction: result.direction,
					dryRun: result.dryRun,
					created: result.created,
					updated: result.updated,
					pulled: result.pulled,
					linked: result.linked,
					skipped: result.skipped,
					errors: result.errors
				}
			};
		} catch (err) {
			return fail(500, { sync: { error: (err as Error).message } });
		}
	},

	/**
	 * Save the per-project board-sync config (TASK 11.4): the opt-in `enabled` gate, the board
	 * number, and the task-status → board-column NAME mapping. Validated at the boundary — the
	 * project id (route param), the board number (positive int when set), and the mapping keys
	 * (only known task statuses are persisted; an unknown key is dropped). Idempotent upsert.
	 */
	saveBoard: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { board: { error: 'invalid project id' } });
		}

		const db = tryGetDb();
		if (!db) {
			return fail(503, { board: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		const form = await request.formData();
		const enabled = form.get('enabled') === 'on';
		const rawBoard = String(form.get('boardNumber') ?? '').trim();
		let boardNumber: number | undefined;
		if (rawBoard) {
			const n = Number(rawBoard);
			if (!Number.isInteger(n) || n <= 0) {
				return fail(400, { board: { error: 'Board number must be a positive integer.' } });
			}
			boardNumber = n;
		}
		// One mapping value per task status (column name). Empty values are omitted.
		const mapping: Record<string, string> = {};
		for (const status of TASK_STATUSES) {
			const col = String(form.get(`map_${status}`) ?? '').trim();
			if (col) mapping[status] = col;
		}

		try {
			const saved = await saveBoardConfig(db, {
				project: projectId,
				enabled,
				...(boardNumber != null ? { boardNumber } : {}),
				mapping
			});
			return { board: { ok: true as const, action: 'config', enabled: saved.enabled } };
		} catch (err) {
			return fail(500, { board: { error: (err as Error).message } });
		}
	},

	/**
	 * Run a GitHub project-BOARD sync (TASK 11.4 — one-way push: task status → board column).
	 * Honest precheck via the board adapter probe; a failed run RECORDS an incident (never
	 * silent, F-008). Idempotent (adding to a board + setting Status are safe to repeat).
	 */
	syncBoard: async ({ params }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { board: { error: 'invalid project id' } });
		}

		const db = tryGetDb();
		if (!db) {
			return fail(503, { board: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		const project = await getProject(db, projectId);
		if (!project) return fail(404, { board: { error: 'project not found' } });

		// Resolve the repo via the issue adapter's probe (the board owner derives from it).
		const issueAdapter = getSyncRegistry().get(ADAPTER_ID);
		const issueProbe = await issueAdapter.probe({ cwd: project.root_path });
		const repo = issueProbe.target ?? repoFromUrl(project.repo_url);

		const boardConfig = await getBoardConfig(db, projectId);
		const boardAdapter = new GitHubBoardSyncAdapter();
		const probe = await boardAdapter.probe({
			cwd: project.root_path,
			...(repo ? { repo } : {}),
			config: boardConfig
		});
		if (!probe.available) {
			// Record the unavailable reason as an incident so it is never silent.
			await recordSyncIncident(db, {
				project: projectId,
				adapter: 'github-board',
				message: probe.reason ?? 'board sync unavailable'
			}).catch(() => {});
			return fail(409, { board: { error: probe.reason ?? 'Board sync is not available.' } });
		}

		try {
			const result = await boardAdapter.sync(db, {
				projectId,
				cwd: project.root_path,
				direction: 'push',
				dryRun: false, // board push is a real mutation (no dry-run UI); explicit per SYN-1
				...(repo ? { repo } : {})
			});
			return {
				board: {
					ok: true as const,
					action: 'sync',
					target: result.target,
					updated: result.updated,
					skipped: result.skipped,
					errors: result.errors
				}
			};
		} catch (err) {
			return fail(500, { board: { error: (err as Error).message } });
		}
	}
};
