// server/hooks — public barrel (TASK 1.9; D-019).
//
// The D-019 hook transport: a thin proxy POSTs Claude Code lifecycle hooks to the
// long-lived server over loopback (D-025 token, short timeout) and NO-OPS on failure.
// ANALYTICS-ONLY (D-024) — no safety decision is ever wired through this best-effort
// path (safety = permissions.deny [1.4a] + canUseTool/PreToolUse [2.13]).

export {
	HOOK_EVENTS,
	isHookEvent,
	hookTimeoutMs,
	buildHookSettings,
	normalizeHookEvent,
	type HookEvent,
	type HookSettings,
	type HookCommandEntry,
	type HookGroup,
	type HookAgentEvent,
	type BuildHookSettingsOptions
} from './proxy-config';

export { postHook, type HookProxyEnv, type PostHookOptions } from './proxy';

export {
	authorizeHookRequest,
	ingestHookEvent,
	type AuthResult,
	type HookIngestEnv,
	type HookIngestDeps
} from './ingest';
