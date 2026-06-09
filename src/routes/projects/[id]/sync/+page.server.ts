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
import { getSyncRegistry, listMappings, type SyncProbe, type SyncResult } from '$lib/server/sync';
import { assertRecordId } from '$lib/server/db/validate';
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
		return { connected: false, projectId, mappings: [], directions: DIRECTIONS };
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
			directions: DIRECTIONS
		};
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return {
			connected: false,
			projectId,
			mappings: [],
			directions: DIRECTIONS,
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
	}
};
