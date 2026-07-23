// TASK 1.4a — seed the PRIMARY safety guardrail (D-024/D-018; depends on: 1.4).
//
// Before ANY agent can spawn, write a per-project `.claude/settings.json` carrying
// Claude Code's OWN `permissions.deny` rules + an explicit, project-scoped cwd. This
// is the PRIMARY boundary because Claude Code enforces `permissions.deny` LOCALLY —
// even with our SvelteKit server down (D-024: safety-critical gates fail CLOSED; the
// network PreToolUse/canUseTool gates at 2.13 are defense-in-depth ON TOP of this).
//
// Three rule families (D-018):
//  • config-protection — deny reads/edits of ANY `.env`/secret and ANY `.claude/`
//    across the WHOLE code root (not just our own project).
//  • dangerous-bash    — deny `rm -rf`, `git push`, `git remote set-url`, any `--force`.
//  • path-confinement  — fs/bash targets must resolve, AFTER symlink + `..`
//    normalization, UNDER the project root. Enforced two ways: (a) settings.json
//    scopes `additionalDirectories` to the project root so Claude Code confines fs
//    access; (b) `resolveConfinedTarget` is the server-independent resolver our own
//    runtime/gates call — it FAILS CLOSED on escape / unresolvable / broken-symlink.
//
// NO DB, NO server, NO spawn here — pure config generation + a pure path resolver, so
// the guarantee holds with the server down (the 1.4a verify requirement).

import {
	mkdirSync,
	writeFileSync,
	renameSync,
	unlinkSync,
	readFileSync,
	realpathSync,
	lstatSync
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** Bump when the rule set changes so a re-seed can detect a stale generated config. */
export const GUARDRAIL_SETTINGS_VERSION = 2;

// ── Static deny rules (config-protection) ────────────────────────────────────────
//
// Claude Code permission-rule syntax (verified against official settings docs):
//   Read(<glob>) / Edit(<glob>) / Write(<glob>) / Bash(<command-pattern>) with `*`
//   wildcards at any position. `**` matches across directories. These globs are
//   ROOT-RELATIVE-agnostic — the leading `**/` makes them bite anywhere Claude Code
//   would otherwise be allowed (incl. sibling projects under the code root), which is
//   exactly the cross-project config-protection we want.

/** Deny reading/editing ANY env/secret file or ANY `.claude/` dir, anywhere. */
export const CONFIG_PROTECTION_DENY: readonly string[] = [
	// .env and dotenv variants (.env, .env.local, .env.production, …).
	'Read(**/.env)',
	'Read(**/.env.*)',
	'Edit(**/.env)',
	'Edit(**/.env.*)',
	'Write(**/.env)',
	'Write(**/.env.*)',
	// Common secret material.
	'Read(**/*.pem)',
	'Read(**/*.key)',
	'Read(**/id_rsa)',
	'Read(**/id_ed25519)',
	'Read(**/secrets/**)',
	'Read(**/*.secret)',
	// ANY project's Claude Code config (settings carry tokens/hooks/permissions).
	'Read(**/.claude/**)',
	'Edit(**/.claude/**)',
	'Write(**/.claude/**)',
	'Read(**/.mcp.json)',
	'Edit(**/.mcp.json)'
] as const;

/** Deny destructive / push / force bash commands (D-018 dangerous-bash). */
export const DANGEROUS_BASH_DENY: readonly string[] = [
	'Bash(rm -rf*)',
	'Bash(rm -fr*)',
	'Bash(* rm -rf*)',
	'Bash(git push*)',
	'Bash(* git push*)',
	// `git -C <dir> push` runs git AS IF from <dir>, so the command no longer begins `git push`
	// and slips past both rules above (SF2-4c red-team bypass). Deny push under ANY `-C` redirect,
	// whether `-C` leads the command or appears mid-command (chained/quoted).
	'Bash(git -C* push*)',
	'Bash(* git -C* push*)',
	'Bash(git remote set-url*)',
	'Bash(* git remote set-url*)',
	// Any --force anywhere in the command (push --force, checkout --force, …).
	'Bash(*--force*)',
	'Bash(*-f --hard*)',
	'Bash(git reset --hard*)'
] as const;

// ── Generated settings.json ──────────────────────────────────────────────────────

export interface GuardrailInput {
	/** Absolute path to the project root — the session cwd + confinement boundary. */
	projectRoot: string;
	/** Absolute path to the code root (CODE_ROOT) the config-protection spans. */
	codeRoot: string;
}

/** The subset of settings.json this task authors (merged into any existing file). */
export interface GuardrailSettings {
	permissions?: {
		deny?: string[];
		additionalDirectories?: string[];
		disableBypassPermissionsMode?: string;
		[k: string]: unknown;
	};
	env?: Record<string, string>;
	[k: string]: unknown;
}

/**
 * Build the guardrail settings object for one project. Deterministic (same inputs →
 * byte-identical output). The deny list = config-protection ∪ dangerous-bash;
 * `additionalDirectories` scopes Claude Code's fs access to the project root (the cwd
 * confinement); `disableBypassPermissionsMode: "disable"` stops a looping/injected
 * agent flipping itself into bypass mode.
 */
export function buildGuardrailSettings(input: GuardrailInput): GuardrailSettings {
	const root = resolve(input.projectRoot);
	return {
		permissions: {
			deny: [...CONFIG_PROTECTION_DENY, ...DANGEROUS_BASH_DENY],
			additionalDirectories: [root],
			disableBypassPermissionsMode: 'disable'
		},
		env: {
			HARNESS_GUARDRAIL_VERSION: String(GUARDRAIL_SETTINGS_VERSION)
		}
	};
}

/** Deep-ish merge: union deny arrays (dedup), prefer guardrail values for our keys. */
function mergeSettings(
	existing: Record<string, unknown>,
	guard: GuardrailSettings
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...existing };

	const existingPerms =
		existing.permissions && typeof existing.permissions === 'object' && !Array.isArray(existing.permissions)
			? (existing.permissions as Record<string, unknown>)
			: {};
	const guardPerms = guard.permissions ?? {};

	const existingDeny = Array.isArray(existingPerms.deny)
		? (existingPerms.deny as unknown[]).filter((x): x is string => typeof x === 'string')
		: [];
	// Union, deny-wins, dedup, stable order (existing first, then any new guard rules).
	const deny = [...new Set([...existingDeny, ...(guardPerms.deny ?? [])])];

	out.permissions = {
		...existingPerms,
		...guardPerms,
		deny
	};

	out.env = {
		...(existing.env && typeof existing.env === 'object' && !Array.isArray(existing.env)
			? (existing.env as Record<string, unknown>)
			: {}),
		...guard.env
	};

	return out;
}

/**
 * Write `<projectRoot>/.claude/settings.json` with the guardrails MERGED into any
 * existing file (never clobbering unrelated keys; deny rules are unioned). Idempotent.
 * Returns the absolute path written. Pure fs — no server/DB, so it works (and the
 * guarantee holds) with the server down.
 */
export function writeProjectGuardrails(input: GuardrailInput): string {
	const claudeDir = join(resolve(input.projectRoot), '.claude');
	const settingsPath = join(claudeDir, 'settings.json');

	let existing: Record<string, unknown> = {};
	try {
		const text = readFileSync(settingsPath, 'utf8');
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			existing = parsed as Record<string, unknown>;
		}
	} catch {
		existing = {}; // missing/malformed → start clean (guardrails are authoritative)
	}

	const merged = mergeSettings(existing, buildGuardrailSettings(input));

	mkdirSync(claudeDir, { recursive: true });
	atomicWriteFileSync(settingsPath, JSON.stringify(merged, null, '\t') + '\n');
	return settingsPath;
}

/**
 * Write `data` to `path` ATOMICALLY (SF2-4a): stage into a unique sibling temp file, then rename
 * it OVER the target. rename is atomic within a filesystem (POSIX rename; Windows MoveFileEx with
 * REPLACE_EXISTING), so a crash mid-write can only ever leave a partial TEMP file — the target is
 * either the old complete content or the new complete content, NEVER a truncated in-between. A
 * truncated D-024 `settings.json` would silently drop deny rules = a security downgrade, so the
 * guardrail file must never be written non-atomically. On any failure the temp file is best-effort
 * removed and the original error rethrown (the cleanup never masks the real write/rename error).
 * The temp lives in the SAME directory as the target so the rename stays intra-filesystem.
 */
function atomicWriteFileSync(path: string, data: string): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		writeFileSync(tmp, data, 'utf8');
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort cleanup of the staged temp — never mask the original write/rename error
		}
		throw err;
	}
}

// ── Self-host exemption (CCH-2 red-team fix) ──────────────────────────────────────
//
// The D-024 guardrail must NEVER be seeded into Atelier's OWN worktree — the control-
// plane repo the platform itself runs from (D-040 self-host root). Doing so writes a
// self-clamping `.claude/settings.json` INTO the platform repo: Claude Code loads project
// settings.json locally, so a session operating here would inherit `Bash(git push*)`,
// `Bash(*--force*)`, `Read(**/.claude/**)` and `disableBypassPermissionsMode:disable` —
// denies that directly contradict the platform's OWN documented ops (CLAUDE.md §5/F-051
// `git push origin v2`; §8 `@.claude/skills/*` reads). Worse, mergeSettings UNIONS deny,
// so the row self-re-injects every boot and the operator cannot durably remove it while a
// project row points at this worktree. Both write paths (scanProject registration + the
// boot reconcile) route through this guard.

/**
 * True iff `projectRoot` IS the platform's own worktree (the D-040 self-host root Atelier
 * runs from) or an ANCESTOR that contains it — the one root the D-024 guardrail must never
 * clamp. Realpath-compared so a symlinked worktree still matches; fail-SAFE (an unresolvable
 * path → `false`, so a genuine project is never wrongly exempted from its guardrail).
 *
 * @param projectRoot the candidate project root about to be guarded.
 * @param selfRoot    the platform's own worktree — defaults to `process.cwd()` (the dir the
 *                    SvelteKit server booted from; the established self-root signal in this
 *                    codebase, cf. harness/wiring.ts). Injectable for tests.
 */
export function isPlatformSelfRoot(
	projectRoot: string,
	selfRoot: string = process.cwd()
): boolean {
	let realSelf: string;
	let realProject: string;
	try {
		realSelf = realpathSync(resolve(selfRoot));
		realProject = realpathSync(resolve(projectRoot));
	} catch {
		return false; // unresolvable on either side → not PROVABLY self; guard the project normally
	}
	// Skip when the project root equals the platform worktree (the measured self-clamp), OR is
	// an ancestor that contains it (a guardrail at/above the platform root could still bite it).
	return isUnder(realSelf, realProject);
}

// ── Path-confinement resolver (server-independent, fail CLOSED) ───────────────────

/** Thrown when a target escapes the project root, or cannot be resolved (fail closed). */
export class PathConfinementError extends Error {
	override readonly name = 'PathConfinementError';
	constructor(
		message: string,
		readonly target: string,
		readonly root: string
	) {
		super(message);
	}
}

/** True iff `child` is the root itself or strictly inside it (boundary-aware, no prefix bug). */
function isUnder(child: string, root: string): boolean {
	if (child === root) return true;
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	return child.startsWith(rootWithSep);
}

/**
 * Resolve a file/bash target against a project root, enforcing path-confinement AFTER
 * symlink resolution + `..` normalization, and FAILING CLOSED. The boundary the
 * runtime/gates call before letting a target through (the code-side complement of the
 * settings.json `additionalDirectories` scope).
 *
 * Rules (deny = throw PathConfinementError):
 *  1. The root must itself resolve to a real directory — an unresolvable root denies all.
 *  2. If the target exists (incl. via symlink), its REAL path (realpath) must be under
 *     the resolved root. A symlink whose real target is outside → denied.
 *  3. If the target does not exist yet, its nearest existing ancestor is realpath'd and
 *     must be under the root, AND the normalized full path must be under the root. A
 *     BROKEN symlink (ancestor that exists but cannot be realpath'd, or a dangling link
 *     component) is unresolvable → denied (never silently allowed).
 *
 * @returns the resolved absolute target path on success.
 */
export function resolveConfinedTarget(target: string, root: string): string {
	// (1) The root must resolve to a real path. Unresolvable root → fail closed.
	let realRoot: string;
	try {
		realRoot = realpathSync(resolve(root));
	} catch {
		throw new PathConfinementError(
			`project root is unresolvable — denying all targets (fail closed): ${root}`,
			target,
			root
		);
	}

	const abs = resolve(root, target); // normalizes `..` against the root

	// (2) Target (or an intermediate component) exists: realpath the deepest resolvable
	//     path and require the REAL location to be under the root. This catches a symlink
	//     pointing outside the root.
	let real: string | undefined;
	try {
		real = realpathSync(abs);
	} catch {
		real = undefined; // does not (fully) exist yet — fall to ancestor check
	}

	// A path component that exists as a symlink but whose realpath FAILED is a broken /
	// dangling link (the leaf itself, since `resolve` does not follow symlinks). It is
	// unresolvable → fail closed, never fall through to the ancestor allow path.
	if (real === undefined) {
		try {
			if (lstatSync(abs).isSymbolicLink()) {
				throw new PathConfinementError(
					`target is a broken/unresolvable symlink — denying (fail closed): ${abs}`,
					target,
					root
				);
			}
		} catch (err) {
			if (err instanceof PathConfinementError) throw err;
			// lstat failed → the leaf does not exist at all; legitimate not-yet-created
			// target, fall through to the ancestor check.
		}
	}

	if (real !== undefined) {
		if (!isUnder(real, realRoot)) {
			throw new PathConfinementError(
				`target resolves outside the project root (symlink/.. escape): ${real} not under ${realRoot}`,
				target,
				root
			);
		}
		return abs;
	}

	// (3) Target does not fully exist. Walk up to the nearest EXISTING ancestor and
	//     realpath IT (so a symlinked parent is resolved). If no ancestor up to the root
	//     can be resolved, the path is unresolvable → fail closed (covers broken symlink
	//     components: a dangling link as an intermediate dir can't be realpath'd).
	let cursor = abs;
	for (;;) {
		const parent = dirname(cursor);
		if (parent === cursor) break; // reached fs root without finding the project root
		let realParent: string | undefined;
		try {
			realParent = realpathSync(parent);
		} catch {
			realParent = undefined;
		}
		if (realParent !== undefined) {
			// Nearest existing ancestor resolved. It must be under the root, AND the
			// remaining (non-existent) suffix must not climb back out via `..`.
			if (!isUnder(realParent, realRoot)) {
				throw new PathConfinementError(
					`target's nearest existing ancestor is outside the project root: ${realParent} not under ${realRoot}`,
					target,
					root
				);
			}
			if (!isUnder(abs, realRoot)) {
				throw new PathConfinementError(
					`normalized target escapes the project root (.. traversal): ${abs} not under ${realRoot}`,
					target,
					root
				);
			}
			return abs;
		}
		cursor = parent;
	}

	// No resolvable ancestor at all (e.g. the whole chain is a broken symlink, or the
	// target lies outside any existing tree) → unresolvable → fail closed.
	throw new PathConfinementError(
		`target is unresolvable (no existing ancestor under the root — fail closed): ${target}`,
		target,
		root
	);
}
