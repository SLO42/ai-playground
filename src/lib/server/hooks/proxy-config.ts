// server/hooks — hook transport config + payload normalization (TASK 1.9; D-019/D-024).
//
// Claude Code hooks fire as short-lived processes; our state lives in the long-lived
// SvelteKit server. The bridge (D-019) is a tiny hook-proxy script that each hook
// invokes, which POSTs the payload to the local server over loopback with a SHORT
// per-hook timeout and NO-OPS on any failure (server down → the session proceeds).
//
// This module is the PURE config layer: the wired event set, the per-hook timeout
// budgets, the settings.json hook-map generator, and the payload → agent_event
// normalizer. It depends on nothing and is fully unit-testable.
//
// CRITICAL (D-024): this path is ANALYTICS-ONLY. The wired events are
// SessionStart/UserPromptSubmit/PostToolUse/Stop — observation hooks. NO
// safety-critical gate (PreToolUse / canUseTool) is ever wired here, because this
// transport NO-OPS when the server is down and a safety gate must NEVER fail open
// (safety = permissions.deny [1.4a, primary] + canUseTool/PreToolUse [2.13]).

/** The Claude Code lifecycle events we capture for analytics (D-019, analytics-only). */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

const HOOK_EVENT_SET = new Set<string>(HOOK_EVENTS);

/** Narrow an arbitrary string to a wired HookEvent. Safety hooks return false. */
export function isHookEvent(s: string): s is HookEvent {
	return HOOK_EVENT_SET.has(s);
}

/**
 * Per-hook timeout budget in milliseconds (D-019). SessionStart gets the most
 * (it may inject a briefing), UserPromptSubmit less, the high-frequency tool/stop
 * hooks the least. The proxy aborts its POST at this budget; on timeout it no-ops.
 */
export function hookTimeoutMs(event: HookEvent): number {
	switch (event) {
		case 'SessionStart':
			return 30_000;
		case 'UserPromptSubmit':
			return 15_000;
		case 'PostToolUse':
		case 'Stop':
			return 10_000;
	}
}

// ── settings.json hook map (what Claude Code runs) ───────────────────────────────

/** One command-hook entry as Claude Code's settings.json expects it. */
export interface HookCommandEntry {
	type: 'command';
	command: string;
	/** Seconds — Claude Code kills a hook that exceeds this (belt to the proxy's own abort). */
	timeout: number;
}

/** A matcher group: Claude Code runs every hook whose matcher applies. */
export interface HookGroup {
	hooks: HookCommandEntry[];
}

/** The `hooks` section of a Claude Code settings.json (only our wired events). */
export type HookSettings = Record<HookEvent, HookGroup[]>;

export interface BuildHookSettingsOptions {
	/** The base command that runs the proxy, e.g. `node /abs/scripts/hook-proxy.mjs`. */
	proxyCommand: string;
	/** Loopback base url of the SvelteKit server (informational; the proxy reads env). */
	baseUrl: string;
	/** The per-boot D-025 token — injected into the proxy's ENV, never the command string. */
	token: string;
}

/**
 * Generate the settings.json `hooks` map for the isolated harness config (D-002).
 * Each wired event gets a command-hook that invokes the proxy with the event name
 * as an argument; the per-hook timeout is carried so Claude Code reaps a hung proxy.
 *
 * D-025: the token is NOT embedded in the command string (it would be readable off
 * disk). It is injected into the spawned session's ENV by the runtime alongside
 * HOOK_URL; the proxy reads both from its environment. `token`/`baseUrl` are accepted
 * here so the caller can keep the env injection in one place, but only the command
 * shape is emitted into settings.json.
 */
export function buildHookSettings(opts: BuildHookSettingsOptions): HookSettings {
	const out = {} as HookSettings;
	for (const event of HOOK_EVENTS) {
		out[event] = [
			{
				hooks: [
					{
						type: 'command',
						// event name as an arg → the proxy knows which event/timeout to use.
						command: `${opts.proxyCommand} ${event}`,
						timeout: Math.ceil(hookTimeoutMs(event) / 1000)
					}
				]
			}
		];
	}
	return out;
}

// ── payload → agent_event normalization (analytics row) ──────────────────────────

/** A normalized analytics row destined for the `agent_event` table (DATA-MODEL §4.4). */
export interface HookAgentEvent {
	/** Always 'hook' — distinguishes lifecycle-capture rows from spawn/completion/etc. */
	type: 'hook';
	/** Structured, bounded detail — never the raw untrusted payload verbatim (D-026). */
	detail: {
		hook_event: HookEvent;
		cc_session_id?: string;
		tool_name?: string;
		cwd?: string;
	};
}

/** Best-effort string field extraction from an untrusted payload (never throws). */
function str(payload: unknown, key: string): string | undefined {
	if (payload && typeof payload === 'object' && key in (payload as Record<string, unknown>)) {
		const v = (payload as Record<string, unknown>)[key];
		if (typeof v === 'string' && v.length > 0) return v.slice(0, 512);
	}
	return undefined;
}

/**
 * Normalize a raw Claude Code hook payload into a bounded analytics row. Returns
 * null for any non-wired (e.g. safety) event so the caller no-ops — this is the
 * second guard that NO safety event is ever processed on the analytics path (D-024).
 *
 * The raw payload is treated as DATA (D-026): we extract only known, length-capped
 * fields; we never store the verbatim blob and never let it steer behavior.
 */
export function normalizeHookEvent(event: HookEvent, payload: unknown): HookAgentEvent | null {
	if (!isHookEvent(event)) return null;
	return {
		type: 'hook',
		detail: {
			hook_event: event,
			cc_session_id: str(payload, 'session_id'),
			tool_name: str(payload, 'tool_name'),
			cwd: str(payload, 'cwd')
		}
	};
}
