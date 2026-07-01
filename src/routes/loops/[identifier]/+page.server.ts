// LOOPS DETAIL — the per-loop review + configure page loader (/loops/[identifier]; operator directive
// 2026-06-29 "Loops = first-class · visuals · identifiers · review/modify/configure"). Loads ONE loop by
// its stable identifier: its RUNNING view (getLoops, joined on id === identifier), its DECLARED manifest
// row (getLoopManifest), and its DEEP run history (getLoopRuns, bounded DETAIL_RUN_LIMIT). Honest states
// (F-008/D-019): no DB ⇒ connected:false (the page renders a disconnected panel, never a fabricated loop);
// a dead handle ⇒ the same honest degrade; a live DB with NO such loop (neither declared nor running) ⇒ a
// real 404 (never an invented card). The route KEY is the URL-encoded identifier (identifiers carry ':');
// links encode, this loader decodes. Datetimes leave as ISO strings only (F-013 — via the normalizers).

import { error, fail, isHttpError } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import { assertRecordId } from '$lib/server/db/validate';
import { getProject } from '$lib/server/projects/repo';
import {
	getLoops,
	getLoopRuns,
	DETAIL_RUN_LIMIT,
	type LoopView,
	type LoopRun
} from '$lib/server/loops/read';
import {
	getLoopManifest,
	upsertLoopManifest,
	setLoopEnabled,
	type LoopManifestRow,
	type LoopManifestKind
} from '$lib/server/loops/manifest';
import { actions as loopsActions } from '../+page.server';
import type { PageServerLoad, Actions } from './$types';

export interface LoopDetailData {
	connected: boolean;
	/** The decoded loop identifier this page is about (always set, even when disconnected). */
	identifier: string;
	/** The live running view, or null when the loop is declared-but-not-running (honest). */
	loop: LoopView | null;
	/** The declared manifest row, or null when the loop is running-but-undeclared. */
	manifest: LoopManifestRow | null;
	/** The loop's deep run history (screened + ISO), or [] for a no-history-by-design / never-run loop. */
	runs: LoopRun[];
	/** True when this loop surfaces a per-run history at all. */
	tracksHistory: boolean;
	/** The cap applied to `runs` (honesty — the list may be truncated at this depth). */
	runLimit: number;
	/** The owning project's display name (project-scoped loops), or null. */
	projectName: string | null;
}

/** Decode a URL-encoded route segment; SvelteKit already decodes params, so this is a guarded no-op for a
 *  plain identifier (which never contains '%') and correctly decodes an explicitly-encoded one (tests). */
function decodeIdentifier(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

function disconnected(identifier: string): LoopDetailData {
	return {
		connected: false,
		identifier,
		loop: null,
		manifest: null,
		runs: [],
		tracksHistory: false,
		runLimit: DETAIL_RUN_LIMIT,
		projectName: null
	};
}

export const load: PageServerLoad = async ({ params, depends }): Promise<LoopDetailData> => {
	// Live by default (§1.2): the SAME dependency keys the list page uses — a run event / PM change /
	// session change / manifest change re-invalidates and re-derives this detail in place.
	depends('app:loops');
	depends('app:analytics');
	depends('app:pm');
	depends('app:fleet');
	depends('app:projects');
	depends('app:loops-manifest');

	const identifier = decodeIdentifier(params.identifier);
	const db = tryGetDb();
	if (!db) return disconnected(identifier);

	try {
		const [loops, manifest] = await Promise.all([getLoops(db), getLoopManifest(db, identifier)]);
		const loop = loops.find((l) => l.id === identifier) ?? null;

		// Honest 404: the DB is live but this identifier is neither a running loop nor a declared one — do
		// NOT fabricate a card (F-008). A declared-not-running OR a running-undeclared loop DOES render.
		if (!loop && !manifest) throw error(404, `no loop with identifier "${identifier}"`);

		// Run history: prefer the running view; fall back to a minimal identity from the manifest so a
		// declared-not-running loop still reads its (possibly empty) history honestly.
		const runSource = loop ?? {
			id: identifier,
			kind: manifest!.kind as LoopView['kind'],
			projectId: manifest!.projectId ?? undefined
		};
		const runs = await getLoopRuns(db, runSource, { limit: DETAIL_RUN_LIMIT });

		const projectId = loop?.projectId ?? manifest?.projectId ?? null;
		let projectName: string | null = null;
		if (projectId) {
			try {
				projectName = (await getProject(db, projectId))?.name ?? null;
			} catch {
				projectName = null; // a name lookup failure never sinks the whole page — honest null.
			}
		}

		return {
			connected: true,
			identifier,
			loop,
			manifest,
			runs,
			tracksHistory: runs.length > 0 || (loop != null && loop.id !== 'orch:gc' && loop.id !== 'mem-review'),
			runLimit: DETAIL_RUN_LIMIT,
			projectName
		};
	} catch (err) {
		// A thrown 404 (an HttpError) must propagate — only a real DB fault degrades to disconnected.
		if (isHttpError(err)) throw err;
		void classifyDbError(err);
		return disconnected(identifier);
	}
};

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────────
// The readiness / arm / cadence controls reused on this page (LoopReadiness → loopChecklist, LoopControls
// → pmSchedule/pmAutonomous, LoopManageControls phase → loopPhase) POST to THIS route, so we compose the
// list route's already-validated, already-tested action set and add ONE new NO-restart control: loopEnabled.

const VALID_KINDS: ReadonlySet<string> = new Set([
	'orchestrator',
	'pm-autonomous',
	'pm-cadence',
	'memory-review',
	'game-verify'
]);

function asKind(raw: FormDataEntryValue | null): LoopManifestKind | null {
	const s = String(raw ?? '').trim();
	return VALID_KINDS.has(s) ? (s as LoopManifestKind) : null;
}

function formProjectId(raw: FormDataEntryValue | null): string | null {
	const s = String(raw ?? '').trim();
	if (!s) return null;
	try {
		return assertRecordId(s);
	} catch {
		return null;
	}
}

export const actions: Actions = {
	...loopsActions,

	// LOOP MANIFEST — enable/disable a declared loop (lightweight, reversible, no restart; DB-MERGE). Declares
	// the loop first if it is not yet in the manifest (idempotent upsert grounded in the form's live identity).
	loopEnabled: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { loop: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const identifier = String(form.get('identifier') ?? '').trim();
		if (!identifier) return fail(400, { loop: { error: 'missing loop identifier' } });
		const kind = asKind(form.get('kind'));
		if (!kind) return fail(400, { loop: { error: 'invalid loop kind' } });
		const label = String(form.get('label') ?? '').trim() || identifier;
		const enabled = String(form.get('enabled') ?? '').trim() === 'true';

		const rawProject = String(form.get('projectId') ?? '').trim();
		let projectId: string | null = null;
		if (rawProject) {
			projectId = formProjectId(rawProject);
			if (!projectId) return fail(400, { loop: { error: 'invalid project id' } });
		}

		try {
			await upsertLoopManifest(db, { identifier, kind, label, projectId });
			const updated = await setLoopEnabled(db, identifier, enabled);
			return { loop: { ok: true as const, action: 'enabled', enabled: updated?.enabled ?? enabled } };
		} catch (err) {
			return fail(500, { loop: { error: (err as Error).message } });
		}
	}
};
