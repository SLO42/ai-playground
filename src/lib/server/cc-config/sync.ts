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
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
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
	// One cc_settings per scope: delete any existing for this scope, then create.
	await db.query(`DELETE cc_settings WHERE scope = $scope;`, { scope: scopeRid });
	await db.query(`CREATE cc_settings CONTENT $content;`, { content: settingsContent });

	// 3. Child tables — full replace scoped to this scope (mirror = disk exactly).
	await replaceHooks(db, scopeRid, content.settings.hooks);
	await replaceMcpServers(db, scopeRid, content.settings.mcpServers);
	await replaceAgents(db, scopeRid, content.agents);
	await replaceSkills(db, scopeRid, content.skills);

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

async function replaceHooks(db: Db, scope: StringRecordId, hooks: ParsedHook[]): Promise<void> {
	await db.query(`DELETE cc_hook WHERE scope = $scope;`, { scope });
	for (const h of hooks) {
		const content = omitUndefined({
			scope,
			event: h.event,
			matcher: h.matcher,
			command: h.command,
			timeout: h.timeout
		});
		await db.query(`CREATE cc_hook CONTENT $content;`, { content });
	}
}

async function replaceMcpServers(
	db: Db,
	scope: StringRecordId,
	servers: ParsedMcpServer[]
): Promise<void> {
	await db.query(`DELETE cc_mcp_server WHERE scope = $scope;`, { scope });
	for (const s of servers) {
		const content = omitUndefined({
			scope,
			name: s.name,
			type: s.type,
			command: s.command,
			args: s.args,
			url: s.url,
			env: s.env
		});
		await db.query(`CREATE cc_mcp_server CONTENT $content;`, { content });
	}
}

async function replaceAgents(
	db: Db,
	scope: StringRecordId,
	agents: ParsedAgent[]
): Promise<void> {
	await db.query(`DELETE cc_agent WHERE scope = $scope;`, { scope });
	for (const a of agents) {
		const content = omitUndefined({
			scope,
			file_path: a.file_path,
			name: a.name,
			description: a.description,
			frontmatter: a.frontmatter,
			category: a.category
		});
		await db.query(`CREATE cc_agent CONTENT $content;`, { content });
	}
}

async function replaceSkills(
	db: Db,
	scope: StringRecordId,
	skills: ParsedSkill[]
): Promise<void> {
	await db.query(`DELETE cc_skill WHERE scope = $scope;`, { scope });
	for (const s of skills) {
		const content = omitUndefined({
			scope,
			file_path: s.file_path,
			name: s.name,
			description: s.description,
			plugin: s.plugin
		});
		await db.query(`CREATE cc_skill CONTENT $content;`, { content });
	}
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
