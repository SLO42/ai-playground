// server/claude-code/gate-transport — the CLI-path gate wiring (TASK 13.3; D-018/D-024;
// ARCHITECTURE §2.10e). Closes the 13.3 finding: the gate layer (gates.ts) existed but was
// NEVER consulted by any production spawn path.
//
// Transport (mirrors the 8.4 hooks-wiring pattern, but FAIL-CLOSED, not best-effort):
//   1. cli-backend.ts merges a `PreToolUse` hook group ({@link buildGateHookGroup}) into the
//      isolated settings.json it writes for every spawn whose config carries gates. The
//      session's gate config (policy + projectRoot) is pinned AT SPAWN TIME and rides the
//      hook command as a base64url arg ({@link encodeGateHookConfig}) — config, not a secret.
//   2. scripts/gate-hook.mjs (the hook command) POSTs { config, payload } to the loopback
//      control plane (HOOK_URL/HOOK_TOKEN from the spawned env, D-025) and prints the
//      server's decision. ANY failure — missing env, non-loopback URL, timeout, server
//      down, garbage response — emits DENY (ROADMAP 2.13: "a gate error or unreachable
//      server denies the action, never allows it").
//   3. /api/gates/pretooluse (routes/api/gates) authorizes (D-025) then calls
//      {@link handleGatePreToolUse}: decode config → parseGatePolicy (STRICT — a malformed
//      gate config DENIES, never silently allows) → per-session read-set → gatePreToolUse.
//
// D-024 layering: this is defense-in-depth ON TOP of 1.4a's permissions.deny (the primary,
// locally-enforced fail-closed boundary). The analytics hook path (hooks/) stays strictly
// separate — it no-ops on failure and must NEVER carry a safety decision; THIS path does
// the opposite and fails closed.

import {
	createGateSession,
	gatePreToolUse,
	parseGatePolicy,
	type GateSession,
	type PreToolUseOutput
} from './gates';
import type { HookGroup } from '../hooks/index';

// ── Per-session gate config (pinned at spawn, carried on the hook command) ───────────

/** The gate config one spawned session's PreToolUse hook carries (pinned at spawn time). */
export interface GateHookConfig {
	/** Raw gate-name → mode record (validated server-side by parseGatePolicy, fail closed). */
	gates: Record<string, string>;
	/** Absolute project root — the confinement boundary the session was spawned into. */
	projectRoot: string;
}

/** Encode the per-session gate config as a base64url JSON arg (shell-safe on Windows). */
export function encodeGateHookConfig(config: GateHookConfig): string {
	return Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
}

/** Decode an encoded gate config. THROWS on any malformed input — callers fail closed. */
export function decodeGateHookConfig(encoded: string): GateHookConfig {
	if (typeof encoded !== 'string' || !encoded) throw new Error('empty gate config');
	const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
	if (!parsed || typeof parsed !== 'object') throw new Error('gate config is not an object');
	const cfg = parsed as Partial<GateHookConfig>;
	if (!cfg.gates || typeof cfg.gates !== 'object' || Array.isArray(cfg.gates)) {
		throw new Error('gate config has no gates record');
	}
	if (typeof cfg.projectRoot !== 'string' || !cfg.projectRoot.trim()) {
		throw new Error('gate config has no projectRoot');
	}
	return { gates: cfg.gates as Record<string, string>, projectRoot: cfg.projectRoot };
}

// ── The settings.json PreToolUse hook group the CLI backend registers ────────────────

export interface BuildGateHookGroupOptions {
	/** The node binary that runs the gate hook (the spawning server's own node). */
	nodeBin: string;
	/** Server root the gate-hook script path resolves under (`<root>/scripts/gate-hook.mjs`). */
	serverRoot: string;
	/** The encoded per-session gate config ({@link encodeGateHookConfig}). */
	encodedConfig: string;
}

/** Hook-side wall-clock budget (seconds) Claude Code allows the gate hook before killing it.
 *  The script's own fetch aborts sooner (8s) and emits DENY — a killed hook also denies
 *  nothing silently: Claude Code treats a PreToolUse JSON absence per its own default, so
 *  the script ALWAYS prints a decision before this ceiling. */
export const GATE_HOOK_TIMEOUT_S = 10;

/**
 * Build the `PreToolUse` hook group (matcher `*` — EVERY tool call is gated) that consults
 * the gate layer over the loopback control plane. Mirrors the 8.4 analytics hook shape
 * (quoted node + script path, Windows-safe), with the session's gate config as the arg.
 */
export function buildGateHookGroup(opts: BuildGateHookGroupOptions): HookGroup {
	const script = `${opts.serverRoot.replace(/[\\/]+$/, '')}/scripts/gate-hook.mjs`;
	return {
		matcher: '*',
		hooks: [
			{
				type: 'command',
				command: `"${opts.nodeBin}" "${script}" ${opts.encodedConfig}`,
				timeout: GATE_HOOK_TIMEOUT_S
			}
		]
	};
}

// ── The server-side handler the /api/gates/pretooluse route consults ─────────────────

/** A fail-closed deny in the documented PreToolUse output shape. */
export function gateDenyOutput(reason: string): PreToolUseOutput {
	return {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason
		}
	};
}

/** Per-cc-session read-sets (read-before-edit state), keyed by the hook payload's
 *  session_id. Bounded: oldest entry evicted past the cap (a session's eviction only
 *  STRICTENS read-before-edit — a lost read-set denies an Edit, never allows one). */
const SESSION_CAP = 512;
const sessions = new Map<string, GateSession>();

function sessionFor(id: string): GateSession {
	const existing = sessions.get(id);
	if (existing) return existing;
	if (sessions.size >= SESSION_CAP) {
		const oldest = sessions.keys().next().value;
		if (oldest !== undefined) sessions.delete(oldest);
	}
	const fresh = createGateSession();
	sessions.set(id, fresh);
	return fresh;
}

/** TEST-ONLY: drop all per-session read-sets (isolation between test cases). */
export function resetGateSessions(): void {
	sessions.clear();
}

/** The body scripts/gate-hook.mjs POSTs: the spawn-pinned config + the raw CC payload. */
export interface GateRequestBody {
	config: string;
	payload: { session_id?: string; tool_name?: string; tool_input?: Record<string, unknown> };
}

/**
 * Evaluate one PreToolUse request against the gate layer. FAILS CLOSED (D-024): a
 * malformed body, an undecodable/unknown/invalid gate config, or ANY internal throw
 * returns DENY — never a silent allow. A missing session_id still evaluates (with a
 * fresh read-set, which can only deny more, never less).
 */
export function handleGatePreToolUse(body: unknown): PreToolUseOutput {
	try {
		if (!body || typeof body !== 'object') {
			return gateDenyOutput('malformed gate request body — failing closed (D-024)');
		}
		const { config, payload } = body as Partial<GateRequestBody>;
		let cfg: GateHookConfig;
		try {
			cfg = decodeGateHookConfig(config as string);
		} catch (err) {
			return gateDenyOutput(
				`undecodable gate config — failing closed (D-024): ${(err as Error).message}`
			);
		}
		// STRICT policy parse — an unknown gate / invalid mode blocks the tool (13.3 finding).
		const policy = parseGatePolicy(cfg.gates);

		const p = (payload ?? {}) as GateRequestBody['payload'];
		const sid = typeof p.session_id === 'string' && p.session_id ? p.session_id : '__no_session__';
		const decide = gatePreToolUse({
			projectRoot: cfg.projectRoot,
			codeRoot: cfg.projectRoot,
			session: sessionFor(sid),
			policy
		});
		// gatePreToolUse itself fails closed on a malformed payload (tool_name not a string).
		return decide({
			tool_name: p.tool_name as string,
			tool_input: (p.tool_input ?? {}) as Record<string, unknown>
		});
	} catch (err) {
		return gateDenyOutput(
			`gate handler failed — failing closed (D-024): ${(err as Error).message}`
		);
	}
}
