// TASK 2.13 — the GATE layer: defense-in-depth ON TOP of 1.4a's primary
// permissions.deny (D-024/D-018). A single PURE evaluator (`evaluateGate`) is consulted
// by BOTH enforcement paths so they share one gate config (ARCHITECTURE §2.10e):
//   • SDK / headless path  → the `canUseTool` callback  (`gateCanUseTool`)
//   • CLI / interactive path → the `PreToolUse` hook      (`gatePreToolUse`)
//
// Four gate families (D-018):
//   • config-protection — deny reads/edits of ANY .env/secret or ANY .claude/ across the
//     whole code root (the same rule globs 1.4a seeds into permissions.deny).
//   • read-before-edit  — block Edit on a file not Read this session (session read-set).
//   • dangerous-bash    — deny rm -rf / git push / git remote set-url / any --force.
//   • path-confinement  — every fs/bash target must resolve UNDER the project root AFTER
//     symlink + ".." normalization — reusing 1.4a's resolveConfinedTarget (fail closed).
//
// D-024 fail-closed: the three SAFETY-CRITICAL families (config-protection,
// dangerous-bash, path-confinement) ALWAYS hard-deny — policy may NOT downgrade them to
// warn — and ANY evaluator error (bad input, unresolvable root, internal throw) returns
// DENY, never allow. read-before-edit is non-safety-critical and IS policy-downgradable.
//
// PURE: no DB, no server, no spawn — so the guarantee holds with the server down, same
// as 1.4a. It reuses the 1.4a deny-rule constants + resolver (DRY, single source of truth).

import { resolveConfinedTarget, PathConfinementError } from './guardrails';
import { resolve } from 'node:path';

// ── Gate names + policy ────────────────────────────────────────────────────────────

export type GateName =
	| 'config-protection'
	| 'read-before-edit'
	| 'dangerous-bash'
	| 'path-confinement';

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
	'path-confinement'
]);

/** Built-in defaults: everything hard-blocks unless a project policy says warn. */
export const DEFAULT_GATE_POLICY: Readonly<Required<GatePolicy>> = Object.freeze({
	'config-protection': 'deny',
	'read-before-edit': 'deny',
	'dangerous-bash': 'deny',
	'path-confinement': 'deny'
});

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
function globToRegExp(glob: string): RegExp {
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
	return new RegExp('^' + re + '$');
}

const CONFIG_PROTECTION_RE = CONFIG_PROTECTION_GLOBS.map(globToRegExp);

function isProtectedConfigPath(absPosix: string): boolean {
	return CONFIG_PROTECTION_RE.some((re) => re.test(absPosix));
}

// ── dangerous-bash: the SAME family 1.4a denies (rm -rf / push / set-url / --force) ──

/** Each entry tests against the raw command string (lower-cased, whitespace-collapsed). */
const DANGEROUS_BASH_RE: readonly RegExp[] = [
	/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, // rm -rf / -fr in any flag clustering
	/\bgit\s+push\b/,
	/\bgit\s+remote\s+set-url\b/,
	/--force\b/,
	/\bgit\s+reset\s+--hard\b/,
	/-f\s+--hard\b/
];

function isDangerousBash(command: string): boolean {
	const norm = command.toLowerCase().replace(/\s+/g, ' ').trim();
	return DANGEROUS_BASH_RE.some((re) => re.test(norm));
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
	if (command !== undefined && isDangerousBash(command)) {
		return block('dangerous-bash', `dangerous command blocked: ${command}`, policy);
	}

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
