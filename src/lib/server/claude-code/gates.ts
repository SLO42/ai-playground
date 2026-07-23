// TASK 2.13 (+13.3 wiring) — the GATE layer: defense-in-depth ON TOP of 1.4a's primary
// permissions.deny (D-024/D-018). A single PURE evaluator (`evaluateGate`) is consulted
// by BOTH enforcement paths so they share one gate config (ARCHITECTURE §2.10e):
//   • SDK / runtime path — `ClaudeCodeRuntime.plan()` builds `gateCanUseTool` onto every
//     `CcSpawnPlan.canUseTool`; backends that execute tools programmatically (SDK/mock)
//     consult it BEFORE running a tool (runtime/index.ts).
//   • CLI path — `cli-backend.ts` registers a `PreToolUse` hook in the isolated settings
//     it writes (gate-transport.ts → scripts/gate-hook.mjs → POST /api/gates/pretooluse →
//     `gatePreToolUse`). The hook transport FAILS CLOSED: an unreachable/erroring gate
//     endpoint denies the tool (ROADMAP 2.13 / D-024), unlike the analytics hook proxy.
//
// Five gate families (D-018):
//   • config-protection — deny reads/edits of ANY .env/secret or ANY .claude/ across the
//     whole code root (the same rule globs 1.4a seeds into permissions.deny).
//   • read-before-edit  — block Edit on a file not Read this session (session read-set).
//   • dangerous-bash    — deny rm -rf / git push / git remote set-url / any --force.
//   • path-confinement  — every fs/bash target must resolve UNDER the project root AFTER
//     symlink + ".." normalization — reusing 1.4a's resolveConfinedTarget (fail closed).
//   • edit-scope        — TASK 15.1 (HARVEST B1): the SCOPE-LOCK edit gate. When a session
//     declares an editScope ({scopeRoots, scopeAllow, destructiveBash}), file-WRITING
//     tools (Edit/Write/NotebookEdit/MultiEdit) and detectable bash write redirections
//     targeting paths outside the declared scope are DENIED, and a configurable
//     destructive-bash deny-list (with full-command safe exceptions) is enforced.
//     Opt-in per session: an ABSENT editScope means no scope gating (c).
//
// D-024 fail-closed: the SAFETY-CRITICAL families (config-protection, dangerous-bash,
// path-confinement, edit-scope) ALWAYS hard-deny — policy may NOT downgrade them to
// warn — and ANY evaluator error (bad input, unresolvable root, internal throw) returns
// DENY, never allow. read-before-edit is non-safety-critical and IS policy-downgradable.
//
// PURE: no DB, no server, no spawn — so the guarantee holds with the server down, same
// as 1.4a. It reuses the 1.4a deny-rule constants + resolver (DRY, single source of truth).

import { resolveConfinedTarget, PathConfinementError } from './guardrails';
import { resolve, dirname, join, sep } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';

// ── Gate names + policy ────────────────────────────────────────────────────────────

export type GateName =
	| 'config-protection'
	| 'read-before-edit'
	| 'dangerous-bash'
	| 'path-confinement'
	| 'edit-scope'
	| 'fetch-allowlist';

export type GateMode = 'deny' | 'warn';

/** Per-gate mode (configurable per project, D-018). Absent gate ⇒ its built-in default. */
export type GatePolicy = Partial<Record<GateName, GateMode>>;

/**
 * Safety-critical families fail CLOSED (D-024): they ALWAYS hard-block and policy can
 * never downgrade them to warn. read-before-edit alone is downgradable to warn.
 */
const SAFETY_CRITICAL: ReadonlySet<GateName> = new Set([
	'config-protection',
	'dangerous-bash',
	'path-confinement',
	'edit-scope',
	'fetch-allowlist'
]);

/** Built-in defaults: everything hard-blocks unless a project policy says warn. */
export const DEFAULT_GATE_POLICY: Readonly<Required<GatePolicy>> = Object.freeze({
	'config-protection': 'deny',
	'read-before-edit': 'deny',
	'dangerous-bash': 'deny',
	'path-confinement': 'deny',
	'edit-scope': 'deny',
	'fetch-allowlist': 'deny'
});

/** Thrown by {@link parseGatePolicy} on a malformed gate config — callers FAIL CLOSED. */
export class GatePolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GatePolicyError';
	}
}

/**
 * STRICT gate-config parser (13.3, D-024): the raw `gates` record a spawn carries
 * (gate-name → mode) is untrusted config. An unknown gate name or an invalid mode
 * THROWS {@link GatePolicyError} — the caller must treat that as a hard block
 * (fail the spawn / deny the tool), NEVER silently drop the bad entry and allow.
 */
export function parseGatePolicy(raw: Record<string, unknown> | undefined): GatePolicy {
	const out: GatePolicy = {};
	for (const [name, mode] of Object.entries(raw ?? {})) {
		if (!(name in DEFAULT_GATE_POLICY)) {
			throw new GatePolicyError(`unknown gate '${name}' in gate config — failing closed (D-024)`);
		}
		if (mode !== 'deny' && mode !== 'warn') {
			throw new GatePolicyError(
				`invalid mode '${String(mode)}' for gate '${name}' — failing closed (D-024)`
			);
		}
		out[name as GateName] = mode;
	}
	return out;
}

// ── Tool-call shape (a normalized view over the SDK / hook payloads) ─────────────────

export interface ToolCall {
	/** Tool name: Read | Edit | Write | Bash | Glob | Grep | … */
	name: string;
	/** Raw tool input (file_path / command / etc.). Treated as untrusted. */
	input: unknown;
}

export interface GateContext {
	/** Absolute project root — the confinement boundary + cwd (1.4a). */
	projectRoot: string;
	/** Absolute code root the config-protection spans. */
	codeRoot: string;
	/** Per-session state (the read-before-edit read-set). */
	session: GateSession;
	/** Per-project gate modes; missing gates fall back to DEFAULT_GATE_POLICY. */
	policy?: GatePolicy;
	/**
	 * TASK 15.1 (B1 scope-lock) — the session's COMPILED edit scope ({@link parseEditScope}).
	 * Absent ⇒ no scope gating (the feature is opt-in per session policy, requirement (c)).
	 */
	editScope?: EditScope;
	/**
	 * WORKFORCE-SPEC §7b.4 (fix) — the session's COMPILED fetch allowlist
	 * ({@link parseFetchAllowlist}). When present, WebFetch/WebSearch are gated fail-closed
	 * to the single allowed origin (the loopback stub-web): a WebFetch to any other origin —
	 * and EVERY WebSearch (it reaches the open web, no URL to scope) — is DENIED. Absent ⇒ no
	 * fetch gating (the feature is opt-in: a non-web session never touches this branch).
	 */
	fetchAllowlist?: FetchAllowlist;
}

export interface GateDecision {
	decision: 'allow' | 'deny' | 'warn';
	/** Which gate produced a deny/warn (undefined on allow). */
	gate?: GateName;
	/** Human-readable reason for telemetry / the operator. */
	reason?: string;
}

// ── Session read-set (read-before-edit) ──────────────────────────────────────────────

export interface GateSession {
	/** Absolute paths Read this session (normalized). */
	readPaths: Set<string>;
}

export function createGateSession(): GateSession {
	return { readPaths: new Set<string>() };
}

// ── config-protection: the SAME globs 1.4a seeds into permissions.deny ───────────────
//
// We re-derive the bite from the deny-rule constants so the defense-in-depth layer can
// never drift from the primary boundary. The rules are `Verb(<glob>)`; we match on the
// glob with `**` = any dirs, `*` = any chars within a segment.

/** Deny ANY read/edit/write of these path shapes anywhere under the code root. */
const CONFIG_PROTECTION_GLOBS: readonly string[] = [
	'**/.env',
	'**/.env.*',
	'**/*.pem',
	'**/*.key',
	'**/id_rsa',
	'**/id_ed25519',
	'**/secrets/**',
	'**/*.secret',
	'**/.claude/**',
	'**/.mcp.json'
];

/** Compile a Claude-Code-style glob (`**`, `*`) to a full-match RegExp over a POSIX path. */
function globToRegExp(glob: string, flags = ''): RegExp {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				i++;
				// `**/` ⇒ zero-or-more path segments; bare `**` ⇒ anything.
				if (glob[i + 1] === '/') {
					i++;
					re += '(?:.*/)?';
				} else {
					re += '.*';
				}
			} else {
				re += '[^/]*'; // single `*` stays within a segment
			}
		} else if ('\\^$.|?+()[]{}'.includes(c)) {
			re += '\\' + c;
		} else {
			re += c;
		}
	}
	return new RegExp('^' + re + '$', flags);
}

const CONFIG_PROTECTION_RE = CONFIG_PROTECTION_GLOBS.map((g) => globToRegExp(g));

function isProtectedConfigPath(absPosix: string): boolean {
	return CONFIG_PROTECTION_RE.some((re) => re.test(absPosix));
}

// ── dangerous-bash: the SAME family 1.4a denies (rm -rf / push / set-url / --force) ──

/** Normalize a bash command for pattern matching: lower-cased, whitespace-collapsed. */
function normalizeBashCommand(command: string): string {
	return command.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The recursive-rm rule, SEPARATED from the rest (TASK 15.1): a session-scoped
 * editScope may carry FULL-COMMAND safe-exception patterns (destructiveBash.allow —
 * e.g. `rm -rf node_modules`) that bypass THIS rule and only this rule. The push /
 * set-url / --force / reset-hard rules below are never exception-able (D-024).
 */
const DANGEROUS_BASH_RM_RE = /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/; // rm -rf / -fr in any flag clustering

/** Each entry tests against the raw command string (lower-cased, whitespace-collapsed). */
const DANGEROUS_BASH_RE: readonly RegExp[] = [
	/\bgit\s+push\b/,
	// `git -C <dir> push` (and `-c <cfg>`) run git as-if elsewhere, so the command no longer reads
	// `git push` and slips past the rule above (SF2-4c bypass; -C is lower-cased to -c by normalize).
	/\bgit\s+-c\b.*\bpush\b/,
	/\bgit\s+remote\s+set-url\b/,
	/--force\b/,
	/\bgit\s+reset\s+--hard\b/,
	/-f\s+--hard\b/
];

function isDangerousBash(command: string, skipRmRule = false): boolean {
	const norm = normalizeBashCommand(command);
	if (!skipRmRule && DANGEROUS_BASH_RM_RE.test(norm)) return true;
	return DANGEROUS_BASH_RE.some((re) => re.test(norm));
}

// ── edit-scope (TASK 15.1 / HARVEST B1): the SCOPE-LOCK edit gate ────────────────────
//
// Mechanizes CLAUDE.md's advisory "files to modify is your scope lock" + the fix-loop's
// "fix cited defects ONLY" as a real D-018 gate. A session DECLARES its edit scope
// ({scopeRoots, scopeAllow}); the gate then DENIES Edit/Write/NotebookEdit/MultiEdit and
// detectable bash write redirections (`>`, `>>`, `tee`) targeting paths outside it, plus
// a CONFIG-DRIVEN destructive-bash deny-list with full-command safe exceptions.
//
// PROVENANCE: the boundary-check shape is harvested from gstack freeze/bin/check-freeze.sh
// and the destructive-pattern/safe-exception shape from gstack careful/bin/check-careful.sh
// (MIT, github.com/sublayerapp/gstack via the local audit clone). Both gstack mechanisms
// fail OPEN (unparseable path/command ⇒ allow — a D-024 violation), so the MECHANISM here
// is reimplemented FAIL-CLOSED: an unresolvable/ambiguous target or a malformed scope
// config DENIES, never allows. The destructive pattern LISTS ship in operator-editable
// gate config (config/gates.yaml), not hardcoded (requirement (b)).
//
// Windows-safe path comparison (requirement (a), 13.5 symlink discipline): separators
// normalized + `..` resolved via `resolve`, realpath where the path exists (a symlink
// whose REAL target is out of scope is denied; broken symlinks are unresolvable ⇒ deny),
// nearest-existing-ancestor realpath for not-yet-created targets, and the comparison is
// case-INSENSITIVE on win32 (drive letters AND segments — NTFS is case-insensitive, so a
// case-gamed path is the same file).
//
// KNOWN DETECTION BOUNDARY (named, not hidden): bash file writes that are NOT a
// redirection/tee (cp/mv/sed -i/plain rm of an in-scope-root file) are not per-target
// detectable here — they remain covered by dangerous-bash, path-confinement and the 1.4a
// permissions.deny layer. A `>` INSIDE a quoted string can false-POSITIVE (deny) — the
// fail-closed direction (D-024).

/** Thrown on a malformed editScope config — callers FAIL CLOSED (requirement (c)). */
export class EditScopeError extends Error {
	override readonly name = 'EditScopeError';
}

/** One operator-authored destructive-bash pattern (ships in config/gates.yaml). */
export interface DestructiveBashPatternInput {
	/** Stable pattern id — names WHICH pattern fired in the deny reason. */
	id: string;
	/** A RegExp source, matched against the lower-cased, whitespace-collapsed command. */
	pattern: string;
	/** Operator-readable reason surfaced in the deny message. */
	reason?: string;
}

/** The RAW (JSON-serializable) edit scope a session declares — validated by parseEditScope. */
export interface EditScopeInput {
	/** Paths (absolute, or relative to the project root) the session MAY write under. */
	scopeRoots: string[];
	// Glob exceptions (Claude-Code-style ** and *, matched against the canonical POSIX
	// absolute path) allowed OUTSIDE the scope roots — e.g. "**" + "/docs/fails.md".
	scopeAllow?: string[];
	/** Operator-editable destructive-bash pattern lists (from config/gates.yaml). */
	destructiveBash?: {
		/** Substring-matched deny patterns. */
		deny?: DestructiveBashPatternInput[];
		/** FULL-COMMAND-anchored safe exceptions (e.g. `rm -rf node_modules`). */
		allow?: DestructiveBashPatternInput[];
	};
}

interface CompiledBashPattern {
	id: string;
	re: RegExp;
	reason?: string;
}

/** The COMPILED edit scope the evaluator consumes (regexes pre-compiled at parse time). */
export interface EditScope {
	scopeRoots: string[];
	scopeAllow: { glob: string; re: RegExp }[];
	destructiveDeny: CompiledBashPattern[];
	/** Full-command anchored (`^(?:pattern)$`) — an exception must describe the WHOLE
	 *  command, so `rm -rf node_modules && git checkout .` never rides an exception. */
	destructiveAllow: CompiledBashPattern[];
}

const IS_WINDOWS = process.platform === 'win32';

function compileBashPatterns(
	raw: unknown,
	kind: 'deny' | 'allow',
	fullMatch: boolean
): CompiledBashPattern[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		throw new EditScopeError(
			`editScope.destructiveBash.${kind} must be a list — failing closed (D-024)`
		);
	}
	return raw.map((entry, i) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new EditScopeError(
				`editScope.destructiveBash.${kind}[${i}] must be an object {id, pattern, reason?} — failing closed (D-024)`
			);
		}
		const { id, pattern, reason } = entry as Record<string, unknown>;
		if (typeof id !== 'string' || !id.trim()) {
			throw new EditScopeError(
				`editScope.destructiveBash.${kind}[${i}] needs a non-empty string id — failing closed (D-024)`
			);
		}
		if (typeof pattern !== 'string' || !pattern.trim()) {
			throw new EditScopeError(
				`editScope.destructiveBash.${kind} '${id}' needs a non-empty string pattern — failing closed (D-024)`
			);
		}
		if (reason !== undefined && typeof reason !== 'string') {
			throw new EditScopeError(
				`editScope.destructiveBash.${kind} '${id}' reason must be a string — failing closed (D-024)`
			);
		}
		let re: RegExp;
		try {
			re = new RegExp(fullMatch ? `^(?:${pattern})$` : pattern);
		} catch (err) {
			throw new EditScopeError(
				`editScope.destructiveBash.${kind} '${id}' pattern does not compile — failing closed (D-024): ${(err as Error).message}`
			);
		}
		return { id, re, ...(reason !== undefined ? { reason } : {}) };
	});
}

/**
 * STRICT editScope parser (requirement (c), D-024): `undefined`/`null` ⇒ no scope gating
 * (opt-in feature, returns undefined). ANY malformed shape — non-object, empty/non-string
 * scopeRoots, bad scopeAllow, an uncompilable destructive pattern — THROWS
 * {@link EditScopeError}; callers MUST treat that as a hard block (fail the spawn / deny
 * the tool), never silently drop the scope and run unscoped.
 */
export function parseEditScope(raw: unknown): EditScope | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new EditScopeError('editScope must be an object — failing closed (D-024)');
	}
	const o = raw as Record<string, unknown>;
	const roots = o.scopeRoots;
	if (
		!Array.isArray(roots) ||
		roots.length === 0 ||
		roots.some((r) => typeof r !== 'string' || !r.trim())
	) {
		throw new EditScopeError(
			'editScope.scopeRoots must be a non-empty list of non-empty path strings — failing closed (D-024)'
		);
	}
	const allowGlobs = o.scopeAllow ?? [];
	if (!Array.isArray(allowGlobs) || allowGlobs.some((g) => typeof g !== 'string' || !g.trim())) {
		throw new EditScopeError(
			'editScope.scopeAllow must be a list of non-empty glob strings — failing closed (D-024)'
		);
	}
	const db = o.destructiveBash;
	if (db !== undefined && (db === null || typeof db !== 'object' || Array.isArray(db))) {
		throw new EditScopeError(
			'editScope.destructiveBash must be an object with deny/allow lists — failing closed (D-024)'
		);
	}
	const dbo = (db ?? {}) as Record<string, unknown>;
	return {
		scopeRoots: [...(roots as string[])],
		// Case-insensitive on win32 only — a case-insensitive exception on POSIX would
		// over-allow (a fail-OPEN direction we never take).
		scopeAllow: (allowGlobs as string[]).map((glob) => ({
			glob,
			re: globToRegExp(glob, IS_WINDOWS ? 'i' : '')
		})),
		destructiveDeny: compileBashPatterns(dbo.deny, 'deny', false),
		destructiveAllow: compileBashPatterns(dbo.allow, 'allow', true)
	};
}

/** Case-fold for path comparison — win32 paths are case-insensitive (NTFS). */
function casefoldPath(p: string): string {
	return IS_WINDOWS ? p.toLowerCase() : p;
}

/** True iff `child` is `root` itself or strictly under it (boundary-aware, no prefix bug). */
function isUnderPath(child: string, root: string): boolean {
	if (child === root) return true;
	const r = root.endsWith(sep) ? root : root + sep;
	return child.startsWith(r);
}

/**
 * Canonicalize an absolute path for scope comparison, 13.5 symlink discipline:
 * realpath when it exists (a symlink's REAL location is what gets compared); for a
 * not-yet-created target, realpath the nearest EXISTING ancestor and append the
 * normalized suffix. THROWS (fail closed) on a broken/dangling symlink — leaf or
 * intermediate — or a path with no resolvable ancestor at all.
 */
function canonicalForScope(abs: string): string {
	try {
		return realpathSync(abs);
	} catch {
		/* not (fully) existing — fall through to the ancestor walk */
	}
	// A dangling-symlink LEAF is unresolvable — deny, never treat as a fresh create.
	try {
		if (lstatSync(abs).isSymbolicLink()) {
			throw new EditScopeError(`target is a broken/unresolvable symlink — failing closed: ${abs}`);
		}
	} catch (err) {
		if (err instanceof EditScopeError) throw err;
		// lstat failed ⇒ the leaf does not exist at all — a legitimate create target.
	}
	let cursor = abs;
	for (;;) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		let real: string | undefined;
		try {
			real = realpathSync(parent);
		} catch {
			real = undefined;
		}
		if (real !== undefined) return join(real, abs.slice(parent.length));
		// A dangling symlink as an INTERMEDIATE component is unresolvable — fail closed.
		try {
			if (lstatSync(parent).isSymbolicLink()) {
				throw new EditScopeError(
					`path component is a broken/unresolvable symlink — failing closed: ${parent}`
				);
			}
		} catch (err) {
			if (err instanceof EditScopeError) throw err;
		}
		cursor = parent;
	}
	throw new EditScopeError(`target is unresolvable (no existing ancestor) — failing closed: ${abs}`);
}

/** Canonicalize a scope ROOT: realpath when it exists; a not-yet-created root confines by
 *  its normalized absolute path; a dangling-symlink root is unresolvable ⇒ throw. */
function canonicalScopeRoot(abs: string): string {
	try {
		return realpathSync(abs);
	} catch {
		try {
			if (lstatSync(abs).isSymbolicLink()) {
				throw new EditScopeError(
					`scope root is a broken/unresolvable symlink — failing closed: ${abs}`
				);
			}
		} catch (err) {
			if (err instanceof EditScopeError) throw err;
		}
		return abs;
	}
}

/** File tools that WRITE — the set the scope-lock gates. Read deliberately stays free:
 *  the scope lock is an EDIT gate; reads are governed by config-protection/confinement. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * Extract the file targets a bash command DETECTABLY writes: `>` / `>>` redirections
 * (incl. `N>` / `&>` and the `>|` clobber-override forms) and `tee` arguments.
 * fd-duplication (`2>&1`) and the null sinks (/dev/null, nul, $null) are skipped.
 * Conservative by design — see the detection boundary note above; a false positive
 * denies (fail closed), never allows.
 */
function bashWriteTargets(command: string): string[] {
	const out: string[] = [];
	// `\|?` after the `>`/`>>` captures the `>|` clobber-override operator (bash, even
	// under `set -o noclobber`) — without it `>| path` extracted NO target and the
	// out-of-scope write slipped through (a fail-OPEN; F-019/D-024 scope-lock fix).
	const redir = /(?:\d|&)?>{1,2}\|?\s*("[^"]*"|'[^']*'|[^\s;|&)]+)/g;
	let m: RegExpExecArray | null;
	while ((m = redir.exec(command)) !== null) {
		const t = m[1].replace(/^["']|["']$/g, '');
		if (!t || /^&\d*$/.test(t)) continue; // 2>&1 — fd duplication, not a file
		if (/^(\/dev\/null|nul|\$null)$/i.test(t)) continue;
		out.push(t);
	}
	const tee = /\btee\s+([^;|&]+)/g;
	while ((m = tee.exec(command)) !== null) {
		for (const arg of m[1].match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []) {
			const t = arg.replace(/^["']|["']$/g, '');
			if (!t || t.startsWith('-')) continue;
			if (/^(\/dev\/null|nul|\$null)$/i.test(t)) continue;
			out.push(t);
		}
	}
	return out;
}

/** A write target whose expansion we cannot resolve ($VAR, backticks, ~) is AMBIGUOUS —
 *  fail closed (requirement (a): deny on unresolvable/ambiguous paths). */
function isAmbiguousBashTarget(target: string): boolean {
	return /[$`]/.test(target) || target.startsWith('~');
}

/** Scope-check ONE write target. Returns a deny decision, or undefined when in scope. */
function checkScopeTarget(
	target: string,
	context: GateContext,
	scope: EditScope,
	label: string
): GateDecision | undefined {
	const abs = resolve(context.projectRoot, target);
	const canon = canonicalForScope(abs); // throws ⇒ caught by evaluateEditScope ⇒ deny
	const cmp = casefoldPath(canon);
	for (const r of scope.scopeRoots) {
		const rootCanon = canonicalScopeRoot(resolve(context.projectRoot, r));
		if (isUnderPath(cmp, casefoldPath(rootCanon))) return undefined;
	}
	const posix = canon.replace(/\\/g, '/');
	if (scope.scopeAllow.some((a) => a.re.test(posix))) return undefined;
	return {
		decision: 'deny',
		gate: 'edit-scope',
		reason:
			`${label} outside the declared edit scope (D-018 scope-lock): ${canon} ` +
			`is under none of [${scope.scopeRoots.join(', ')}] and matches no scopeAllow exception`
	};
}

/**
 * The edit-scope family evaluator. Returns undefined when no editScope is declared
 * (feature off — requirement (c)) or everything is in scope; otherwise a deny carrying
 * WHICH check fired (out-of-scope write / ambiguous redirection / destructive pattern id).
 * ANY internal resolution error fails CLOSED as an edit-scope deny.
 */
function evaluateEditScope(
	call: ToolCall,
	filePath: string | undefined,
	command: string | undefined,
	context: GateContext
): GateDecision | undefined {
	const scope = context.editScope;
	if (!scope) return undefined;
	try {
		if (command !== undefined) {
			const norm = normalizeBashCommand(command);
			// (b) destructive-bash deny-list, unless the WHOLE command matches a configured
			// safe exception (gstack careful's safe-target shape, reimplemented fail-closed).
			if (!scope.destructiveAllow.some((a) => a.re.test(norm))) {
				const hit = scope.destructiveDeny.find((d) => d.re.test(norm));
				if (hit) {
					return {
						decision: 'deny',
						gate: 'edit-scope',
						reason:
							`destructive command blocked by configured pattern '${hit.id}'` +
							`${hit.reason ? ` (${hit.reason})` : ''}: ${command}`
					};
				}
			}
			// (a) detectable file-writing bash redirections must stay in scope.
			for (const target of bashWriteTargets(command)) {
				if (isAmbiguousBashTarget(target)) {
					return {
						decision: 'deny',
						gate: 'edit-scope',
						reason: `ambiguous bash write target (unresolvable expansion) — failing closed (D-024): ${target}`
					};
				}
				const denied = checkScopeTarget(target, context, scope, 'bash write redirection');
				if (denied) return denied;
			}
		}
		// (a) file-WRITING tools must stay in scope (Read deliberately ungated here).
		if (filePath !== undefined && WRITE_TOOLS.has(call.name)) {
			const denied = checkScopeTarget(filePath, context, scope, `${call.name} target`);
			if (denied) return denied;
		}
		return undefined;
	} catch (err) {
		// Unresolvable/broken-symlink/internal error ⇒ DENY under THIS family's name.
		return {
			decision: 'deny',
			gate: 'edit-scope',
			reason: `edit-scope could not resolve the target — failing closed (D-024): ${(err as Error).message}`
		};
	}
}

// ── fetch-allowlist (WORKFORCE-SPEC §7b.4 fix): the WEB-FETCH allowlist gate ──────────
//
// The researcher interview substrate (workforce/stub-web.ts) serves a LOOPBACK stub-web
// and the candidate's WebFetch is supposed to be ALLOWLISTED to that origin ONLY (§7b.4 —
// the live internet must be unreachable so the interview is deterministic). The helper
// `assertFetchAllowed` existed but had NO production caller — nothing constrained the
// built-in WebFetch URL, so a candidate could fetch the live internet unimpeded (the
// reviewed defect). THIS gate is the missing enforcement seam: it rides the SAME single
// evaluator the SDK canUseTool and the CLI PreToolUse hook both consult, so the allowlist
// is enforced on BOTH paths (and the determinism/safety property is real, not asserted).
//
// FAIL CLOSED (D-024, safety-critical — never downgradable): when an allowlist is armed,
//   • WebFetch — its `url` input must parse AND its origin must EXACTLY equal the allowed
//     origin; any other origin (the live internet, a credentialed user:pw@…, a different
//     loopback port) or an unparseable url is DENIED;
//   • WebSearch — has no URL to scope and inherently reaches the open web, so it is DENIED
//     whenever an allowlist is armed (a researcher interview reads the served stub, never
//     searches the live web).
// The check is the SAME origin-equality semantics as workforce/stub-web.assertFetchAllowed
// (kept local here so the low-level claude-code gate layer never back-imports workforce).

/** Thrown on a malformed fetchAllowlist config — callers FAIL CLOSED. */
export class FetchAllowlistError extends Error {
	override readonly name = 'FetchAllowlistError';
}

/** The RAW (JSON-serializable) fetch allowlist a session declares — validated by
 *  parseFetchAllowlist. `allowedOrigin` is the ONLY origin WebFetch may target. */
export interface FetchAllowlistInput {
	/** The single permitted fetch origin (e.g. the loopback stub-web `http://127.0.0.1:<port>`). */
	allowedOrigin: string;
}

/** The COMPILED fetch allowlist the evaluator consumes (origin normalized at parse time). */
export interface FetchAllowlist {
	allowedOrigin: string;
}

/** Tools whose call reaches the WEB — gated by the fetch-allowlist when armed. */
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);

/**
 * STRICT fetchAllowlist parser (D-024): `undefined`/`null` ⇒ no fetch gating (opt-in,
 * returns undefined). A non-object, a missing/empty allowedOrigin, or an allowedOrigin that
 * is not a parseable URL whose own origin round-trips THROWS {@link FetchAllowlistError};
 * callers MUST treat that as a hard block (fail the spawn / deny the tool), never run
 * un-gated. The stored origin is the URL-normalized origin so the equality compare is exact.
 */
export function parseFetchAllowlist(raw: unknown): FetchAllowlist | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new FetchAllowlistError('fetchAllowlist must be an object — failing closed (D-024)');
	}
	const o = raw as Record<string, unknown>;
	if (typeof o.allowedOrigin !== 'string' || !o.allowedOrigin.trim()) {
		throw new FetchAllowlistError(
			'fetchAllowlist.allowedOrigin must be a non-empty string — failing closed (D-024)'
		);
	}
	let origin: string;
	try {
		origin = new URL(o.allowedOrigin).origin;
	} catch {
		throw new FetchAllowlistError(
			`fetchAllowlist.allowedOrigin ${JSON.stringify(o.allowedOrigin)} is not a parseable URL — failing closed (D-024)`
		);
	}
	// A URL with an opaque origin (e.g. file:, data:) round-trips to the literal "null" — that
	// can never equal a real loopback origin and is never a valid stub target; refuse it.
	if (origin === 'null') {
		throw new FetchAllowlistError(
			`fetchAllowlist.allowedOrigin ${JSON.stringify(o.allowedOrigin)} has no real origin — failing closed (D-024)`
		);
	}
	return { allowedOrigin: origin };
}

/** Pull the fetch URL off a WebFetch tool input (untrusted). undefined when absent/non-string. */
function fetchUrlOf(call: ToolCall): string | undefined {
	const input = call.input as Record<string, unknown> | null | undefined;
	const u = input?.url;
	return typeof u === 'string' ? u : undefined;
}

/**
 * The fetch-allowlist family evaluator. Returns undefined when no allowlist is armed (feature
 * off) or the call is not a web tool; otherwise an allow/deny for a web tool. FAIL CLOSED:
 * WebSearch always denies (reaches the open web); WebFetch denies unless its url origin
 * EXACTLY equals the allowed origin; an unparseable/absent url denies.
 */
function evaluateFetchAllowlist(call: ToolCall, context: GateContext): GateDecision | undefined {
	const allow = context.fetchAllowlist;
	if (!allow) return undefined;
	if (!WEB_TOOLS.has(call.name)) return undefined;
	if (call.name === 'WebSearch') {
		return {
			decision: 'deny',
			gate: 'fetch-allowlist',
			reason:
				`WebSearch reaches the open web and cannot be allowlisted to a single origin — ` +
				`DENIED (WORKFORCE-SPEC §7b.4 fail closed): the interview reads the served stub-web ` +
				`(${allow.allowedOrigin}) only`
		};
	}
	// WebFetch — its url origin must EXACTLY equal the allowed origin.
	const url = fetchUrlOf(call);
	if (url === undefined) {
		return {
			decision: 'deny',
			gate: 'fetch-allowlist',
			reason: 'WebFetch call has no resolvable url — failing closed (D-024)'
		};
	}
	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch {
		return {
			decision: 'deny',
			gate: 'fetch-allowlist',
			reason: `WebFetch url is unparseable — failing closed (D-024): ${url}`
		};
	}
	if (origin !== allow.allowedOrigin) {
		return {
			decision: 'deny',
			gate: 'fetch-allowlist',
			reason:
				`WebFetch to ${origin} is REFUSED — a researcher interview fetch is allowlisted to the ` +
				`loopback stub-web (${allow.allowedOrigin}) ONLY; the live internet is not reachable in ` +
				`the gauntlet (WORKFORCE-SPEC §7b.4, fail closed)`
		};
	}
	return undefined; // in-allowlist WebFetch — allowed by this gate
}

// ── path extraction (untrusted input → candidate fs targets) ─────────────────────────

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Pull the file_path off a file-tool input. Returns undefined if the tool isn't a file tool. */
function filePathOf(call: ToolCall): string | undefined {
	if (!FILE_TOOLS.has(call.name)) return undefined;
	const input = call.input as Record<string, unknown> | null | undefined;
	const p = input?.file_path ?? input?.path ?? input?.notebook_path;
	return typeof p === 'string' ? p : undefined;
}

/** The bash command string, or undefined if not a Bash call. */
function commandOf(call: ToolCall): string | undefined {
	if (call.name !== 'Bash') return undefined;
	const input = call.input as Record<string, unknown> | null | undefined;
	const c = input?.command;
	return typeof c === 'string' ? c : undefined;
}

/**
 * Extract candidate filesystem path TOKENS from a bash command for path-confinement.
 * Conservative: any token that looks like a path (contains `/` or `\`, or starts with
 * `.`/`~`, or is an absolute Windows drive path). We confine these — non-path tokens
 * (flags, subcommands) are ignored. Best-effort detection layered ON TOP of
 * permissions.deny + the cwd scope; not a parser, by design (D-018: defense-in-depth).
 */
function bashPathTokens(command: string): string[] {
	const tokens = command.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) ?? [];
	const out: string[] = [];
	for (const raw of tokens) {
		const t = raw.replace(/^["']|["']$/g, '');
		if (!t || t.startsWith('-')) continue; // skip flags
		const looksPath =
			t.includes('/') ||
			t.includes('\\') ||
			t.startsWith('.') ||
			t.startsWith('~') ||
			/^[a-zA-Z]:[\\/]/.test(t);
		if (looksPath) out.push(t);
	}
	return out;
}

// ── the pure evaluator ────────────────────────────────────────────────────────────

function modeFor(gate: GateName, policy?: GatePolicy): GateMode {
	// Safety-critical gates can NEVER be downgraded (D-024) — always deny.
	if (SAFETY_CRITICAL.has(gate)) return 'deny';
	return policy?.[gate] ?? DEFAULT_GATE_POLICY[gate];
}

function block(gate: GateName, reason: string, policy?: GatePolicy): GateDecision {
	return { decision: modeFor(gate, policy), gate, reason };
}

const ALLOW: GateDecision = { decision: 'allow' };

/**
 * Evaluate ONE pending tool call against all four gate families, in safety order. Pure
 * and SYNCHRONOUS. FAILS CLOSED (D-024): any thrown error → deny. Records a successful
 * Read into the session read-set (so a later Edit satisfies read-before-edit).
 */
export function evaluateGate(call: ToolCall, context: GateContext): GateDecision {
	try {
		return evaluateGateInner(call, context);
	} catch (err) {
		// Defensive: an evaluator bug or a booby-trapped input must NOT open the gate.
		return {
			decision: 'deny',
			gate: 'path-confinement',
			reason: `gate evaluator failed — failing closed (D-024): ${(err as Error).message}`
		};
	}
}

function evaluateGateInner(call: ToolCall, context: GateContext): GateDecision {
	const policy = context.policy;
	const root = context.projectRoot;

	const filePath = filePathOf(call);
	const command = commandOf(call);

	// Fail closed on a file tool with NO extractable target — a malformed Read/Edit/Write
	// must not slip through to allow (D-024). (Bash with no command string is likewise
	// caught: commandOf returns undefined and no gate touches it → but a Bash call with a
	// non-string command is the same malformed case.)
	if (FILE_TOOLS.has(call.name) && filePath === undefined) {
		return {
			decision: 'deny',
			gate: 'path-confinement',
			reason: `${call.name} call has no resolvable file_path — failing closed (D-024)`
		};
	}
	if (call.name === 'Bash' && command === undefined) {
		return {
			decision: 'deny',
			gate: 'dangerous-bash',
			reason: 'Bash call has no command string — failing closed (D-024)'
		};
	}

	// 0) fetch-allowlist (§7b.4) — web tools (WebFetch/WebSearch) are gated to the armed
	//    allowlist (the loopback stub-web) BEFORE the fs/bash families: a web tool has no
	//    file_path/command, so the fs families pass it through; this is the only gate that
	//    speaks to it. Fail-closed when armed; no-op when absent (non-web sessions unchanged).
	const fetched = evaluateFetchAllowlist(call, context);
	if (fetched) return fetched;

	// 1) config-protection — applies BEFORE confinement (a protected .env may legitimately
	//    sit under the root, yet must still be denied). Checks the post-normalization path.
	if (filePath !== undefined) {
		const abs = resolve(root, filePath).replace(/\\/g, '/');
		if (isProtectedConfigPath(abs)) {
			return block('config-protection', `protected config/secret path: ${abs}`, policy);
		}
	}
	if (command !== undefined) {
		for (const tok of bashPathTokens(command)) {
			const abs = resolve(root, tok).replace(/\\/g, '/');
			if (isProtectedConfigPath(abs)) {
				return block('config-protection', `bash touches protected path: ${abs}`, policy);
			}
		}
	}

	// 2) dangerous-bash — rm -rf / git push / git remote set-url / --force / reset --hard.
	//    Evaluated BEFORE path-confinement so the MORE SPECIFIC gate claims the deny: a
	//    command like `rm -rf /` would otherwise be caught by confinement on the `/` token.
	//    Both gates are safety-critical (deny either way) — this only sharpens the label.
	//    TASK 15.1: when the session's editScope carries a FULL-COMMAND safe exception
	//    (destructiveBash.allow, e.g. `rm -rf node_modules`) matching the whole command,
	//    the recursive-rm rule — and ONLY that rule — is bypassed so the configured
	//    build-artifact cleanup passes silently. Sessions without an editScope keep
	//    today's exact behaviour (no exception path exists).
	if (command !== undefined) {
		const safeRmException =
			context.editScope !== undefined &&
			context.editScope.destructiveAllow.some((a) => a.re.test(normalizeBashCommand(command)));
		if (isDangerousBash(command, safeRmException)) {
			return block('dangerous-bash', `dangerous command blocked: ${command}`, policy);
		}
	}

	// 2b) edit-scope (TASK 15.1 / B1) — the scope-lock: out-of-scope writes, detectable
	//     write redirections, and the config-driven destructive-bash list. Before
	//     path-confinement so the more specific gate claims the deny (both fail closed).
	const scoped = evaluateEditScope(call, filePath, command, context);
	if (scoped) return scoped;

	// 3) path-confinement — symlink + ".." resolved FIRST, fail closed. Reuses 1.4a's
	//    resolver, the single source of truth shared with the primary boundary.
	if (filePath !== undefined) {
		const confined = confine(filePath, root);
		if (confined) return confined;
	}
	if (command !== undefined) {
		for (const tok of bashPathTokens(command)) {
			const confined = confine(tok, root);
			if (confined) return confined;
		}
	}

	// 4) read-before-edit — block Edit on a file not Read this session. Write (create) is
	//    exempt. Record a passing Read into the read-set.
	if (filePath !== undefined) {
		const norm = resolve(root, filePath);
		if (call.name === 'Edit' || call.name === 'MultiEdit' || call.name === 'NotebookEdit') {
			if (!context.session.readPaths.has(norm)) {
				return block('read-before-edit', `Edit before Read this session: ${norm}`, policy);
			}
		}
		if (call.name === 'Read') {
			context.session.readPaths.add(norm);
		}
	}

	return ALLOW;
}

/** Run a single target through 1.4a's confinement resolver; deny on escape/unresolvable. */
function confine(target: string, root: string): GateDecision | undefined {
	try {
		resolveConfinedTarget(target, root);
		return undefined; // confined — allowed by this gate
	} catch (err) {
		if (err instanceof PathConfinementError) {
			return { decision: 'deny', gate: 'path-confinement', reason: err.message };
		}
		// Any other resolver error also fails closed (D-024).
		return {
			decision: 'deny',
			gate: 'path-confinement',
			reason: `path could not be confined — failing closed: ${(err as Error).message}`
		};
	}
}

// ── SDK path: the canUseTool callback ────────────────────────────────────────────────
//
// The Claude Agent SDK calls `canUseTool(toolName, input)` and expects a permission
// result: { behavior: 'allow', updatedInput } | { behavior: 'deny', message }. We map a
// gate `warn` to allow (the call proceeds) while still surfacing the reason; a deny maps
// to behavior:'deny'. Defense-in-depth on top of permissions.deny (the SDK never relies
// on this alone — D-024).

export interface CanUseToolAllow {
	behavior: 'allow';
	updatedInput: Record<string, unknown>;
	/** Set when a non-blocking gate warned (still allowed). */
	warning?: string;
}
export interface CanUseToolDeny {
	behavior: 'deny';
	message: string;
}
export type CanUseToolResult = CanUseToolAllow | CanUseToolDeny;

export function gateCanUseTool(
	context: GateContext
): (toolName: string, input: Record<string, unknown>) => Promise<CanUseToolResult> {
	return async (toolName, input) => {
		const res = evaluateGate({ name: toolName, input }, context);
		if (res.decision === 'deny') {
			return {
				behavior: 'deny',
				message: `[gate:${res.gate}] ${res.reason ?? 'blocked'}`
			};
		}
		return {
			behavior: 'allow',
			updatedInput: input,
			...(res.decision === 'warn'
				? { warning: `[gate:${res.gate}] ${res.reason ?? 'warning'}` }
				: {})
		};
	};
}

// ── CLI path: the PreToolUse hook ────────────────────────────────────────────────────
//
// The CLI runs gates via the PreToolUse hook, which returns the documented JSON shape
// with hookSpecificOutput.permissionDecision = 'allow' | 'deny' | 'ask'. A gate `warn`
// maps to 'allow' (with a reason). A malformed payload fails CLOSED → deny.

export interface PreToolUsePayload {
	tool_name: string;
	tool_input: Record<string, unknown>;
}
export interface PreToolUseOutput {
	hookSpecificOutput: {
		hookEventName: 'PreToolUse';
		permissionDecision: 'allow' | 'deny' | 'ask';
		permissionDecisionReason?: string;
	};
}

export function gatePreToolUse(
	context: GateContext
): (payload: PreToolUsePayload) => PreToolUseOutput {
	return (payload) => {
		// Fail closed on a malformed external payload (D-024).
		if (!payload || typeof payload !== 'object' || typeof payload.tool_name !== 'string') {
			return {
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'deny',
					permissionDecisionReason: 'malformed PreToolUse payload — failing closed (D-024)'
				}
			};
		}
		const res = evaluateGate(
			{ name: payload.tool_name, input: payload.tool_input },
			context
		);
		const decision = res.decision === 'deny' ? 'deny' : 'allow';
		return {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: decision,
				permissionDecisionReason: res.gate
					? `[gate:${res.gate}] ${res.reason ?? ''}`
					: undefined
			}
		};
	};
}
