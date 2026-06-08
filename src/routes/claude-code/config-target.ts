// /claude-code config-edit target resolution (TASK 6.7; D-010 / D-016 / D-018).
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
// For agent/skill the catalog supplies the file_path; we re-confine it under the scope so
// the value the page round-trips can't be tampered into an arbitrary write target.

import { resolve, dirname, basename } from 'node:path';
import type { ConfigKind, SyncScope } from '$lib/server/cc-config';

export class ConfigTargetError extends Error {
	override readonly name = 'ConfigTargetError';
}

/** Normalize for prefix-confinement: forward slashes, lower-case (Windows is case-insensitive). */
function norm(p: string): string {
	return resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** True iff `target` is `root` or strictly inside it (prefix-confinement, D-018). */
function isInside(target: string, root: string): boolean {
	const t = norm(target);
	const r = norm(root).replace(/\/+$/, '');
	return t === r || t.startsWith(r + '/');
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
 * Throws ConfigTargetError if the resolved path escapes the scope tree (fail-closed).
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
	// siblings, so the parent dir is the allowed root for those. Use the parent as the
	// outer bound and assert the file lands within it (fail-closed).
	const root = input.kind === 'settings' || input.kind === 'agent' || input.kind === 'skill'
		? claudeDir
		: parent;
	if (!isInside(filePath, root)) {
		throw new ConfigTargetError(
			`config target ${basename(filePath)} escapes its scope — refusing (D-018)`
		);
	}

	const scope: SyncScope = {
		kind: input.scopeKind,
		claudeDir,
		...(input.project ? { project: input.project } : {})
	};
	return { kind: input.kind, filePath, scope };
}
