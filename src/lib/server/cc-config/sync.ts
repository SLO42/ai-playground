// TASK 1.8 — Claude Code config sync (read-only mirror, D-010; depends on: 0.c).
//
// The FILESYSTEM is authoritative for Claude Code config (D-010): Claude Code
// reads `.claude/` + `.mcp.json` from disk. This service keeps a SurrealDB MIRROR
// (the cc_* tables, DATA-MODEL §4.10) in lock-step for fast query + the dashboard
// catalog. It is READ-only with respect to the files (v0.1 scope, UI-SPEC §313:
// "/claude-code read-only catalog") — it never writes config files; it only reads
// disk → upserts the mirror.
//
// Drift detection: each scope stores a content digest (parse.digestScope) in the
// dedicated `cc_settings.sync_digest` field at sync time. `syncState(db, scope)`
// re-reads disk, re-digests, and compares — equal ⇒ "synced", different ⇒
// "out_of_sync" (the file was edited on disk after the last sync). This is the
// "synced / out-of-sync" state the /claude-code surface shows (UI-SPEC §214).
//
// Boundary discipline (D-016): every VALUE binds via $param — never interpolated.
// The ONLY interpolated token is the deterministic scope record id, validated at
// the chokepoint in db/validate.ts FIRST. Optional fields are OMITTED, never NULL
// (option<T> rejects NULL — MEMORY-SPEC §6.1).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId, assertTableName } from '../db/validate';
import {
	digestScope,
	readScope,
	type ParsedAgent,
	type ParsedHook,
	type ParsedMcpServer,
	type ParsedSkill,
	type ScopeContent
} from './parse';

/** A scope to sync: `project` (a `.claude` under a project root) or `global` (~/.claude). */
export interface SyncScope {
	kind: 'project' | 'global';
	/** Absolute path to the `.claude` directory. */
	claudeDir: string;
	/** For `project` scope: the `project:<slug>` record id this config belongs to. */
	project?: string;
	/** For `project` scope: path to the sibling `.mcp.json` (defaults to ../.mcp.json). */
	mcpJsonPath?: string;
}

/** The sync-state the dashboard renders per scope. */
export type SyncStatus = 'synced' | 'out_of_sync' | 'unsynced';

export interface ScopeState {
	scopeId: string;
	status: SyncStatus;
	/** Digest currently on disk. */
	diskDigest: string;
	/** Digest stored at last sync, or null if never synced. */
	mirrorDigest: string | null;
}

/** Thrown when a scope path escapes its allowed root (fail-closed, D-018). */
export class ScopeConfinementError extends Error {
	override readonly name = 'ScopeConfinementError';
	constructor(
		message: string,
		readonly target: string,
		readonly root: string
	) {
		super(message);
	}
}

// ── Deterministic scope id ──────────────────────────────────────────────────────

/**
 * The stable `cc_scope:<digest>` id for a scope. Derived from kind + the canonical
 * claude-dir path so re-syncing the SAME scope hits the SAME row (idempotent), and
 * two different scopes never collide. Path is lower-cased for the digest so a
 * Windows drive-letter-case change doesn't fork the row.
 */
export function scopeIdOf(kind: string, claudeDir: string): string {
	const digest = createHash('sha256')
		.update(`${kind}|${resolve(claudeDir).toLowerCase()}`)
		.digest('hex')
		.slice(0, 32);
	return `cc_scope:s_${digest}`;
}

/**
 * The stable, ONE-per-scope `cc_settings:<digest>` id for a scope record id. Derived from the
 * scope id so re-syncing the SAME scope UPSERTs the SAME cc_settings row (idempotent) instead of
 * the non-atomic DELETE-then-CREATE that duplicated rows under concurrent reconciles (SH-5 race).
 */
function settingsIdOf(scopeId: string): string {
	const digest = createHash('sha256').update(scopeId).digest('hex').slice(0, 32);
	return `cc_settings:t_${digest}`;
}

/**
 * A stable, ONE-per-(scope,disk-identity) child-row id for a cc_hook / cc_agent / cc_skill /
 * cc_mcp_server row. Derived from the scope id + a per-table prefix + the row's disk-identity
 * key so re-syncing the SAME child UPSERTs the SAME row (idempotent) instead of the old
 * non-atomic DELETE-then-CREATE that duplicated child rows under concurrent reconciles during
 * the drift-transition window (the SH-5 child-table race — the exact moment SH-3 promotes a
 * skill). Concurrent writers compute identical ids → converge on one row per child.
 *
 * The `key` is the row's natural disk identity: `file_path` for agents/skills (one file → one
 * row), `name` for mcp servers (unique within a scope), and the full content tuple for hooks
 * (no single natural key — two byte-identical hooks correctly collapse to one row; disk truth).
 */
function childIdOf(table: string, prefix: string, scopeId: string, key: string): string {
	const digest = createHash('sha256').update(`${scopeId}|${key}`).digest('hex').slice(0, 32);
	return `${table}:${prefix}_${digest}`;
}

/**
 * Confine `claudeDir` under `root` after symlink + `..` normalization (D-018,
 * fail-closed). Used when a caller wants to assert a project scope lives under
 * CODE_ROOT before syncing it. Returns the canonical path. The global (~/.claude)
 * scope is exempt — pass it directly to syncScope without confinement.
 */
export function confineScope(claudeDir: string, root: string): string {
	let real: string;
	let realRoot: string;
	try {
		realRoot = realpathSync(resolve(root));
		real = realpathSync(resolve(claudeDir));
	} catch (err) {
		throw new ScopeConfinementError(
			`Cannot resolve scope or root (fail-closed): ${(err as Error).message}`,
			claudeDir,
			root
		);
	}
	const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
	const cmp = process.platform === 'win32' ? real.toLowerCase() : real;
	const cmpRoot = process.platform === 'win32' ? rootWithSep.toLowerCase() : rootWithSep;
	const cmpRootExact = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
	if (cmp !== cmpRootExact && !cmp.startsWith(cmpRoot)) {
		throw new ScopeConfinementError(
			`Scope ${real} is not under root ${realRoot} (D-018, fail-closed).`,
			claudeDir,
			root
		);
	}
	return real;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

// ── Mirror write (read disk → upsert cc_* tables) ────────────────────────────────

export interface SyncResult {
	scopeId: string;
	digest: string;
	counts: { hooks: number; agents: number; skills: number; mcpServers: number };
}

/**
 * Read a scope from disk and upsert the whole mirror for it: cc_scope, cc_settings
 * (with the sync digest), and a full REPLACE of cc_hook / cc_agent / cc_skill /
 * cc_mcp_server rows owned by this scope (delete-then-insert so a removed-on-disk
 * hook/agent disappears from the mirror — the mirror tracks disk exactly).
 *
 * Idempotent: the scope id is deterministic; re-syncing unchanged config rewrites
 * the same rows + same digest. NEVER writes config files (read-only, D-010 v0.1).
 */
export async function syncScope(db: Db, scope: SyncScope): Promise<SyncResult> {
	const content = readScope(scope.claudeDir, scope.mcpJsonPath);
	const digest = digestScope(content);
	const scopeId = scopeIdOf(scope.kind, scope.claudeDir);
	const scopeRid = link(scopeId);

	// 1. cc_scope (the provenance row).
	const scopeContent = omitUndefined({
		kind: scope.kind,
		path: resolve(scope.claudeDir),
		project: scope.kind === 'project' && scope.project ? link(scope.project) : undefined
	});
	await db.query(`UPSERT $rid MERGE $content;`, { rid: scopeRid, content: scopeContent });

	// 2. cc_settings — one per scope. `raw` round-trips the full JSON (FLEXIBLE);
	//    `sync_digest` is the dedicated drift-detection stamp.
	const settingsContent = omitUndefined({
		scope: scopeRid,
		file_path: resolve(scope.claudeDir) + sep + 'settings.json',
		permissions: content.settings.permissions,
		env: content.settings.env,
		enabled_plugins: content.settings.enabledPlugins,
		raw: content.settings.raw,
		sync_digest: digest,
		synced_at: new Date()
	});
	// One cc_settings per scope via a DETERMINISTIC id + UPSERT CONTENT (full-record replace,
	// same id) — NOT the old non-atomic DELETE-then-CREATE, which let N concurrent reconciles
	// all DELETE then all CREATE → duplicate orphan rows (the SH-5 hot-path race). One stable
	// id per scope means concurrent writers converge on a single row. The guarded sweep
	// (`id != $rid`) retires any legacy random-id rows from before this deterministic-id change
	// (F-015 migration: absorb prior partial/old state) WITHOUT ever deleting the canonical row,
	// so a concurrent writer's just-UPSERTed row is never swept.
	const settingsRid = link(settingsIdOf(scopeId));
	await db.query(
		`DELETE cc_settings WHERE scope = $scope AND id != $rid;
		 UPSERT $rid CONTENT $content;`,
		{ scope: scopeRid, rid: settingsRid, content: settingsContent }
	);

	// 3. Child tables — full replace scoped to this scope (mirror = disk exactly).
	//    Each replace uses deterministic per-child ids + a guarded sweep + UPSERT (NOT the old
	//    non-atomic DELETE-then-CREATE) so N concurrent reconciles racing the SAME scope during
	//    the drift-transition window (e.g. SH-3 promoting a skill) converge on one row per child
	//    instead of leaking duplicate orphans (the SH-5 child-table race).
	await replaceHooks(db, scopeId, scopeRid, content.settings.hooks);
	await replaceMcpServers(db, scopeId, scopeRid, content.settings.mcpServers);
	await replaceAgents(db, scopeId, scopeRid, content.agents);
	await replaceSkills(db, scopeId, scopeRid, content.skills);

	return {
		scopeId,
		digest,
		counts: {
			hooks: content.settings.hooks.length,
			agents: content.agents.length,
			skills: content.skills.length,
			mcpServers: content.settings.mcpServers.length
		}
	};
}

/**
 * Replace a scope's rows in ONE child table without the non-atomic DELETE-then-CREATE that
 * duplicated rows under concurrent reconciles (the SH-5 child-table race). Each row gets a
 * DETERMINISTIC id (childIdOf) keyed by its disk identity, then:
 *   1. a GUARDED SWEEP retires only this scope's rows whose disk identity is GONE
 *      (`DELETE … WHERE scope = $scope AND id NOTINSIDE $keep`) — never the rows we are about
 *      to (or a concurrent writer just did) UPSERT, because those ids are in `$keep`;
 *   2. one UPSERT $rid CONTENT per surviving row (full-record replace at a stable id).
 * N concurrent writers compute the SAME keep-set and the SAME UPSERT ids, so they converge on
 * exactly one row per child — no duplicate orphans, even mid drift-transition. The sweep runs
 * even when `rows` is empty (keep-set = []) so a scope emptied on disk is cleared (mirror = disk).
 */
async function replaceChildren(
	db: Db,
	table: string,
	scope: StringRecordId,
	rows: Array<{ id: StringRecordId; content: Record<string, unknown> }>
): Promise<void> {
	const keep = rows.map((r) => r.id);
	await db.query(`DELETE ${assertTableName(table)} WHERE scope = $scope AND id NOTINSIDE $keep;`, {
		scope,
		keep
	});
	for (const r of rows) {
		await db.query(`UPSERT $rid CONTENT $content;`, { rid: r.id, content: r.content });
	}
}

async function replaceHooks(
	db: Db,
	scopeId: string,
	scope: StringRecordId,
	hooks: ParsedHook[]
): Promise<void> {
	const rows = hooks.map((h) => {
		// No single natural key for a hook — its identity is the full content tuple. Two
		// byte-identical hooks correctly collapse to one row (disk truth, a dedup not a loss).
		const key = stableHookKey(h);
		return {
			id: link(childIdOf('cc_hook', 'h', scopeId, key)),
			content: omitUndefined({
				scope,
				event: h.event,
				matcher: h.matcher,
				command: h.command,
				timeout: h.timeout
			})
		};
	});
	await replaceChildren(db, 'cc_hook', scope, rows);
}

async function replaceMcpServers(
	db: Db,
	scopeId: string,
	scope: StringRecordId,
	servers: ParsedMcpServer[]
): Promise<void> {
	const rows = servers.map((s) => ({
		// `name` is the natural unique key within a scope (mcpServers is a name-keyed map on disk).
		id: link(childIdOf('cc_mcp_server', 'm', scopeId, s.name)),
		content: omitUndefined({
			scope,
			name: s.name,
			type: s.type,
			command: s.command,
			args: s.args,
			url: s.url,
			env: s.env
		})
	}));
	await replaceChildren(db, 'cc_mcp_server', scope, rows);
}

async function replaceAgents(
	db: Db,
	scopeId: string,
	scope: StringRecordId,
	agents: ParsedAgent[]
): Promise<void> {
	const rows = agents.map((a) => ({
		// `file_path` is the natural unique key (one agent .md → one row).
		id: link(childIdOf('cc_agent', 'a', scopeId, a.file_path)),
		content: omitUndefined({
			scope,
			file_path: a.file_path,
			name: a.name,
			description: a.description,
			frontmatter: a.frontmatter,
			category: a.category
		})
	}));
	await replaceChildren(db, 'cc_agent', scope, rows);
}

async function replaceSkills(
	db: Db,
	scopeId: string,
	scope: StringRecordId,
	skills: ParsedSkill[]
): Promise<void> {
	const rows = skills.map((s) => ({
		// `file_path` is the natural unique key (one SKILL.md → one row).
		id: link(childIdOf('cc_skill', 'k', scopeId, s.file_path)),
		content: omitUndefined({
			scope,
			file_path: s.file_path,
			name: s.name,
			description: s.description,
			plugin: s.plugin
		})
	}));
	await replaceChildren(db, 'cc_skill', scope, rows);
}

/** Stable identity string for a hook (its full content tuple) — the childIdOf key for cc_hook. */
function stableHookKey(h: ParsedHook): string {
	return JSON.stringify([h.event, h.matcher ?? '', h.command, h.timeout ?? '']);
}

// ── Scope derivation + catalog reconciliation (TASK 14.4d; D-016/D-018) ───────────
//
// AUDIT-CONFIRMED F-008 finding: the live catalog carried a cc_scope row claiming to be
// a project's config mirror while its `path` pointed at a DIFFERENT repo's `.claude`
// (the v1 repo) — /claude-code presented another project's config as this one's. The
// fix is structural, not a one-off delete:
//   • DERIVATION — a project scope's path is derived from the project's OWN registered
//     root (`<project.root_path>/.claude`, projectScopeOf) — never from an arbitrary
//     ingested path.
//   • VALIDATION (fail-closed, D-018) — a project-kind cc_scope row is valid ONLY if it
//     links a registered project AND its path realpath-confines under that project's
//     root_path. Unverifiable rows (no project link, unknown project, missing root,
//     unresolvable or out-of-root path) are removed WITH their child mirror rows —
//     the mirror is a disk index (D-010), so removal loses nothing durable.
//   • The global (~/.claude) scope is exempt from project confinement (it lives outside
//     every project root by definition).

/** Derive a project's OWN config scope from its registered root (14.4d). */
export function projectScopeOf(projectId: string, rootPath: string): SyncScope {
	return { kind: 'project', claudeDir: resolve(rootPath, '.claude'), project: projectId };
}

/** A raw cc_scope row as classified by {@link classifyScopes}. */
export interface ScopeRowView {
	id: string;
	kind: 'project' | 'global';
	path: string;
	project?: string;
}

/** Canonical path key for dedup/lookup (Windows paths compare case-insensitively). */
function canonPath(p: string): string {
	const r = resolve(p);
	return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * Classify every cc_scope row as VALID (renderable + editable) or INVALID (fail-closed:
 * provenance cannot be verified against a registered project root). Pure read — no
 * deletes; the edit allow-list (/claude-code actions) consumes `valid` directly so a
 * poisoned row can never anchor a config write even before a reconcile runs (D-018).
 */
export async function classifyScopes(
	db: Db
): Promise<{ valid: ScopeRowView[]; invalid: ScopeRowView[] }> {
	const [scopes] = await db.query<
		[Array<{ id: unknown; kind: unknown; path: unknown; project: unknown }>]
	>(`SELECT id, kind, path, project FROM cc_scope;`);
	const [projects] = await db.query<[Array<{ id: unknown; root_path: unknown }>]>(
		`SELECT id, root_path FROM project;`
	);
	const rootById = new Map<string, string>();
	for (const p of projects ?? []) {
		if (typeof p.root_path === 'string' && p.root_path) rootById.set(String(p.id), p.root_path);
	}

	const valid: ScopeRowView[] = [];
	const invalid: ScopeRowView[] = [];
	for (const sc of scopes ?? []) {
		const row: ScopeRowView = {
			id: String(sc.id),
			kind: sc.kind === 'global' ? 'global' : 'project',
			path: typeof sc.path === 'string' ? sc.path : '',
			...(sc.project != null ? { project: String(sc.project) } : {})
		};
		if (sc.kind === 'global') {
			// The global ~/.claude scope is exempt from project confinement.
			valid.push(row);
			continue;
		}
		if (sc.kind !== 'project') {
			invalid.push(row); // unknown kind — fail closed
			continue;
		}
		const root = row.project ? rootById.get(row.project) : undefined;
		if (!root || !row.path) {
			invalid.push(row); // no registered project / no path — unverifiable, fail closed
			continue;
		}
		try {
			confineScope(row.path, root); // realpath + ..-normalized containment (D-018)
			valid.push(row);
		} catch {
			invalid.push(row); // outside the registered project root — fail closed
		}
	}
	return { valid, invalid };
}

/**
 * The health of the SH-5 harvest-scope ensure performed inside {@link reconcileScopes} — the
 * disk+catalog registration that lets a PROMOTED skill (SH-3) reach `cc_skill` / `catalogIds`.
 *
 * CCF-2 (CC-CONFIG-SPEC §3): this ensure was previously wrapped in a BARE catch, so a failure
 * (e.g. an unwritable harness state dir, a sync fault) silently dropped the reason — a promoted
 * skill could never reach the catalog and NOTHING on /claude-code said so. The failure is now
 * captured as a TYPED value and surfaced honestly (F-008 — never a fabricated "synced" state).
 *   • `healthy` — the ensure succeeded; carries the ensured harvest scope id.
 *   • `error`   — the ensure threw; carries the failure message (the named reason, not dropped).
 */
export type HarvestScopeHealth =
	| { status: 'healthy'; scopeId: string }
	| { status: 'error'; reason: string };

export interface ScopeReconcileResult {
	/** cc_scope ids removed because their provenance failed validation (fail-closed). */
	removed: string[];
	/** cc_scope ids synced fresh from a project's own `<root>/.claude`. */
	synced: string[];
	/**
	 * The harness-owned harvest scope id ensured this call (SH-5), or absent if the
	 * ensure failed. Present on success — it is re-synced every reconcile (idempotent), so it
	 * does NOT ride `synced` (which is project-derivation only). See {@link harvestHealth} for
	 * the failure REASON on the absent branch.
	 */
	harvestScopeId?: string;
	/**
	 * CCF-2 — the health of the harvest-scope ensure. ALWAYS present: populated on success
	 * (`healthy` + the scope id) AND on failure (`error` + the typed reason). The reason is no
	 * longer swallowed by a bare catch — /claude-code renders it as an honest error state
	 * (F-008). Present on BOTH branches so a happy-path test asserts it is populated on success
	 * too (the F-020 sweep rule — a best-effort catch must not silently drop the reason).
	 */
	harvestHealth: HarvestScopeHealth;
}

/** Delete a cc_scope row AND every child mirror row that hangs off it. */
async function deleteScopeCascade(db: Db, scopeId: string): Promise<void> {
	const rid = link(scopeId);
	await db.query(
		`DELETE cc_settings WHERE scope = $rid;
		 DELETE cc_hook WHERE scope = $rid;
		 DELETE cc_agent WHERE scope = $rid;
		 DELETE cc_skill WHERE scope = $rid;
		 DELETE cc_mcp_server WHERE scope = $rid;
		 DELETE $rid;`,
		{ rid }
	);
}

// ── Harvest scope (SH-5, SKILL-HARVEST-SPEC §4/§5) — the one harness-owned synced scope ──
//
// F-045 dead-end: the platform's OWN `.claude` is not a registered project root and not
// `~/.claude`, so no sync path covers it — a freshly-written SKILL.md could never enter
// `cc_skill` / `catalogIds`, so a promoted skill could never be referenced as a capability
// id (composeCapabilities fail-closes, D-036). SH-5 fixes that by establishing ONE scope the
// HARNESS controls, creates, writes to, and SYNCS — the destination SH-3 (promote) writes a
// promoted SKILL.md into so it actually reaches the catalog.
//
// Path is DETERMINISTIC + harness-controlled (not operator-config-dependent in a way that
// breaks D-002 isolation): `<HARVEST_SCOPE_ROOT or <HARNESS_CONFIG_ROOT parent>/harvest>/.claude`.
// It carries ONLY harvested skills — NO operator plugins/agents bleed in (D-002): the harness
// is the sole writer (SH-3 promote), and the dir starts empty. Registered as a `global`-kind
// cc_scope, which is EXEMPT from project-root confinement (classifyScopes) so reconcileScopes
// never tears it down as "unverifiable" — it has no owning project by design.

/** Env override for the harvest-scope parent dir; falsy ⇒ derive from HARNESS_CONFIG_ROOT. */
const HARVEST_SCOPE_ROOT_ENV = 'HARVEST_SCOPE_ROOT';
/** Env carrying the harness isolated-config root; the harvest scope sits beside it. */
const HARNESS_CONFIG_ROOT_ENV = 'HARNESS_CONFIG_ROOT';
/** Default harness-config root (mirrors harness/wiring.ts) when the env is unset. */
const DEFAULT_HARNESS_CONFIG_ROOT = '.harness/claude-config';
/** Sibling dir name under the harness root that owns the harvest `.claude`. */
const HARVEST_DIRNAME = 'harvest';

/**
 * The deterministic absolute path to the harvest scope's `.claude` directory the harness
 * controls. Resolution (most → least specific), all confined + deterministic:
 *   1. `$HARVEST_SCOPE_ROOT/.claude` when that env is set (explicit operator/test control);
 *   2. else `<parent of $HARNESS_CONFIG_ROOT>/harvest/.claude` — beside the isolated-config
 *      root the runtime already owns, so it lives in the harness's own state tree.
 * `env` is injectable for tests; defaults to `process.env`.
 */
export function harvestScopeDir(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env[HARVEST_SCOPE_ROOT_ENV]?.trim();
	if (explicit) return resolve(explicit, '.claude');
	const harnessRoot = env[HARNESS_CONFIG_ROOT_ENV]?.trim() || DEFAULT_HARNESS_CONFIG_ROOT;
	return resolve(harnessRoot, '..', HARVEST_DIRNAME, '.claude');
}

/** The `global`-kind {@link SyncScope} for the harvest dir (no owning project — exempt from confinement). */
export function harvestScope(env: NodeJS.ProcessEnv = process.env): SyncScope {
	return { kind: 'global', claudeDir: harvestScopeDir(env) };
}

/**
 * Ensure the harvest scope EXISTS on disk and is registered + synced in the catalog (SH-5).
 * Idempotent + interrupt-safe: `mkdirSync(recursive)` no-ops when the dir already exists, and
 * `syncScope` UPSERTs a deterministic scope id (re-run rewrites the same row — no duplicate).
 * Creates `<dir>/skills` too so SH-3's first promote writes into an existing tree. The scope
 * is `global`-kind so it is NEVER torn down by the project-confinement reconcile pass.
 * Returns the synced scope id.
 *
 * STEADY-STATE WRITE-FREE (F-014; fix for the SH-5 concurrency race): this runs on the
 * /claude-code loader hot path (reconcileScopes is re-invalidated on every `project` DB event),
 * so it MUST NOT write when nothing on disk changed. syncScope's per-scope cc_settings /
 * cc_skill replace is a non-atomic DELETE-then-CREATE; N concurrent reconciles all DELETE then
 * all CREATE, leaking duplicate orphan rows. We gate the write on a digest-changed check: read
 * the disk content, digest it, compare to the mirror's stored digest, and call syncScope ONLY
 * when the scope is new (no mirror) or the disk digest differs. The dir-create stays
 * unconditional (mkdir is itself idempotent). In steady state (harvest dir unchanged), this is
 * a pure read — no write hits the hot path under multi-tab / event-burst concurrency.
 */
export async function ensureHarvestScope(
	db: Db,
	env: NodeJS.ProcessEnv = process.env
): Promise<string> {
	const claudeDir = harvestScopeDir(env);
	// Create the .claude tree (and the skills/ subdir SH-3 writes into) idempotently.
	mkdirSync(resolve(claudeDir, 'skills'), { recursive: true });

	// Digest-gate the write: only re-sync when disk drifted from the mirror (or never synced).
	// Keeps the loader hot path write-free in steady state — closing the non-atomic
	// DELETE-then-CREATE concurrency race that duplicated cc_settings / cc_skill rows.
	const scopeId = scopeIdOf('global', claudeDir);
	const diskDigest = digestScope(readScope(claudeDir));
	const stored = await mirrorDigest(db, scopeId);
	if (stored === diskDigest) return scopeId; // unchanged — no write (steady state)

	const res = await syncScope(db, { kind: 'global', claudeDir });
	return res.scopeId;
}

/**
 * Reconcile the cc_scope catalog against the REGISTERED project roots (14.4d):
 *   1. remove (with children) every row {@link classifyScopes} marks invalid;
 *   2. for each project whose own `<root_path>/.claude` EXISTS on disk but has no valid
 *      catalog row, derive the scope from the project's own root and sync it.
 *   3. ensure the harness-owned HARVEST scope exists + is synced (SH-5) so a promoted
 *      skill can reach `cc_skill` / `catalogIds` (the F-045 dead-end fix).
 * Projects sharing one root dedup onto a single scope (the oldest registrant wins).
 * The harvest ensure runs every call (it is idempotent — a no-op once the row + dir exist).
 * Returns what changed.
 */
export async function reconcileScopes(db: Db): Promise<ScopeReconcileResult> {
	const { valid, invalid } = await classifyScopes(db);

	const removed: string[] = [];
	for (const row of invalid) {
		await deleteScopeCascade(db, row.id);
		removed.push(row.id);
	}

	// Paths already covered by a valid row (canonical compare).
	const covered = new Set<string>();
	for (const row of valid) {
		if (row.kind === 'project') covered.add(canonPath(row.path));
	}

	// Derive missing scopes from each project's OWN root, oldest registrant first.
	const [projects] = await db.query<[Array<{ id: unknown; root_path: unknown }>]>(
		`SELECT id, root_path, created_at FROM project ORDER BY created_at ASC;`
	);
	const synced: string[] = [];
	for (const p of projects ?? []) {
		const id = String(p.id);
		const root = typeof p.root_path === 'string' ? p.root_path : '';
		if (!root) continue;
		const claudeDir = resolve(root, '.claude');
		const key = canonPath(claudeDir);
		if (covered.has(key)) continue;
		try {
			if (!existsSync(claudeDir) || !statSync(claudeDir).isDirectory()) continue;
		} catch {
			continue;
		}
		covered.add(key);
		const res = await syncScope(db, projectScopeOf(id, root));
		synced.push(res.scopeId);
	}

	// SH-5: the harness-owned harvest scope is part of the catalog reconcile. Idempotent —
	// once the dir + cc_scope row exist, this rewrites the same row (deterministic id), so
	// running reconcile twice never duplicates it. It is NOT a project scope, so it is NOT
	// added to `synced` (which means "a project scope newly derived this call" — keeping the
	// project-idempotency contract intact); its id rides `harvestScopeId` instead. A failure
	// here (e.g. an unwritable harness state dir) must NOT blank the project catalog — surface
	// it without aborting the reconcile (F-014 best-effort, additive to the project flow).
	//
	// CCF-2: the failure is CAPTURED (typed reason), never a bare catch that drops it (F-020
	// sweep). EVERY ERROR HAS A NAME — trigger: the harvest ensure throws (unwritable harness
	// state dir / sync fault); caught: here; user-visible: the /claude-code health surface shows
	// the reason instead of a fabricated "synced" state (F-008). We do NOT re-throw: a harness-dir
	// fault must not blank the project catalog (F-014).
	let harvestScopeId: string | undefined;
	let harvestHealth: HarvestScopeHealth;
	try {
		harvestScopeId = await ensureHarvestScope(db);
		harvestHealth = { status: 'healthy', scopeId: harvestScopeId };
	} catch (err) {
		harvestHealth = { status: 'error', reason: err instanceof Error ? err.message : String(err) };
	}

	return { removed, synced, harvestHealth, ...(harvestScopeId ? { harvestScopeId } : {}) };
}

// ── Drift detection (synced / out-of-sync) ───────────────────────────────────────

/**
 * Read the digest stored at last sync for a scope, or null if the scope was never
 * synced. Reads the dedicated cc_settings.sync_digest field.
 */
export async function mirrorDigest(db: Db, scopeId: string): Promise<string | null> {
	const scope = link(scopeId);
	const [rows] = await db.query<[{ sync_digest?: unknown }[]]>(
		`SELECT sync_digest FROM cc_settings WHERE scope = $scope LIMIT 1;`,
		{ scope }
	);
	const d = rows[0]?.sync_digest;
	return typeof d === 'string' ? d : null;
}

/**
 * Compare a scope on DISK against its MIRROR and return the sync status. This is
 * what the /claude-code surface shows per scope:
 *   • "synced"      — disk digest == stored digest.
 *   • "out_of_sync" — a config file was edited on disk after the last sync.
 *   • "unsynced"    — the scope was never synced (no mirror row yet).
 * Pure read of disk + one mirror SELECT; never writes.
 */
export async function syncState(db: Db, scope: SyncScope): Promise<ScopeState> {
	const content: ScopeContent = readScope(scope.claudeDir, scope.mcpJsonPath);
	const diskDigest = digestScope(content);
	const scopeId = scopeIdOf(scope.kind, scope.claudeDir);
	const stored = await mirrorDigest(db, scopeId);

	let status: SyncStatus;
	if (stored === null) status = 'unsynced';
	else if (stored === diskDigest) status = 'synced';
	else status = 'out_of_sync';

	return { scopeId, status, diskDigest, mirrorDigest: stored };
}

// ── Catalog read (the /claude-code surface) ──────────────────────────────────────

export interface CatalogScope {
	scopeId: string;
	kind: string;
	path: string;
	project: string | null;
	status: SyncStatus;
	hooks: Array<{ event: string; matcher: string | null; command: string; timeout: number | null }>;
	skills: Array<{ name: string; description: string | null; plugin: string | null; file_path: string }>;
	agents: Array<{ name: string; description: string | null; category: string | null; file_path: string }>;
	mcpServers: Array<{ name: string; type: string; command: string | null; url: string | null }>;
}

function s(v: unknown): string {
	return v == null ? '' : String(v);
}
function sOrNull(v: unknown): string | null {
	return v == null ? null : String(v);
}
function nOrNull(v: unknown): number | null {
	return typeof v === 'number' ? v : null;
}

/**
 * Read the whole config catalog from the MIRROR for the dashboard. LIVE DB data
 * only (F-008) — every row comes from the cc_* tables populated by syncScope.
 * Each scope carries its child hooks/skills/agents/mcp servers. The per-scope
 * `status` is filled by the caller (it needs disk access via syncState); here it
 * defaults to the mirror's own view (synced if a digest exists). The +page.server
 * loader overlays the live disk-vs-mirror status.
 */
export async function readCatalog(db: Db): Promise<CatalogScope[]> {
	const [scopes] = await db.query<
		[Array<{ id: unknown; kind: unknown; path: unknown; project: unknown }>]
	>(`SELECT id, kind, path, project FROM cc_scope ORDER BY kind, path;`);

	const out: CatalogScope[] = [];
	for (const sc of scopes) {
		const scopeId = s(sc.id);
		const scope = link(scopeId);
		const [hooks] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT event, matcher, command, timeout FROM cc_hook WHERE scope = $scope ORDER BY event;`,
			{ scope }
		);
		const [skills] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT name, description, plugin, file_path FROM cc_skill WHERE scope = $scope ORDER BY name;`,
			{ scope }
		);
		const [agents] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT name, description, category, file_path FROM cc_agent WHERE scope = $scope ORDER BY name;`,
			{ scope }
		);
		const [mcp] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT name, type, command, url FROM cc_mcp_server WHERE scope = $scope ORDER BY name;`,
			{ scope }
		);
		const stored = await mirrorDigest(db, scopeId);
		out.push({
			scopeId,
			kind: s(sc.kind),
			path: s(sc.path),
			project: sc.project == null ? null : s(sc.project),
			status: stored === null ? 'unsynced' : 'synced',
			hooks: hooks.map((h) => ({
				event: s(h.event),
				matcher: sOrNull(h.matcher),
				command: s(h.command),
				timeout: nOrNull(h.timeout)
			})),
			skills: skills.map((k) => ({
				name: s(k.name),
				description: sOrNull(k.description),
				plugin: sOrNull(k.plugin),
				file_path: s(k.file_path)
			})),
			agents: agents.map((a) => ({
				name: s(a.name),
				description: sOrNull(a.description),
				category: sOrNull(a.category),
				file_path: s(a.file_path)
			})),
			mcpServers: mcp.map((m) => ({
				name: s(m.name),
				type: s(m.type),
				command: sOrNull(m.command),
				url: sOrNull(m.url)
			}))
		});
	}
	return out;
}

// ── Catalog id allow-list (the D-036 capability validator source) ─────────────────────

/**
 * The flat id allow-list drawn from the mirror — the source of truth a per-task
 * capability set (D-036 / task 5.1) is validated against. Each set is the union of
 * cc_skill / cc_agent / cc_mcp_server names across ALL synced scopes (project + global);
 * the runtime's composeCapabilities() rejects any declared id not in these sets (fail
 * closed). Shape matches the runtime's CapabilityCatalog so it feeds straight in.
 *
 * Pure read of the mirror (no disk, no spawn). LIVE DB only (F-008) — never hard-coded.
 */
export interface CatalogIds {
	skills: Set<string>;
	agents: Set<string>;
	mcp: Set<string>;
}

export async function catalogIds(db: Db): Promise<CatalogIds> {
	const [skills] = await db.query<[Array<{ name: unknown }>]>(`SELECT name FROM cc_skill;`);
	const [agents] = await db.query<[Array<{ name: unknown }>]>(`SELECT name FROM cc_agent;`);
	const [mcp] = await db.query<[Array<{ name: unknown }>]>(`SELECT name FROM cc_mcp_server;`);
	const toSet = (rows: Array<{ name: unknown }>): Set<string> => {
		const set = new Set<string>();
		for (const r of rows) if (typeof r.name === 'string' && r.name) set.add(r.name);
		return set;
	};
	return { skills: toSet(skills), agents: toSet(agents), mcp: toSet(mcp) };
}

// ── CCF-1 — spawn-time catalog freshness (D-036 additive note, 2026-07-08) ─────────────
//
// D-036 is a fail-closed SECURITY allow-list, so the catalog must not go stale in the
// PERMISSIVE direction at spawn time: a skill DELETED (or promoted) from a catalog-feeding
// scope between /claude-code page visits must not keep passing validation via the runtime's
// per-boot snapshot. `/claude-code` reconciles only on page load; the runtime snapshot is
// captured once at boot (harness/wiring.getRuntime). This is the spawn-time freshness seam.
//
// Contract (DECISIONS.md, D-036 note): probe every catalog-feeding scope's disk-vs-mirror
// digest (syncState — cheap: one disk read + one mirror SELECT per scope, NO write). ONLY
// when a scope is `out_of_sync` do we run the SAME reconcile the loader calls (reconcileScopes
// — one reconcile, reused, never a second implementation) and re-read the id-set, so a deleted
// skill leaves the catalog before validation. In-sync/unsynced scopes take the FAST PATH — no
// reconcile — so freshness costs one digest read per scope in steady state (F-053 additive).
//
// Failure semantics: if the triggered reconcile THROWS, validation proceeds against the
// LAST-GOOD id-set (re-read here) and a `staleWarning` is returned so the caller records honest
// staleness in its analytics event — the spawn is NEVER blocked on a reconcile fault (F-014).
// D-036 unknown-id refusal stays fail-closed regardless: composeCapabilities still rejects any
// id absent from whatever id-set this returns.

/** The result of a spawn-time catalog freshness pass ({@link freshenCatalog}). */
export interface CatalogFreshness {
	/** The id-set to validate against — reconciled+fresh when a scope drifted, else the current mirror. */
	catalog: CatalogIds;
	/** True when a drifted (out_of_sync) scope triggered `reconcileScopes` this call. */
	reconciled: boolean;
	/** Set ONLY when a triggered reconcile FAILED — the last-good id-set is used; an honest warning to surface. */
	staleWarning?: string;
}

/** Injectable seams for {@link freshenCatalog} — production defaults reuse the SAME functions the
 *  /claude-code loader calls (no second reconcile). Tests inject spies to assert the fast path
 *  skips reconcile and to force a reconcile failure. */
export interface FreshenCatalogDeps {
	probeStale?: (db: Db) => Promise<boolean>;
	reconcile?: (db: Db) => Promise<unknown>;
	readIds?: (db: Db) => Promise<CatalogIds>;
}

/**
 * Cheap staleness probe: is ANY catalog-feeding cc_scope `out_of_sync` on disk? One disk digest
 * + one mirror SELECT per scope via {@link syncState} (never writes). An unreadable scope path is
 * NOT proof of drift — it is skipped (the loader's status overlay does the same). Mirrors the
 * loader's per-scope syncState overlay so the two freshness paths agree on what "drifted" means.
 */
async function anyScopeOutOfSync(db: Db): Promise<boolean> {
	const [scopes] = await db.query<[Array<{ kind: unknown; path: unknown; project: unknown }>]>(
		`SELECT kind, path, project FROM cc_scope;`
	);
	for (const sc of scopes ?? []) {
		const kind: 'project' | 'global' = sc.kind === 'global' ? 'global' : 'project';
		const path = typeof sc.path === 'string' ? sc.path : '';
		if (!path) continue;
		try {
			const st = await syncState(db, {
				kind,
				claudeDir: path,
				...(sc.project != null ? { project: String(sc.project) } : {})
			});
			if (st.status === 'out_of_sync') return true;
		} catch {
			// An unreadable/vanished scope path is not proof of catalog drift — skip it (parity
			// with the loader's status overlay, which keeps the mirror status on a read failure).
			continue;
		}
	}
	return false;
}

/**
 * Freshen the D-036 catalog id-set at spawn-plan time (CCF-1). See the block comment above for
 * the security rationale + failure semantics. Reuses {@link reconcileScopes} (the loader's
 * reconcile) and {@link catalogIds} (the mirror id-set read) — no second reconcile path.
 */
export async function freshenCatalog(
	db: Db,
	deps: FreshenCatalogDeps = {}
): Promise<CatalogFreshness> {
	const probeStale = deps.probeStale ?? anyScopeOutOfSync;
	const reconcile = deps.reconcile ?? reconcileScopes;
	const readIds = deps.readIds ?? catalogIds;

	const stale = await probeStale(db);
	if (!stale) {
		// FAST PATH — no scope drifted; the mirror IS the fresh catalog. No reconcile (byte-identical
		// steady state — the /claude-code reconcile is the only writer of the mirror on this path).
		return { catalog: await readIds(db), reconciled: false };
	}
	try {
		await reconcile(db);
		return { catalog: await readIds(db), reconciled: true };
	} catch (err) {
		// Reconcile failed — validate against the LAST-GOOD id-set + an honest staleness warning.
		// Never block the spawn on a reconcile fault (F-014); D-036 unknown-id refusal still
		// fail-closes against whatever the last-good mirror holds.
		return {
			catalog: await readIds(db),
			reconciled: false,
			staleWarning:
				`cc-config catalog reconcile failed at spawn time; validating against the ` +
				`last-good snapshot (a deleted/edited scope may still pass until the next ` +
				`successful reconcile): ${(err as Error).message}`
		};
	}
}
