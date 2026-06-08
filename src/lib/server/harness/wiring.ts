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
	type Intent,
	type CapabilityCatalog,
	type CapabilitySet
} from '../runtime/index';
import { OllamaProvider, type ProviderHealth } from '../providers/index';
import { ClaudeCliBackend } from '../claude-code/cli-backend';
import { catalogIds } from '../cc-config/index';
import { DEFAULT_GATE_POLICY } from '../claude-code/gates';
import { loadOrchestration, resolveAdaptiveConfig, type IntentClass } from '../config/index';
import type { Db } from '../db/client';

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
 * Read the LIVE cc-config catalog id-set (the D-036 allow-list, cc-config/sync.catalogIds)
 * from the runtime DB. This is the source of truth `composeCapabilities` validates each
 * spawn's per-task capability set against (fail closed on an unknown id). LIVE DB ONLY
 * (F-008) — never hard-coded. Returns undefined if the read fails, so the runtime still
 * builds (capability provisioning OFF rather than blocking the whole spawn path).
 */
async function resolveCatalog(db: Db): Promise<CapabilityCatalog | undefined> {
	try {
		const ids = await catalogIds(db);
		return { skills: ids.skills, agents: ids.agents, mcp: ids.mcp };
	} catch (err) {
		console.warn(
			'[harness] cc-config catalog read failed — spawning with capability provisioning OFF (harness base only):',
			(err as Error).message
		);
		return undefined;
	}
}

/**
 * Assemble the Claude Code runtime for UI actions. Real CLI backend when
 * CLAUDE_CODE_OAUTH_TOKEN is present (the credentialed live path); otherwise honestly
 * unavailable (no fake run, F-008). Constructed once and cached for the process.
 *
 * The runtime is built with the harness-only isolated config (D-002): the harness's OWN
 * gates (DEFAULT_GATE_POLICY, D-018) ride the per-session --settings, and the LIVE
 * cc-config catalog (D-036 / TASK 5.1) is wired in so `composeCapabilities` actually RUNS
 * on every spawn — validating the task's `req.capabilities` against the real catalog and
 * composing harness-base ⊕ the (catalog-validated) set into the isolated config. Without
 * the catalog this was a DEAD BRANCH (composeCapabilities never ran); passing it here is
 * the fix. `plugins`/`marketplaces` stay empty regardless (D-002 isolation preserved).
 *
 * The catalog is read once at first credentialed construction (the runtime is a per-boot
 * singleton; a cc-config re-sync takes effect on the next process boot / runtime rebuild).
 */
export async function getRuntime(db?: Db): Promise<RuntimeAvailability> {
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
	// The live catalog is the D-036 allow-list. When a db is supplied, read it so
	// composeCapabilities runs against the REAL catalog (the dead-branch fix). When no db
	// is in hand (e.g. a non-DB caller), capability provisioning stays OFF for that boot.
	const catalog = db ? await resolveCatalog(db) : undefined;
	cachedRuntime = new ClaudeCodeRuntime({
		backend,
		harnessConfigRoot: process.env.HARNESS_CONFIG_ROOT?.trim() || '.harness/claude-config',
		// D-018 harness gates ride every isolated --settings (the gate layer still evaluates
		// each tool call regardless; this seeds the composed settings' gate map).
		gates: { ...DEFAULT_GATE_POLICY },
		catalog
	});
	return { available: true, runtime: cachedRuntime };
}

/**
 * The provider-health source resolveRoute reads to decide fallback (TASK 2.3; §2.5; F-005).
 * Routing READS health here and never probes a provider itself — this is the single owner.
 *
 * HONEST mapping (F-008):
 *   • `claude` — the spawn backend for every claude-tier is the Claude Code CLI (driven by
 *     CLAUDE_CODE_OAUTH_TOKEN), NOT the Anthropic direct-chat API. The orchestrator only
 *     starts once getRuntime() confirmed that credential (boot.ts gate), so `claude` is up
 *     exactly when a live spawn is possible. We report it `up` to reflect the REAL backend
 *     that will run the session — using the direct-chat ClaudeProvider.health() (a separate
 *     ANTHROPIC_API_KEY probe) here would falsely fail every credentialed CLI spawn.
 *   • `ollama` — the local-tier floor: probed LIVE against OLLAMA_HOST (no /v1, D-003). A
 *     real GET /api/tags decides up/down; an unreachable Ollama honestly reports down so a
 *     local-tier route falls back up the ladder.
 */
export async function getProviderHealth(): Promise<ProviderHealth[]> {
	const claudeUp = !!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	const claude: ProviderHealth = {
		provider: 'claude',
		up: claudeUp,
		detail: claudeUp ? undefined : 'Claude Code credential not configured'
	};

	const endpoint = process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
	let ollama: ProviderHealth;
	try {
		ollama = await new OllamaProvider({ endpoint, model: 'gpt-oss:20b' }).health();
	} catch (err) {
		ollama = { provider: 'ollama', up: false, detail: (err as Error).message };
	}
	return [claude, ollama];
}

/**
 * Resolve the per-task capability set (D-036) for an intent from the live orchestration
 * config's intent→bundle map (D-020). The bundle's `capabilities` block is an explicit,
 * allow-listed `{ skills, agents, mcp }` selection; the runtime catalog-validates it at
 * spawn (fail closed). An intent with no configured bundle/capabilities yields undefined
 * (⇒ the harness base only, no extra capabilities). Degrades to undefined if the config
 * is unreadable — never throws into the launch path.
 */
export function resolveCapabilitiesForIntent(intent: Intent): CapabilitySet | undefined {
	try {
		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		const orch = loadOrchestration(`${dir}/orchestration.yaml`);
		const bundle = resolveAdaptiveConfig(orch, intent as IntentClass);
		const caps = bundle.capabilities;
		if (!caps) return undefined;
		// Normalize the optional-array bundle shape → the runtime's required-array CapabilitySet.
		return { skills: caps.skills ?? [], agents: caps.agents ?? [], mcp: caps.mcp ?? [] };
	} catch {
		return undefined;
	}
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
