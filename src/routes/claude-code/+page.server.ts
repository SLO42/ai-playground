// TASK 1.8 — /claude-code read-only catalog (UI-SPEC §313 v0.1; D-010).
//
// Reads the LIVE Claude Code config mirror (cc_* tables, DATA-MODEL §4.10) and
// lists hooks / skills / agents / MCP servers per scope, with each scope's
// synced / out-of-sync state (UI-SPEC §214). NO fabricated data (F-008): every
// row comes from the DB mirror, and the sync status is computed live against disk.
//
// v0.1 is READ-ONLY (UI-SPEC §313: "read-only catalog"); editing config files is
// deferred (D-010 diff-and-confirm writes land later). The loader degrades
// honestly when the DB singleton isn't wired yet (app-shell DB init is a later
// task) — it reports `connected: false` rather than inventing rows.

import { readFileSync } from 'node:fs';
import { fail } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import {
	readCatalog,
	syncState,
	planEdit,
	applyEdit,
	classifyScopes,
	reconcileScopes,
	ConfigValidationError,
	StaleConfirmError,
	type CatalogScope,
	type ConfigKind
} from '$lib/server/cc-config';
import { listFleetAcrossProjects, type FleetSessionXP } from '$lib/server/analytics';
import { getControlCapabilities, type ControlCapabilities } from '$lib/server/harness';
import type { Db } from '$lib/server/db/client';
import {
	resolveConfigTargetFromCatalog,
	ConfigTargetError,
	type AllowedScope,
	type ResolvedTarget
} from './config-target';
import type { Actions, PageServerLoad } from './$types';

/** The config kinds the editor accepts (validated at the boundary, D-016). */
const EDITABLE_KINDS: ConfigKind[] = ['settings', 'mcp_json', 'claude_md', 'agent', 'skill'];

function isConfigKind(v: unknown): v is ConfigKind {
	return typeof v === 'string' && (EDITABLE_KINDS as string[]).includes(v);
}

export const load: PageServerLoad = async ({ depends }) => {
	// SCOPED dep (DEFECT 2): the page re-runs this loader only on `app:claude-code`,
	// NOT on every table change. Previously the page invalidated on a `project` row
	// change with `invalidate(() => true)` — an "invalidate storm" that re-pulled the
	// whole catalog whenever any project row moved. The dep below is the surgical knob.
	depends('app:claude-code');
	// TASK 9.3 — the cross-project session FLEET re-runs on its own scoped dep so a `session`
	// row change live-refreshes the fleet WITHOUT re-pulling the whole config catalog.
	depends('app:fleet');

	// DEFECT 2: use `tryGetDb()` (never throws) instead of strict `getDb()`. A non-null
	// handle does NOT prove liveness — the SDK keeps handing back a CACHED-but-DEAD
	// handle after the socket drops, so every read below is wrapped + classified
	// (parity with /workflows, commit 8ed7659). On a dead socket this returns an honest
	// `connected:false` rather than throwing an unhandled 500 that silently aborts the
	// client navigation.
	// TASK 14.6 — the HONEST session-control capability matrix (F-008): what the wired
	// backend REALLY supports, so the fleet controls below render disabled-with-reason
	// instead of buttons that claim to work and do nothing. Never throws (degrades to
	// all-off with the honest reason).
	let controlCaps: ControlCapabilities;

	const db = tryGetDb();
	try {
		controlCaps = await getControlCapabilities(db ?? undefined);
	} catch (err) {
		controlCaps = {
			available: false,
			reason: (err as Error).message,
			interject: false,
			resume: false,
			stop: false
		};
	}

	if (!db) {
		return {
			connected: false,
			scopes: [] as CatalogScope[],
			fleet: [] as FleetSessionXP[],
			controlCaps
		};
	}

	try {
		// TASK 9.3 — the LIVE cross-project session fleet (portfolio-wide). A fleet-read failure
		// must NOT blank the config catalog (and vice-versa), so this degrades to [] on its own.
		let fleet: FleetSessionXP[] = [];
		try {
			fleet = await listFleetAcrossProjects(db, 40);
		} catch {
			fleet = [];
		}

		// TASK 14.4d — reconcile the scope catalog against the REGISTERED project roots
		// before rendering: a cc_scope row whose path lives outside its project's root
		// (e.g. another repo's .claude ingested by mistake) is removed fail-closed with its
		// child mirror rows (D-016/D-018), and any project whose own <root>/.claude exists
		// but is missing from the catalog gets its scope derived from its OWN root.
		// Steady-state this is a pure read; a reconcile failure never blanks the page.
		try {
			await reconcileScopes(db);
		} catch {
			/* keep serving the catalog as-is — the edit allow-list still fails closed */
		}

		const scopes = await readCatalog(db);

		// Overlay the LIVE disk-vs-mirror status per scope (the mirror alone can only
		// say "synced if a digest exists"; the real check needs disk access). A scope
		// whose path is unreadable keeps its mirror-derived status.
		const withStatus = await Promise.all(
			scopes.map(async (sc) => {
				if (sc.kind !== 'project' && sc.kind !== 'global') return sc;
				try {
					const st = await syncState(db, {
						kind: sc.kind,
						// cc_scope.path is the abs path to the .claude dir.
						claudeDir: sc.path,
						...(sc.project ? { project: sc.project } : {})
					});
					return { ...sc, status: st.status };
				} catch {
					return sc;
				}
			})
		);

		return { connected: true, scopes: withStatus, fleet, controlCaps };
	} catch (err) {
		// Classify the thrown error (shared with /workflows + /projects + home, D-019):
		// a genuine connection loss is reported as DISCONNECTED — the same honest state
		// as a server that booted with the DB down — and ONLY a true query/parse failure
		// keeps `connected:true` + the queryError state. Never an unhandled 500.
		if (classifyDbError(err) === 'disconnected') {
			return {
				connected: false,
				scopes: [] as CatalogScope[],
				fleet: [] as FleetSessionXP[],
				controlCaps
			};
		}
		return {
			connected: true,
			scopes: [] as CatalogScope[],
			fleet: [] as FleetSessionXP[],
			controlCaps,
			queryError: (err as Error).message
		};
	}
};

/**
 * The server-side allow-list of edit scopes (TASK 13.5 finding 1): the cc_scope catalog —
 * the SAME rows the loader renders — read fresh per action. The form's claudeDir is only a
 * lookup key into this set; kind/project of the matched scope come from the catalog row,
 * never the request. A claudeDir not in the catalog fails CLOSED (honest 400).
 *
 * TASK 14.4d hardening: only CONFINEMENT-VALID rows reach the allow-list (classifyScopes
 * — a project scope must realpath-confine under its registered project root, D-018). A
 * poisoned catalog row pointing outside the project can therefore never anchor a config
 * write, even before a reconcile pass has cleaned it.
 */
async function allowedScopes(db: Db): Promise<AllowedScope[]> {
	const { valid } = await classifyScopes(db);
	return valid
		.filter((r) => r.path)
		.map((r) => ({
			kind: r.kind,
			path: r.path,
			...(r.project ? { project: r.project } : {})
		}));
}

/** Resolve the edit target from form fields, validating the kind at the boundary (D-016)
 *  and the confinement anchor against the SERVER-SIDE catalog (D-018; TASK 13.5). */
async function targetFromForm(
	db: Db,
	form: FormData
): Promise<
	| { ok: true; kind: ConfigKind; claudeDir: string; filePath: string; scope: ResolvedTarget['scope'] }
	| { ok: false; status: number; error: string }
> {
	const kindRaw = form.get('kind');
	if (!isConfigKind(kindRaw)) return { ok: false, status: 400, error: 'invalid config kind' };
	const claudeDir = typeof form.get('claudeDir') === 'string' ? String(form.get('claudeDir')).trim() : '';
	if (!claudeDir) return { ok: false, status: 400, error: 'missing scope path' };
	const explicitPath = typeof form.get('filePath') === 'string' ? String(form.get('filePath')).trim() : '';

	let scopes: AllowedScope[];
	try {
		scopes = await allowedScopes(db);
	} catch (err) {
		// Could not read the allow-list ⇒ we cannot authorize the anchor ⇒ fail closed.
		return { ok: false, status: 503, error: `config catalog unavailable — retry: ${(err as Error).message}` };
	}

	try {
		const resolved = resolveConfigTargetFromCatalog(scopes, {
			kind: kindRaw,
			claudeDir,
			...(explicitPath ? { explicitPath } : {})
		});
		// Echo claudeDir back so the page can match the shared editor panel to ITS scope card
		// even on a native (non-enhanced) submit, where client state is reset.
		return { ok: true, kind: resolved.kind, claudeDir, filePath: resolved.filePath, scope: resolved.scope };
	} catch (err) {
		if (err instanceof ConfigTargetError) return { ok: false, status: 400, error: err.message };
		return { ok: false, status: 400, error: (err as Error).message };
	}
}

export const actions: Actions = {
	/**
	 * Job-9 config edit, step 0 — LOAD: read the current file content so the editor can
	 * pre-fill it. Read-only; the target is path-confined to its scope (D-018). Returns the
	 * raw bytes (empty string if the file doesn't exist yet — an honest "new file" state).
	 */
	loadFile: async ({ request }) => {
		const form = await request.formData();
		// The catalog allow-list lives in the DB (13.5 finding 1): without it we cannot
		// authorize the scope anchor, so the editor honestly refuses (fail closed).
		const db = tryGetDb();
		if (!db) return fail(503, { edit: { error: 'Database not connected — start SurrealDB and retry.' } });
		const t = await targetFromForm(db, form);
		if (!t.ok) return fail(t.status, { edit: { error: t.error } });
		let content = '';
		try {
			content = readFileSync(t.filePath, 'utf8');
		} catch {
			content = ''; // not-yet-existing file → empty editor (honest)
		}
		return {
			edit: { phase: 'editing' as const, kind: t.kind, claudeDir: t.claudeDir, filePath: t.filePath, content }
		};
	},

	/**
	 * Job-9 config edit, step 1 — PLAN (D-010): validate the proposed content + compute the
	 * diff against what's on disk RIGHT NOW. Returns the diff hunks, validation issues, and
	 * the confirmToken bound to the current bytes. No write. This is the mandatory
	 * diff-and-confirm gate before any config file is touched.
	 */
	planEdit: async ({ request }) => {
		const form = await request.formData();
		const db = tryGetDb();
		if (!db) return fail(503, { edit: { error: 'Database not connected — start SurrealDB and retry.' } });
		const t = await targetFromForm(db, form);
		if (!t.ok) return fail(t.status, { edit: { error: t.error } });
		const content = typeof form.get('content') === 'string' ? String(form.get('content')) : '';
		const plan = planEdit({ kind: t.kind, filePath: t.filePath, content });
		return {
			edit: {
				phase: 'confirming' as const,
				kind: t.kind,
				claudeDir: t.claudeDir,
				filePath: t.filePath,
				content,
				validation: plan.validation,
				diff: plan.diff,
				confirmToken: plan.confirmToken
			}
		};
	},

	/**
	 * Job-9 config edit, step 2 — APPLY (D-010): the CONFIRM. applyEdit re-validates, asserts
	 * the file still matches the confirmToken (StaleConfirmError if a hand-edit landed since
	 * the diff — never silently clobbered), writes, and re-syncs the cc_* mirror through the
	 * single 1.8 writer so the mirror is lock-step. The /claude-code catalog then re-renders
	 * the new synced state live (the SSE re-invalidation already wired on the page).
	 */
	applyEdit: async ({ request }) => {
		const form = await request.formData();
		const db = tryGetDb();
		if (!db) return fail(503, { edit: { error: 'Database not connected — start SurrealDB and retry.' } });
		const t = await targetFromForm(db, form);
		if (!t.ok) return fail(t.status, { edit: { error: t.error } });
		const content = typeof form.get('content') === 'string' ? String(form.get('content')) : '';
		const confirmToken = typeof form.get('confirmToken') === 'string' ? String(form.get('confirmToken')) : '';
		if (!confirmToken) return fail(400, { edit: { error: 'missing confirm token — re-review the diff' } });

		try {
			const result = await applyEdit(db, {
				kind: t.kind,
				filePath: t.filePath,
				content,
				confirmToken,
				scope: t.scope
			});
			return {
				edit: {
					phase: 'saved' as const,
					kind: t.kind,
					claudeDir: t.claudeDir,
					filePath: t.filePath,
					bytesWritten: result.bytesWritten,
					// After a successful applyEdit the mirror is re-synced lock-step with the new
					// file (D-010) — the scope is synced by definition.
					status: 'synced' as const
				}
			};
		} catch (err) {
			if (err instanceof StaleConfirmError) {
				return fail(409, {
					edit: { error: `${err.message}`, kind: t.kind, claudeDir: t.claudeDir, filePath: t.filePath, content }
				});
			}
			if (err instanceof ConfigValidationError) {
				return fail(422, {
					edit: { error: err.message, issues: err.issues, kind: t.kind, claudeDir: t.claudeDir, filePath: t.filePath, content }
				});
			}
			return fail(500, { edit: { error: (err as Error).message } });
		}
	}
};
