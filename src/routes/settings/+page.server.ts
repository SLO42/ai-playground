// TASK 10.3 — /settings: the operator control surface for the running engine (UI-SPEC §220).
//
// Three panels, all LIVE + honest (F-008):
//   1. ORCHESTRATION MODE (D-004) — switch manual | event | periodic (+ triggers / interval),
//      writing config/orchestration.yaml. A SENSITIVE write → D-010 diff + CONFIRM (planMode →
//      applyMode). Because the orchestrator reads `mode` ONCE per boot (boot.ts), the page
//      compares the CONFIGURED mode to the RUNNING orchestrator's mode and says, honestly,
//      whether a restart is needed for the change to take effect.
//   2. ROUTING CONFIG (D-020) — VIEW the tier ladder (agent-pool.yaml) + the intent→config
//      bundles (orchestration.yaml). Read-only here (the bundles are hand-tuned YAML; the
//      ConfigEditor in /claude-code edits Claude Code files — this view is the operator's
//      window onto how routing is currently shaped).
//   3. API KEYS (D-026) — provider credential PRESENCE (set | unset), and a SET form. The
//      server NEVER renders/returns/logs a secret value — strictly the boolean presence. The
//      value is written to .env (gitignored, never committed).
//
// Write semantics (UI-SPEC §221): app settings here follow validate + diff + confirm for the
// orchestration write (sensitive — it changes autonomous behavior), and validate-only for the
// key set (a credential is opaque — there is nothing to diff, only presence to flip).

import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	loadOrchestration,
	loadAgentPool,
	ORCH_MODES,
	DEFAULT_PROVIDERS,
	INTENT_CLASSES,
	planOrchestrationWrite,
	applyOrchestrationWrite,
	OrchestrationStaleConfirmError,
	OrchestrationWriteError,
	describeKeyPresence,
	setEnvKey,
	EnvWriteError,
	type OrchMode,
	type DefaultProvider,
	type Orchestration,
	type AgentPool,
	type KeyPresence
} from '$lib/server/config';
// From the side-effect-free orchestrator registry, NOT from hooks.server — importing
// hooks.server eagerly runs its top-level `bootstrap()` (see the note in hooks.server.ts).
import { activeOrchestrator } from '$lib/server/orchestrator';
import type { Actions, PageServerLoad } from './$types';

/** Resolve the config dir (overridable for tooling/tests; default the repo-root config dir). */
function configDir(): string {
	return process.env.CONFIG_DIR?.trim() || 'config';
}
function orchPath(): string {
	return `${configDir()}/orchestration.yaml`;
}
/** The .env path the key-set writes to (gitignored; never committed — D-026). */
function envPath(): string {
	return process.env.ENV_FILE?.trim() || '.env';
}

/** A read-only view of one routing tier (agent-pool.yaml — D-020). */
interface TierView {
	name: string;
	provider: string;
	model: string;
}
/** A read-only view of one intent→config bundle (orchestration.yaml — D-020). */
interface BundleView {
	intent: string;
	configured: boolean;
	thinking?: string;
	retrievalDepth?: number;
	retrievalShare?: number;
	toolCalls?: number;
	concurrency?: number;
	tokenBudget?: number;
	capabilities?: { skills?: string[]; agents?: string[]; mcp?: string[] };
}

export interface SettingsData {
	/** The mode persisted in orchestration.yaml. */
	configuredMode: OrchMode | null;
	/** The mode the RUNNING orchestrator booted with — null when none is running (honest). */
	runningMode: OrchMode | null;
	/** True iff an orchestrator is live (so we can say "restart needed" honestly). */
	orchestratorRunning: boolean;
	modes: readonly OrchMode[];
	triggers: string[];
	intervalMs: number | null;
	concurrency: { maxAgents: number; perProject: number } | null;
	/** Routing view (D-020). */
	tiers: TierView[];
	escalationOrder: string[];
	bundles: BundleView[];
	/** MODEL-BENCHMARK-SPEC step 1 — the configured global default-provider toggle + its options. */
	defaultProvider: DefaultProvider;
	defaultProviders: readonly DefaultProvider[];
	/** API-key presence (D-026 — set/unset only, NEVER a value). */
	keys: KeyPresence[];
	/** Honest config-read error (the file is malformed) — surfaced, not hidden. */
	configError?: string;
}

function projectBundles(orch: Orchestration | null): BundleView[] {
	return INTENT_CLASSES.map((intent) => {
		const b = orch?.bundles?.[intent];
		if (!b) return { intent, configured: false };
		const v: BundleView = { intent, configured: true };
		if (b.thinking !== undefined) v.thinking = b.thinking;
		if (typeof b.retrievalDepth === 'number') v.retrievalDepth = b.retrievalDepth;
		if (typeof b.retrievalShare === 'number') v.retrievalShare = b.retrievalShare;
		if (typeof b.toolCalls === 'number') v.toolCalls = b.toolCalls;
		if (typeof b.concurrency === 'number') v.concurrency = b.concurrency;
		if (typeof b.tokenBudget === 'number') v.tokenBudget = b.tokenBudget;
		if (b.capabilities) v.capabilities = b.capabilities;
		return v;
	});
}

function projectTiers(pool: AgentPool | null): TierView[] {
	if (!pool) return [];
	return Object.entries(pool.tiers).map(([name, t]) => ({
		name,
		provider: t.provider,
		model: t.model
	}));
}

export const load: PageServerLoad = async () => {
	// API-key presence is independent of the DB / config files — always honest.
	const keys = describeKeyPresence(env as Record<string, string | undefined>);

	let orch: Orchestration | null = null;
	let pool: AgentPool | null = null;
	let configError: string | undefined;
	try {
		orch = loadOrchestration(orchPath());
	} catch (err) {
		configError = (err as Error).message;
	}
	try {
		pool = loadAgentPool(`${configDir()}/agent-pool.yaml`);
	} catch (err) {
		// Keep the orchestration error if present; otherwise surface the pool error.
		configError = configError ?? (err as Error).message;
	}

	const running = activeOrchestrator();

	const data: SettingsData = {
		configuredMode: orch?.mode ?? null,
		runningMode: running ? running.mode : null,
		orchestratorRunning: running !== null,
		modes: ORCH_MODES,
		triggers: orch?.triggers ?? [],
		intervalMs: orch?.intervalMs ?? null,
		concurrency: orch?.concurrency ?? null,
		tiers: projectTiers(pool),
		escalationOrder: pool?.escalation?.order ?? [],
		bundles: projectBundles(orch),
		// The global default-provider toggle (absent ⇒ 'auto' — the no-regression default).
		defaultProvider: orch?.defaultProvider ?? 'auto',
		defaultProviders: DEFAULT_PROVIDERS,
		keys
	};
	if (configError) data.configError = configError;
	return data;
};

/** Parse a triggers string ("a, b c") into a clean string[] (commas/whitespace separated). */
function parseTriggers(raw: string): string[] {
	return raw
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean);
}

export const actions: Actions = {
	/**
	 * ORCHESTRATION write, step 1 — PLAN (D-010): validate the proposed mode/triggers/interval
	 * change + compute the diff vs orchestration.yaml on disk NOW. No write. Returns the diff,
	 * the proposed bytes, and the confirm token. The boundary validators (loadOrchestration)
	 * reject an out-of-enum mode / bad interval here, before the operator can confirm.
	 */
	planMode: async ({ request }) => {
		const form = await request.formData();
		const modeRaw = form.get('mode');
		if (typeof modeRaw !== 'string' || !(ORCH_MODES as readonly string[]).includes(modeRaw)) {
			return fail(400, { orch: { error: `mode must be one of ${ORCH_MODES.join(' | ')}` } });
		}
		const mode = modeRaw as OrchMode;
		const change: { mode: OrchMode; triggers?: string[]; intervalMs?: number } = { mode };

		const triggersRaw = form.get('triggers');
		if (typeof triggersRaw === 'string') change.triggers = parseTriggers(triggersRaw);

		const intervalRaw = form.get('intervalMs');
		if (typeof intervalRaw === 'string' && intervalRaw.trim() !== '') {
			const n = Number(intervalRaw);
			if (!Number.isInteger(n) || n < 1) {
				return fail(400, { orch: { error: 'interval must be a positive integer (ms)' } });
			}
			change.intervalMs = n;
		}

		try {
			const plan = planOrchestrationWrite({ filePath: orchPath(), change });
			return {
				orch: {
					phase: 'confirming' as const,
					mode: plan.mode,
					proposed: plan.proposed,
					confirmToken: plan.confirmToken,
					unchanged: plan.diff.unchanged,
					hunks: plan.diff.hunks
				}
			};
		} catch (err) {
			if (err instanceof OrchestrationWriteError) return fail(422, { orch: { error: err.message } });
			return fail(500, { orch: { error: (err as Error).message } });
		}
	},

	/**
	 * ORCHESTRATION write, step 2 — APPLY (D-010): the CONFIRM. applyOrchestrationWrite
	 * re-validates, asserts the file still matches the token (StaleConfirmError on a hand-edit
	 * since the diff — never silently clobbered), then writes. Reports the RUNNING orchestrator's
	 * mode so the page can say honestly whether a restart is needed (the orchestrator reads mode
	 * per-boot — boot.ts).
	 */
	applyMode: async ({ request }) => {
		const form = await request.formData();
		const proposed = typeof form.get('proposed') === 'string' ? String(form.get('proposed')) : '';
		const confirmToken =
			typeof form.get('confirmToken') === 'string' ? String(form.get('confirmToken')) : '';
		if (!proposed || !confirmToken) {
			return fail(400, { orch: { error: 'missing proposed content or confirm token — re-review the diff' } });
		}
		try {
			const res = applyOrchestrationWrite({ filePath: orchPath(), proposed, confirmToken });
			const running = activeOrchestrator();
			const restartNeeded = running !== null && running.mode !== res.mode;
			return {
				orch: {
					phase: 'saved' as const,
					mode: res.mode,
					bytesWritten: res.bytesWritten,
					orchestratorRunning: running !== null,
					runningMode: running ? running.mode : null,
					restartNeeded
				}
			};
		} catch (err) {
			if (err instanceof OrchestrationStaleConfirmError) {
				return fail(409, { orch: { error: err.message } });
			}
			if (err instanceof OrchestrationWriteError) {
				return fail(422, { orch: { error: err.message } });
			}
			return fail(500, { orch: { error: (err as Error).message } });
		}
	},

	/**
	 * MODEL-BENCHMARK-SPEC step 1 — GLOBAL default-provider toggle, step 1 (PLAN). A SENSITIVE
	 * routing write (it changes which provider every orchestrator-routed spawn runs on), so it
	 * follows the SAME D-010 validate → diff → confirm shape as the mode write. Reuses
	 * planOrchestrationWrite with a { defaultProvider } change; no write here.
	 */
	planProvider: async ({ request }) => {
		const form = await request.formData();
		const raw = form.get('defaultProvider');
		if (typeof raw !== 'string' || !(DEFAULT_PROVIDERS as readonly string[]).includes(raw)) {
			return fail(400, { prov: { error: `provider must be one of ${DEFAULT_PROVIDERS.join(' | ')}` } });
		}
		const defaultProvider = raw as DefaultProvider;
		try {
			const plan = planOrchestrationWrite({ filePath: orchPath(), change: { defaultProvider } });
			return {
				prov: {
					phase: 'confirming' as const,
					defaultProvider,
					proposed: plan.proposed,
					confirmToken: plan.confirmToken,
					unchanged: plan.diff.unchanged,
					hunks: plan.diff.hunks
				}
			};
		} catch (err) {
			if (err instanceof OrchestrationWriteError) return fail(422, { prov: { error: err.message } });
			return fail(500, { prov: { error: (err as Error).message } });
		}
	},

	/**
	 * GLOBAL default-provider toggle, step 2 (APPLY / CONFIRM). applyOrchestrationWrite re-validates,
	 * asserts the file still matches the token (StaleConfirmError on a hand-edit), then writes. The
	 * orchestrator reads defaultProvider ONCE per boot (bootRoute), so a change persists now but the
	 * running fleet only reflects it after a restart — surfaced honestly (F-029).
	 */
	applyProvider: async ({ request }) => {
		const form = await request.formData();
		const proposed = typeof form.get('proposed') === 'string' ? String(form.get('proposed')) : '';
		const confirmToken =
			typeof form.get('confirmToken') === 'string' ? String(form.get('confirmToken')) : '';
		const defaultProviderRaw = form.get('defaultProvider');
		const defaultProvider =
			typeof defaultProviderRaw === 'string' &&
			(DEFAULT_PROVIDERS as readonly string[]).includes(defaultProviderRaw)
				? (defaultProviderRaw as DefaultProvider)
				: null;
		if (!proposed || !confirmToken) {
			return fail(400, { prov: { error: 'missing proposed content or confirm token — re-review the diff' } });
		}
		try {
			const res = applyOrchestrationWrite({ filePath: orchPath(), proposed, confirmToken });
			const running = activeOrchestrator();
			return {
				prov: {
					phase: 'saved' as const,
					defaultProvider,
					bytesWritten: res.bytesWritten,
					orchestratorRunning: running !== null,
					// The running orchestrator read defaultProvider at boot — a live orchestrator needs a
					// restart to pick up the new provider (honest boot-read reflect, F-029).
					restartNeeded: running !== null
				}
			};
		} catch (err) {
			if (err instanceof OrchestrationStaleConfirmError) return fail(409, { prov: { error: err.message } });
			if (err instanceof OrchestrationWriteError) return fail(422, { prov: { error: err.message } });
			return fail(500, { prov: { error: (err as Error).message } });
		}
	},

	/**
	 * API-KEY set (D-026): write ONE managed credential to .env. The value is NEVER returned or
	 * logged — only the resulting presence boolean. An unmanaged key / unsafe value is refused at
	 * the boundary (allow-list + no-newline). An empty value CLEARS the key (honest unset).
	 */
	setKey: async ({ request }) => {
		const form = await request.formData();
		const key = typeof form.get('key') === 'string' ? String(form.get('key')) : '';
		// The value is read from the form and handed straight to the writer — never echoed back.
		const value = typeof form.get('value') === 'string' ? String(form.get('value')) : '';
		try {
			const res = setEnvKey(envPath(), key, value);
			return {
				keyset: {
					key: res.key,
					present: res.present,
					// Honest note: $env/dynamic/private is read at request time, but a freshly-written
					// .env value is only picked up by the RUNNING process on the next boot — so the
					// presence flips in the file now, and the live runtime uses it after a restart.
					restartNeeded: true
				}
			};
		} catch (err) {
			if (err instanceof EnvWriteError) return fail(422, { keyset: { error: err.message } });
			return fail(500, { keyset: { error: (err as Error).message } });
		}
	}
};
