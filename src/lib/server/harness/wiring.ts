// server/harness/wiring — the UI-action wiring seam for PRODUCT §4 jobs 8/9/10 (TASK 6.7).
//
// The dashboard's write surfaces (launch a session, interject/stop/resume, run a workflow,
// run a release) all need the SAME three things assembled once per boot:
//   • the AgentRuntime  — drives Claude Code (the real CLI backend when credentialed)
//   • the events bus    — the ONE bus the SSE fan-out reads (§2.11), so every action's
//                         effect renders LIVE; we NEVER open a second source
//   • the per-boot token — the D-025 control-plane token, minted in hooks.server.ts and
//                         surfaced as HOOK_TOKEN; the channel seam compares it to decide
//                         operator-origin steering (D-035a). It is NEVER handed to the
//                         runtime — only to the channel seam's `bootToken`.
//
// HONEST AVAILABILITY (F-008 / PRODUCT "honest reporting"): a real Claude Code run needs
// CLAUDE_CODE_OAUTH_TOKEN. When it is absent this wave, `getRuntime()` returns
// { available:false } and the action surfaces an honest "Claude Code credential not
// configured" error rather than spawning a fake/mock run dressed as real. The backend
// LOGIC is the proven mock-tested path; only the credential gates the live spawn.
//
// This module is server-only (imports node child_process via the CLI backend). It is the
// single place the runtime is constructed for UI actions — keeping the construction out of
// every route loader.

import { getEventBus, type EventBus } from '../events';
import {
	ClaudeCodeRuntime,
	type ModelSelection,
	type SpawnBudgets,
	type ToolPolicy,
	type Intent
} from '../runtime/index';
import { ClaudeCliBackend } from '../claude-code/cli-backend';

/** The events bus the SSE fan-out reads — the SOLE source (§2.11). */
export function getBus(): EventBus {
	return getEventBus();
}

/**
 * The D-025 per-boot control-plane token (minted in hooks.server.ts → HOOK_TOKEN). Used
 * ONLY as the channel seam's `bootToken` to authenticate operator-origin steering (D-035a).
 * Returns undefined if the boot gate has not run (e.g. a unit context) — the channel then
 * treats every push as a non-operator agent push (fail-closed).
 */
export function getBootToken(): string {
	return process.env.HOOK_TOKEN?.trim() ?? '';
}

/** The runtime, or an honest reason it is unavailable. The concrete ClaudeCodeRuntime is
 *  returned so the channel seam (interject/resume/stop) — which needs the class, not just
 *  the AgentRuntime interface — can use it directly. */
export type RuntimeAvailability =
	| { available: true; runtime: ClaudeCodeRuntime }
	| { available: false; reason: string };

let cachedRuntime: ClaudeCodeRuntime | null = null;

/**
 * Assemble the Claude Code runtime for UI actions. Real CLI backend when
 * CLAUDE_CODE_OAUTH_TOKEN is present (the credentialed live path); otherwise honestly
 * unavailable (no fake run, F-008). Constructed once and cached for the process.
 *
 * The runtime is built with the harness-only isolated config (D-002) — gates/hooks ride
 * the per-session --settings the backend writes; no operator plugins are inherited.
 */
export function getRuntime(): RuntimeAvailability {
	if (cachedRuntime) return { available: true, runtime: cachedRuntime };

	const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	if (!oauthToken) {
		return {
			available: false,
			reason:
				'Claude Code credential not configured (set CLAUDE_CODE_OAUTH_TOKEN). Backend is verified; live spawn is gated on the credential.'
		};
	}

	const backend = new ClaudeCliBackend({ oauthToken });
	cachedRuntime = new ClaudeCodeRuntime({
		backend,
		harnessConfigRoot: process.env.HARNESS_CONFIG_ROOT?.trim() || '.harness/claude-config'
	});
	return { available: true, runtime: cachedRuntime };
}

// ── Sensible defaults the UI actions seed a manual run with ──────────────────────────────
//
// A manual operator-initiated run picks the most-capable tier by default (the operator can
// route differently once 5.x routing UI lands; explicit-override is honored upstream). These
// are the same shapes the launch/runner tests exercise — kept here so every action seeds a
// consistent, valid SpawnRequest.

/** Default model for a manually-launched session (operator picks the powerful tier). */
export const DEFAULT_MODEL: ModelSelection = {
	provider: 'claude',
	modelId: 'claude-opus-4-8',
	tier: 'opus'
};

/** Default agent slot a manual launch runs as. */
export const DEFAULT_AGENT = 'opus-1';

/** Default spawn budgets for a manual run. */
export const DEFAULT_BUDGETS: SpawnBudgets = { thinking: 'high', toolCalls: 20, concurrency: 1 };

/** Default tool policy for a manual run — read/edit/bash, the common code-work surface. */
export const DEFAULT_TOOL_POLICY: ToolPolicy = { allow: ['Read', 'Edit', 'Bash'] };

/** Default intent for a manually-launched session. */
export const DEFAULT_INTENT: Intent = 'code-write';
