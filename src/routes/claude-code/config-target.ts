// /claude-code config-edit target resolution (TASK 6.7; hardened TASK 13.5; D-010 / D-016 / D-018).
//
// The config editor edits ONE file at a time inside a known scope. This resolves the
// editable kind → its absolute file path, CONFINED to the scope's directory tree so a
// crafted path can never escape (fail-closed, D-018). The scope's `.claude` dir is the
// authoritative anchor:
//   settings  → <claudeDir>/settings.json
//   mcp_json  → <parent>/.mcp.json        (sibling of .claude)
//   claude_md → <parent>/CLAUDE.md        (sibling of .claude)
//   agent     → an explicit file under <claudeDir>/agents/
//   skill     → an explicit file under <claudeDir>/skills/
//
// TASK 13.5 findings (1)+(2) hardened this boundary:
//   (1) The confinement ANCHOR itself (claudeDir) was previously taken from an untrusted
//       form field — a crafted POST could anchor the editor to an ARBITRARY directory and
//       write settings/agent/skill files under it. `resolveConfigTargetFromCatalog` is now
//       the route's only entry: the allowed scope set is read SERVER-SIDE from the cc_scope
//       catalog, the submitted claudeDir is only a lookup KEY into that set, and resolution
//       proceeds from the catalog's canonical path. An unknown claudeDir fails closed.
//   (2) The old `isInside()` check was lexical (path.resolve) — a symlink inside the scope
//       could redirect the write outside it. Confinement now reuses the realpath-aware
//       `resolveConfinedTarget` (claude-code/guardrails), which resolves symlinks + the
//       nearest existing ancestor BEFORE the prefix check and fails closed on anything
//       unresolvable — the same resolver the runtime gates use (D-016 reuse).

import { resolve, dirname, basename } from 'node:path';
import { resolveConfinedTarget } from '$lib/server/claude-code/guardrails';
import type { ConfigKind, SyncScope } from '$lib/server/cc-config';

export class ConfigTargetError extends Error {
	override readonly name = 'ConfigTargetError';
}

/** Normalize for catalog matching: forward slashes, lower-case (Windows is case-insensitive). */
function norm(p: string): string {
	return resolve(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * One scope the server ALLOWS edits in — read from the cc_scope catalog (the same rows
 * the /claude-code loader renders), NEVER from the request (TASK 13.5 finding 1).
 */
export interface AllowedScope {
	kind: 'project' | 'global';
	/** Absolute path to the scope's `.claude` directory (cc_scope.path). */
	path: string;
	/** The `project:<slug>` record id for project scopes. */
	project?: string;
}

/**
 * Match a submitted claudeDir against the server-side catalog scope set. The submitted
 * value is a lookup KEY only — the returned scope carries the catalog's own canonical
 * path, which is what resolution must anchor on. Null ⇒ not an allowed scope.
 */
export function matchAllowedScope(scopes: AllowedScope[], claudeDir: string): AllowedScope | null {
	if (typeof claudeDir !== 'string' || !claudeDir.trim()) return null;
	const want = norm(claudeDir);
	return scopes.find((s) => norm(s.path) === want) ?? null;
}

export interface ResolvedTarget {
	kind: ConfigKind;
	/** Absolute path to the file to edit. */
	filePath: string;
	/** The SyncScope applyEdit re-syncs after the write. */
	scope: SyncScope;
}

/**
 * Resolve + confine an edit target. `claudeDir` is the scope's `.claude` directory (the
 * CatalogScope.path). `explicitPath` is required for agent/skill (the catalog file_path).
 * Throws ConfigTargetError if the resolved path escapes the scope tree — checked AFTER
 * symlink/realpath resolution (fail-closed, D-018; TASK 13.5 finding 2).
 *
 * Routes must NOT call this with a request-supplied claudeDir — use
 * {@link resolveConfigTargetFromCatalog}, which anchors on the server-side catalog.
 */
export function resolveConfigTarget(input: {
	kind: ConfigKind;
	claudeDir: string;
	scopeKind: 'project' | 'global';
	project?: string;
	explicitPath?: string;
}): ResolvedTarget {
	const claudeDir = resolve(input.claudeDir);
	const parent = dirname(claudeDir);

	let filePath: string;
	switch (input.kind) {
		case 'settings':
			filePath = resolve(claudeDir, 'settings.json');
			break;
		case 'mcp_json':
			filePath = resolve(parent, '.mcp.json');
			break;
		case 'claude_md':
			filePath = resolve(parent, 'CLAUDE.md');
			break;
		case 'agent':
		case 'skill': {
			if (!input.explicitPath) {
				throw new ConfigTargetError(`${input.kind} edit requires a file path`);
			}
			filePath = resolve(input.explicitPath);
			break;
		}
		default:
			throw new ConfigTargetError(`unknown config kind: ${String(input.kind)}`);
	}

	// Confinement root: agent/skill/settings live under .claude; CLAUDE.md/.mcp.json are
	// siblings, so the parent dir is the allowed root for those. The check is realpath-
	// aware (reused guardrails resolver): symlinks + `..` are resolved BEFORE the prefix
	// compare, and an unresolvable root/target fails closed (D-018; 13.5 finding 2).
	const root =
		input.kind === 'settings' || input.kind === 'agent' || input.kind === 'skill'
			? claudeDir
			: parent;
	try {
		resolveConfinedTarget(filePath, root);
	} catch (err) {
		throw new ConfigTargetError(
			`config target ${basename(filePath)} escapes its scope — refusing (D-018): ${(err as Error).message}`
		);
	}

	const scope: SyncScope = {
		kind: input.scopeKind,
		claudeDir,
		...(input.project ? { project: input.project } : {})
	};
	return { kind: input.kind, filePath, scope };
}

/**
 * The route-facing entry (TASK 13.5 finding 1): resolve an edit target where the
 * confinement anchor comes from the SERVER-SIDE catalog scope set, never the request.
 * The submitted `claudeDir` only selects which allowed scope to edit; a value not in
 * the catalog fails CLOSED with an honest error (the route maps it to a 400).
 */
export function resolveConfigTargetFromCatalog(
	scopes: AllowedScope[],
	input: { kind: ConfigKind; claudeDir: string; explicitPath?: string }
): ResolvedTarget {
	const scope = matchAllowedScope(scopes, input.claudeDir);
	if (!scope) {
		throw new ConfigTargetError(
			'unknown config scope — the submitted scope path is not in the catalog (fail closed, D-018)'
		);
	}
	return resolveConfigTarget({
		kind: input.kind,
		// The catalog's canonical path is the anchor — NEVER the raw form value.
		claudeDir: scope.path,
		scopeKind: scope.kind,
		...(scope.project ? { project: scope.project } : {}),
		...(input.explicitPath ? { explicitPath: input.explicitPath } : {})
	});
}
