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
	ConfigValidationError,
	StaleConfirmError,
	type CatalogScope,
	type ConfigKind
} from '$lib/server/cc-config';
import { resolveConfigTarget, ConfigTargetError } from './config-target';
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

	// DEFECT 2: use `tryGetDb()` (never throws) instead of strict `getDb()`. A non-null
	// handle does NOT prove liveness — the SDK keeps handing back a CACHED-but-DEAD
	// handle after the socket drops, so every read below is wrapped + classified
	// (parity with /workflows, commit 8ed7659). On a dead socket this returns an honest
	// `connected:false` rather than throwing an unhandled 500 that silently aborts the
	// client navigation.
	const db = tryGetDb();
	if (!db) {
		return { connected: false, scopes: [] as CatalogScope[] };
	}

	try {
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

		return { connected: true, scopes: withStatus };
	} catch (err) {
		// Classify the thrown error (shared with /workflows + /projects + home, D-019):
		// a genuine connection loss is reported as DISCONNECTED — the same honest state
		// as a server that booted with the DB down — and ONLY a true query/parse failure
		// keeps `connected:true` + the queryError state. Never an unhandled 500.
		if (classifyDbError(err) === 'disconnected') {
			return { connected: false, scopes: [] as CatalogScope[] };
		}
		return { connected: true, scopes: [] as CatalogScope[], queryError: (err as Error).message };
	}
};

/** Resolve the edit target from form fields, validating the kind at the boundary (D-016). */
function targetFromForm(form: FormData):
	| { ok: true; kind: ConfigKind; claudeDir: string; filePath: string; scope: ReturnType<typeof resolveConfigTarget>['scope'] }
	| { ok: false; error: string } {
	const kindRaw = form.get('kind');
	if (!isConfigKind(kindRaw)) return { ok: false, error: 'invalid config kind' };
	const claudeDir = typeof form.get('claudeDir') === 'string' ? String(form.get('claudeDir')).trim() : '';
	if (!claudeDir) return { ok: false, error: 'missing scope path' };
	const scopeKindRaw = form.get('scopeKind');
	const scopeKind = scopeKindRaw === 'global' ? 'global' : 'project';
	const project = typeof form.get('project') === 'string' ? String(form.get('project')).trim() : '';
	const explicitPath = typeof form.get('filePath') === 'string' ? String(form.get('filePath')).trim() : '';
	try {
		const resolved = resolveConfigTarget({
			kind: kindRaw,
			claudeDir,
			scopeKind,
			...(project ? { project } : {}),
			...(explicitPath ? { explicitPath } : {})
		});
		// Echo claudeDir back so the page can match the shared editor panel to ITS scope card
		// even on a native (non-enhanced) submit, where client state is reset.
		return { ok: true, kind: resolved.kind, claudeDir, filePath: resolved.filePath, scope: resolved.scope };
	} catch (err) {
		if (err instanceof ConfigTargetError) return { ok: false, error: err.message };
		return { ok: false, error: (err as Error).message };
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
		const t = targetFromForm(form);
		if (!t.ok) return fail(400, { edit: { error: t.error } });
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
		const t = targetFromForm(form);
		if (!t.ok) return fail(400, { edit: { error: t.error } });
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
		const t = targetFromForm(form);
		if (!t.ok) return fail(400, { edit: { error: t.error } });
		const content = typeof form.get('content') === 'string' ? String(form.get('content')) : '';
		const confirmToken = typeof form.get('confirmToken') === 'string' ? String(form.get('confirmToken')) : '';
		if (!confirmToken) return fail(400, { edit: { error: 'missing confirm token — re-review the diff' } });

		const db = tryGetDb();
		if (!db) return fail(503, { edit: { error: 'Database not connected — start SurrealDB and retry.' } });

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
