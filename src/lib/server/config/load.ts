// server/config — load + validate agent-pool / models / orchestration (TASK 0.e).
//
// ARCHITECTURE §6 / §5: the `config` module depends on NOTHING. It loads the
// three operator config files and validates them AT THE BOUNDARY (the only
// place untrusted-on-disk config enters the system) before any other module
// consumes them. Parse failures and invariant violations surface as a single
// ConfigError type — never a raw fs/parse error and never a silently-accepted
// malformed config.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import JSON5 from 'json5';

/** A single failure loading or validating a config file. */
export class ConfigError extends Error {
	readonly file?: string;
	constructor(message: string, file?: string) {
		super(file ? `${message} (${file})` : message);
		this.name = 'ConfigError';
		this.file = file;
	}
}

// --- agent-pool.yaml -------------------------------------------------------

export interface Tier {
	provider: string;
	model: string;
}
export interface AgentSlot {
	id: string;
	tier: string;
	role: string;
}
export interface AgentPool {
	tiers: Record<string, Tier>;
	slots: AgentSlot[];
	escalation?: { order: string[] };
	delegation?: { from: string; to: string };
}

// --- models.{json5,yaml} ---------------------------------------------------

export interface ProviderSpec {
	endpoint: string;
	models: string[];
}
export interface ModelsConfig {
	providers: Record<string, ProviderSpec>;
}

// --- orchestration.yaml ----------------------------------------------------

export const ORCH_MODES = ['event', 'periodic', 'manual'] as const;
export type OrchMode = (typeof ORCH_MODES)[number];

// --- intent-adaptive config bundles (D-020) --------------------------------
//
// TASK 2.12: the five intents KongCode classifies (mirrors runtime `Intent` and
// routing's INTENTS — kept in lock-step). Each intent maps to a tunable, operator-
// authored ConfigBundle in orchestration.yaml. The map is validated HERE — config is
// untrusted-on-disk and `config` is the sole boundary it crosses (ARCHITECTURE §6) —
// so a typo'd intent key or a negative budget fails to boot rather than silently
// mis-routing a live spawn.

/** The five intent classes a task routes into (lock-step with runtime Intent / routing INTENTS). */
export const INTENT_CLASSES = [
	'simple-question',
	'code-read',
	'code-write',
	'code-debug',
	'deep-explore'
] as const;
export type IntentClass = (typeof INTENT_CLASSES)[number];

/** Valid `thinking` levels for a bundle (the spawn budget's thinking tier — D-020). */
export const THINKING_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * A per-task capability selection (D-036 / task 5.1): the allow-listed skills/agents/mcp
 * an intent's driven session may wield, drawn from the cc-config catalog (1.8/2.11). The
 * runtime composes harness-base ⊕ THIS set into the isolated config, catalog-validated
 * (an unknown id fails closed). Each list is OPTIONAL (absent ⇒ empty) so a bundle may
 * declare only the dimensions it needs.
 */
export interface CapabilityBundle {
	/** Skill ids (cc_skill.name) to provision. */
	skills?: string[];
	/** Agent ids (cc_agent.name) to provision. */
	agents?: string[];
	/** MCP server ids (cc_mcp_server.name) to provision. */
	mcp?: string[];
}

/**
 * A per-intent adaptive config (D-020): thinking level + tool/concurrency budget +
 * memory-retrieval depth/share + token budget. All knobs are OPTIONAL (an absent knob
 * falls through to the runtime/memory default); the map stays open (`[k]`) so operators
 * can add forward-compat tunables (e.g. per-table vector-search limits) without a code
 * change — but the KNOWN knobs below are type-checked AND boundary-validated.
 */
export interface ConfigBundle {
	/** Thinking tier fed to SpawnBudgets.thinking (none|low|medium|high). */
	thinking?: ThinkingLevel;
	/** Memory-recall depth (vector KNN limit) — non-negative integer. */
	retrievalDepth?: number;
	/** Share of the context window given to retrieval, 0..1. */
	retrievalShare?: number;
	/** Per-spawn tool-call budget — non-negative integer. */
	toolCalls?: number;
	/** Per-spawn concurrency hint — non-negative integer. */
	concurrency?: number;
	/** Token budget for the spawn — non-negative integer. */
	tokenBudget?: number;
	/**
	 * D-036 per-task capability set: the allow-listed skills/agents/mcp this intent's
	 * driven session may wield (catalog-validated by the runtime, not here — the config
	 * boundary only checks SHAPE; the cc-config catalog is the id allow-list at spawn time).
	 */
	capabilities?: CapabilityBundle;
	[k: string]: unknown;
}
export interface Orchestration {
	mode: OrchMode;
	triggers?: string[];
	intervalMs?: number;
	concurrency: { maxAgents: number; perProject: number };
	/**
	 * intent → adaptive config (D-020). Validated at the boundary (loadOrchestration).
	 * Partial: an unconfigured intent resolves to an empty bundle (all-defaults), so a
	 * sparsely-tuned orchestration.yaml still routes every intent (resolveAdaptiveConfig).
	 */
	bundles?: Partial<Record<IntentClass, ConfigBundle>>;
}

/** Spawn budgets derived from a bundle — the subset routing hands to AgentRuntime (D-020). */
export interface BundleBudgets {
	thinking?: ThinkingLevel;
	toolCalls?: number;
	concurrency?: number;
}

// --- gates.yaml (TASK 15.1 / HARVEST B1 — the scope-lock edit gate's pattern lists) ---
//
// The destructive-bash deny/allow pattern lists the edit-scope gate enforces ship HERE,
// operator-editable, NOT hardcoded in the gate evaluator (requirement (b)). The launch
// path merges these into a session's declared editScope; the gate layer compiles them
// fail-closed (a pattern that does not compile DENIES the spawn/tool — D-024).
// PROVENANCE of the default list: gstack careful/bin/check-careful.sh + freeze (MIT),
// adapted to this stack (SurrealDB/git/npm/docker/taskkill; kubectl dropped).

/** One operator-authored bash pattern entry in gates.yaml. */
export interface GatePatternEntry {
	/** Stable id — names WHICH pattern fired in a deny reason. */
	id: string;
	/** RegExp source matched against the lower-cased, whitespace-collapsed command. */
	pattern: string;
	/** Operator-readable reason surfaced in the deny message. */
	reason?: string;
}

/** The validated shape of config/gates.yaml. */
export interface GatesConfig {
	destructiveBash: {
		/** Substring-matched deny patterns. */
		deny: GatePatternEntry[];
		/** FULL-COMMAND-anchored safe exceptions (rm -rf of build artifacts etc.). */
		allow: GatePatternEntry[];
	};
}

function validateGatePatternList(raw: unknown, kind: 'deny' | 'allow', file: string): GatePatternEntry[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		throw new ConfigError(`gates: destructiveBash.${kind} must be a list`, file);
	}
	return raw.map((entry, i) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new ConfigError(`gates: destructiveBash.${kind}[${i}] must be a mapping {id, pattern, reason?}`, file);
		}
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== 'string' || !e.id.trim()) {
			throw new ConfigError(`gates: destructiveBash.${kind}[${i}] needs a non-empty string id`, file);
		}
		if (typeof e.pattern !== 'string' || !e.pattern.trim()) {
			throw new ConfigError(`gates: destructiveBash.${kind} "${e.id}" needs a non-empty string pattern`, file);
		}
		if (e.reason !== undefined && typeof e.reason !== 'string') {
			throw new ConfigError(`gates: destructiveBash.${kind} "${e.id}" reason must be a string`, file);
		}
		// The pattern must COMPILE — a malformed regex fails the load (fail closed at the
		// boundary), not the first tool call. (`^(?:p)$` anchoring compiles iff `p` does.)
		try {
			new RegExp(e.pattern);
		} catch (err) {
			throw new ConfigError(
				`gates: destructiveBash.${kind} "${e.id}" pattern does not compile: ${(err as Error).message}`,
				file
			);
		}
		return {
			id: e.id,
			pattern: e.pattern,
			...(e.reason !== undefined ? { reason: e.reason as string } : {})
		};
	});
}

/**
 * Load + validate config/gates.yaml (the scope-lock pattern lists). FAIL CLOSED: a
 * missing/unreadable/malformed file throws ConfigError — callers that need an editScope
 * must refuse the launch rather than spawn with the destructive-bash list silently empty.
 */
export function loadGatesConfig(file: string, opts: LoadOpts = {}): GatesConfig {
	const raw = { ...asObject(parseYaml(file), file), ...(opts._inject ?? {}) };
	const db = raw.destructiveBash;
	if (db === null || db === undefined || typeof db !== 'object' || Array.isArray(db)) {
		throw new ConfigError('gates: "destructiveBash" must be a mapping with deny/allow lists', file);
	}
	const d = db as Record<string, unknown>;
	return {
		destructiveBash: {
			deny: validateGatePatternList(d.deny, 'deny', file),
			allow: validateGatePatternList(d.allow, 'allow', file)
		}
	};
}

// --- workforce.yaml (TASK 16.1 / PM-SPEC §1 + WORKFORCE-SPEC) ----------------
//
// THE single config namespace for ALL workforce keys (pm.*, panel.*, gauntlet.*,
// budget.*, drift.*, workforce.* — one file, one loader). 16.1 consumes ONLY the
// pm.{provider, model_id} pair (the PM's explicit model override — F-005); the
// other namespaces ship with justified/null defaults in config/workforce.yaml and
// are boundary-validated by their consuming wave tasks (W-D7a/b) when they land.
// This loader validates the keys IT serves and keeps the rest open (forward-compat,
// same posture as orchestration bundles' unknown keys).

/** The validated shape of config/workforce.yaml (the keys 16.1 + 16.2 + 16.4 consume). */
export interface WorkforceConfig {
	pm: {
		/** Registered provider name (`claude` = the Claude Code CLI backend). */
		provider: string;
		/** The PM's model id — default Fable 5 (PM-SPEC §1, operator 2026-06-10). */
		model_id: string;
		/** TASK 16.2 (PM-SPEC §3 event ①) — trigger-engine bounds. */
		triggers: {
			/**
			 * Distress threshold (failed sessions + freshly-blocked tasks since the last
			 * review must EXCEED this to auto-fire). null = UNARMED (F-008): the trigger
			 * never auto-fires until the operator sets a bound from real history.
			 */
			failure_threshold: number | null;
		};
		[k: string]: unknown;
	};
	/** TASK 16.4 (PM-SPEC §4.6.3) — panel Step-0 complexity tripwires. null = UNARMED
	 *  (G5/F-008): complexity is raised as an evidenced judgment finding, never a
	 *  numeric verdict, until the operator sets these from our own wave history. */
	panel: {
		scope: {
			max_files: number | null;
			max_new_services: number | null;
		};
		[k: string]: unknown;
	};
	/** TASK 16.6 (WORKFORCE-SPEC §3.5/§3.1) — the gauntlet pass bar + session bound.
	 *  Defaults are the spec-justified launch values (ARMED — admission reference-runs
	 *  prove every plant findable, so a miss/FP is a real error), not invented numbers. */
	gauntlet: {
		/** Required recall over planted defects ([0,1]). Spec-armed launch value 1.0. */
		pass_recall: number;
		/** Max operator-confirmed false positives beyond per-fixture tolerances (int ≥ 0). */
		max_false_positives: number;
		/** §3.1 candidate-session wall-clock bound (minutes, > 0 — F-014 discipline). */
		session_timeout_minutes: number;
	};
	/** TASK 16.6 (WORKFORCE-SPEC §3.7) — auto-interview spend caps. */
	budget: {
		/** null = NOTHING auto-runs; auto-triggers only count-and-surface (F-008). */
		max_auto_interviews_per_day: number | null;
		/** Tiers an auto-triggered interview may spend at. Empty = none. */
		allowed_auto_tiers: string[];
	};
	/** WORKFORCE-SPEC §5 drift triggers (operator decision 4, 2026-06-16). An ARMED
	 *  signal crossing threshold AUTO-RAISES a review_proposal{status:proposed}; the
	 *  prompt-authoring/re-gauntlet/SWAP stay operator-gated (D-010/D-039). RATE
	 *  signals ship UNARMED (null) until v2.2b's B2 review_verdict (rendered
	 *  '— (needs B2)', F-008). Categorical + miscalibration signals are bool-armed. */
	drift: {
		/** §5: an escaped defect (a positive-control failure) — armed at launch. */
		escaped_defect: boolean;
		/** §5: a manual operator-feedback signal — armed at launch. */
		operator_feedback: boolean;
		/** A1-calibration signal: high-confidence verdicts trending to bad outcomes. */
		confidence_miscalibration: boolean;
		/** The high-confidence-wrong RATE at/above which miscalibration fires
		 *  ([0,1]). null = the signal is disarmed even if the bool is true. */
		confidence_miscalibration_rate: number | null;
		/** Post-B2 RATE signal — null until v2.2b lands review_verdict (F-008). */
		refutation_rate: number | null;
		/** Post-B2 RATE signal — null until v2.2b lands review_verdict (F-008). */
		fixloop_rate: number | null;
		[k: string]: unknown;
	};
	/** TASK 16.4 (PM-SPEC §4 / WORKFORCE-SPEC §5 anti-spam) — proposal caps + the §5
	 *  track-window / claim-floor (conservative starting points, operator-tunable). */
	workforce: {
		/** Max OPEN PM proposals per key (per project for tasks); at cap the PM
		 *  records to pm_memory instead. Default 2 — the §5 conservative start. */
		max_open_proposals: number;
		/** §5 drift track window in days (default 14 — a conservative start). */
		track_window_days: number;
		/** §5 claim floor: below this many events the PM must not claim degradation
		 *  (default 5 — a conservative start). */
		min_events_for_claim: number;
		[k: string]: unknown;
	};
	[k: string]: unknown;
}

/**
 * Load + validate config/workforce.yaml. FAIL CLOSED on shape: a missing file, a
 * non-mapping root/pm block, or a missing/empty pm.model_id throws ConfigError —
 * callers choose their honest degradation (resolvePmRoute records an explicit
 * "fallback" routing_event rather than spawning on a silent constant).
 */
export function loadWorkforce(file: string, opts: LoadOpts = {}): WorkforceConfig {
	const raw = { ...asObject(parseYaml(file), file), ...(opts._inject ?? {}) };
	const pm = raw.pm;
	if (pm === null || pm === undefined || typeof pm !== 'object' || Array.isArray(pm)) {
		throw new ConfigError('workforce: "pm" must be a mapping with model_id (PM-SPEC §1)', file);
	}
	const p = pm as Record<string, unknown>;
	if (typeof p.model_id !== 'string' || !p.model_id.trim()) {
		throw new ConfigError('workforce: pm.model_id must be a non-empty string', file);
	}
	if (p.provider !== undefined && (typeof p.provider !== 'string' || !p.provider.trim())) {
		throw new ConfigError('workforce: pm.provider must be a non-empty string when set', file);
	}
	// TASK 16.2 — pm.triggers.* (PM-SPEC §3 event ①). The block is optional (an older
	// file simply ships unarmed); when present it must be a mapping, and the threshold
	// must be null (unarmed) or a non-negative integer — fail closed on anything else.
	let failureThreshold: number | null = null;
	if (p.triggers !== undefined) {
		if (p.triggers === null || typeof p.triggers !== 'object' || Array.isArray(p.triggers)) {
			throw new ConfigError('workforce: pm.triggers must be a mapping when set', file);
		}
		const t = (p.triggers as Record<string, unknown>).failure_threshold;
		if (t !== undefined && t !== null) {
			if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) {
				throw new ConfigError(
					'workforce: pm.triggers.failure_threshold must be null (unarmed) or a non-negative integer',
					file
				);
			}
			failureThreshold = t;
		}
	}

	// TASK 16.4 — panel.scope.* tripwires (PM-SPEC §4.6.3). Optional block (older files
	// ship unarmed); when present each bound must be null (unarmed) or a non-negative
	// integer — fail closed on anything else (no imported magic numbers, G5).
	const scopeBound = (block: Record<string, unknown>, key: string): number | null => {
		const v = block[key];
		if (v === undefined || v === null) return null;
		if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
			throw new ConfigError(
				`workforce: panel.scope.${key} must be null (unarmed) or a non-negative integer`,
				file
			);
		}
		return v;
	};
	let scopeMaxFiles: number | null = null;
	let scopeMaxNewServices: number | null = null;
	const panelRaw = raw.panel;
	if (panelRaw !== undefined) {
		if (panelRaw === null || typeof panelRaw !== 'object' || Array.isArray(panelRaw)) {
			throw new ConfigError('workforce: "panel" must be a mapping when set', file);
		}
		const scope = (panelRaw as Record<string, unknown>).scope;
		if (scope !== undefined) {
			if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
				throw new ConfigError('workforce: panel.scope must be a mapping when set', file);
			}
			const s = scope as Record<string, unknown>;
			scopeMaxFiles = scopeBound(s, 'max_files');
			scopeMaxNewServices = scopeBound(s, 'max_new_services');
		}
	}

	// TASK 16.4 — workforce.max_open_proposals (anti-spam cap, WORKFORCE-SPEC §5).
	// Default 2 (the §5 conservative starting point, shipped in config — not invented
	// here); when present it must be a positive integer (a 0/negative cap would
	// silently kill the Act-with-Purpose pipeline — fail closed instead).
	let maxOpenProposals = 2;
	let trackWindowDays = 14;
	let minEventsForClaim = 5;
	const wfRaw = raw.workforce;
	if (wfRaw !== undefined) {
		if (wfRaw === null || typeof wfRaw !== 'object' || Array.isArray(wfRaw)) {
			throw new ConfigError('workforce: "workforce" must be a mapping when set', file);
		}
		const w = wfRaw as Record<string, unknown>;
		const cap = w.max_open_proposals;
		if (cap !== undefined && cap !== null) {
			if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) {
				throw new ConfigError(
					'workforce: workforce.max_open_proposals must be a positive integer',
					file
				);
			}
			maxOpenProposals = cap;
		}
		// §5 track window / claim floor — conservative defaults; when present each must
		// be a POSITIVE integer (a 0/negative window or floor is meaningless — fail closed).
		const posInt = (v: unknown, key: string): number | null => {
			if (v === undefined || v === null) return null;
			if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
				throw new ConfigError(`workforce: workforce.${key} must be a positive integer`, file);
			}
			return v;
		};
		trackWindowDays = posInt(w.track_window_days, 'track_window_days') ?? trackWindowDays;
		minEventsForClaim = posInt(w.min_events_for_claim, 'min_events_for_claim') ?? minEventsForClaim;
	}

	// WORKFORCE-SPEC §5 — drift.* (operator decision 4). Optional block (older files ship
	// the categorical signals armed + rate signals unarmed). Bool signals must be booleans;
	// the miscalibration rate + the post-B2 rate signals must be null (UNARMED — F-008, no
	// invented bound) or a number in [0,1]. Fail closed on anything else (no silent knob).
	let driftEscapedDefect = true;
	let driftOperatorFeedback = true;
	let driftConfidenceMiscalibration = true;
	let driftConfidenceMiscalibrationRate: number | null = null;
	let driftRefutationRate: number | null = null;
	let driftFixloopRate: number | null = null;
	const driftRaw = raw.drift;
	if (driftRaw !== undefined) {
		if (driftRaw === null || typeof driftRaw !== 'object' || Array.isArray(driftRaw)) {
			throw new ConfigError('workforce: "drift" must be a mapping when set', file);
		}
		const d = driftRaw as Record<string, unknown>;
		const bool = (v: unknown, key: string, dflt: boolean): boolean => {
			if (v === undefined) return dflt;
			if (typeof v !== 'boolean') {
				throw new ConfigError(`workforce: drift.${key} must be a boolean (armed/disarmed)`, file);
			}
			return v;
		};
		// A rate bound: null = UNARMED (G5/F-008 — never auto-derived), else a number in [0,1].
		const rate = (v: unknown, key: string): number | null => {
			if (v === undefined || v === null) return null;
			if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) {
				throw new ConfigError(
					`workforce: drift.${key} must be null (unarmed) or a number in [0,1]`,
					file
				);
			}
			return v;
		};
		driftEscapedDefect = bool(d.escaped_defect, 'escaped_defect', true);
		driftOperatorFeedback = bool(d.operator_feedback, 'operator_feedback', true);
		driftConfidenceMiscalibration = bool(
			d.confidence_miscalibration,
			'confidence_miscalibration',
			true
		);
		driftConfidenceMiscalibrationRate = rate(
			d.confidence_miscalibration_rate,
			'confidence_miscalibration_rate'
		);
		driftRefutationRate = rate(d.refutation_rate, 'refutation_rate');
		driftFixloopRate = rate(d.fixloop_rate, 'fixloop_rate');
	}

	// TASK 16.6 — gauntlet.* (WORKFORCE-SPEC §3.5 pass bar + §3.1 session bound). The
	// block is optional; defaults are the SPEC-justified launch values (armed pass bar:
	// reference-runs prove every plant findable, so a miss/FP is a real error — §3.5).
	// Anything present must be well-shaped — fail closed (no silently-ignored knob).
	let passRecall = 1.0;
	let maxFalsePositives = 0;
	let sessionTimeoutMinutes = 15;
	const gauntletRaw = raw.gauntlet;
	if (gauntletRaw !== undefined) {
		if (gauntletRaw === null || typeof gauntletRaw !== 'object' || Array.isArray(gauntletRaw)) {
			throw new ConfigError('workforce: "gauntlet" must be a mapping when set', file);
		}
		const g = gauntletRaw as Record<string, unknown>;
		if (g.pass_recall !== undefined) {
			if (typeof g.pass_recall !== 'number' || g.pass_recall < 0 || g.pass_recall > 1) {
				throw new ConfigError('workforce: gauntlet.pass_recall must be a number in [0,1]', file);
			}
			passRecall = g.pass_recall;
		}
		if (g.max_false_positives !== undefined) {
			if (
				typeof g.max_false_positives !== 'number' ||
				!Number.isInteger(g.max_false_positives) ||
				g.max_false_positives < 0
			) {
				throw new ConfigError(
					'workforce: gauntlet.max_false_positives must be a non-negative integer',
					file
				);
			}
			maxFalsePositives = g.max_false_positives;
		}
		if (g.session_timeout_minutes !== undefined) {
			if (
				typeof g.session_timeout_minutes !== 'number' ||
				!Number.isFinite(g.session_timeout_minutes) ||
				g.session_timeout_minutes <= 0
			) {
				throw new ConfigError(
					'workforce: gauntlet.session_timeout_minutes must be a positive number (minutes)',
					file
				);
			}
			sessionTimeoutMinutes = g.session_timeout_minutes;
		}
	}

	// TASK 16.6 — budget.* (WORKFORCE-SPEC §3.7). Default null/[] = nothing auto-runs;
	// auto-triggers only count-and-surface until the operator sets a cap (F-008).
	let maxAutoInterviewsPerDay: number | null = null;
	let allowedAutoTiers: string[] = [];
	const budgetRaw = raw.budget;
	if (budgetRaw !== undefined) {
		if (budgetRaw === null || typeof budgetRaw !== 'object' || Array.isArray(budgetRaw)) {
			throw new ConfigError('workforce: "budget" must be a mapping when set', file);
		}
		const b = budgetRaw as Record<string, unknown>;
		const capDay = b.max_auto_interviews_per_day;
		if (capDay !== undefined && capDay !== null) {
			if (typeof capDay !== 'number' || !Number.isInteger(capDay) || capDay < 0) {
				throw new ConfigError(
					'workforce: budget.max_auto_interviews_per_day must be null (unarmed) or a non-negative integer',
					file
				);
			}
			maxAutoInterviewsPerDay = capDay;
		}
		const tiers = b.allowed_auto_tiers;
		if (tiers !== undefined && tiers !== null) {
			if (
				!Array.isArray(tiers) ||
				tiers.some((t) => !['local', 'haiku', 'sonnet', 'opus'].includes(t as string))
			) {
				throw new ConfigError(
					'workforce: budget.allowed_auto_tiers must be a list drawn from [local, haiku, sonnet, opus]',
					file
				);
			}
			allowedAutoTiers = tiers as string[];
		}
	}

	return {
		...raw,
		pm: {
			...p,
			model_id: p.model_id.trim(),
			// `claude` is the registered Claude Code CLI backend — the provider every
			// claude-* tier in agent-pool.yaml names; the justified default, not magic.
			provider: typeof p.provider === 'string' && p.provider.trim() ? p.provider.trim() : 'claude',
			triggers: { failure_threshold: failureThreshold }
		},
		panel: {
			...(panelRaw && typeof panelRaw === 'object' && !Array.isArray(panelRaw)
				? (panelRaw as Record<string, unknown>)
				: {}),
			scope: { max_files: scopeMaxFiles, max_new_services: scopeMaxNewServices }
		},
		gauntlet: {
			...(gauntletRaw && typeof gauntletRaw === 'object' && !Array.isArray(gauntletRaw)
				? (gauntletRaw as Record<string, unknown>)
				: {}),
			pass_recall: passRecall,
			max_false_positives: maxFalsePositives,
			session_timeout_minutes: sessionTimeoutMinutes
		},
		budget: {
			...(budgetRaw && typeof budgetRaw === 'object' && !Array.isArray(budgetRaw)
				? (budgetRaw as Record<string, unknown>)
				: {}),
			max_auto_interviews_per_day: maxAutoInterviewsPerDay,
			allowed_auto_tiers: allowedAutoTiers
		},
		drift: {
			...(driftRaw && typeof driftRaw === 'object' && !Array.isArray(driftRaw)
				? (driftRaw as Record<string, unknown>)
				: {}),
			escaped_defect: driftEscapedDefect,
			operator_feedback: driftOperatorFeedback,
			confidence_miscalibration: driftConfidenceMiscalibration,
			confidence_miscalibration_rate: driftConfidenceMiscalibrationRate,
			refutation_rate: driftRefutationRate,
			fixloop_rate: driftFixloopRate
		},
		workforce: {
			...(wfRaw && typeof wfRaw === 'object' && !Array.isArray(wfRaw)
				? (wfRaw as Record<string, unknown>)
				: {}),
			max_open_proposals: maxOpenProposals,
			track_window_days: trackWindowDays,
			min_events_for_claim: minEventsForClaim
		}
	};
}

/** The full loaded config tree. */
export interface AppConfig {
	agentPool: AgentPool;
	models: ModelsConfig;
	orchestration: Orchestration;
}

/** Test seam: merge an override into the parsed object before validation. */
interface LoadOpts {
	_inject?: Record<string, unknown>;
}

function readText(file: string): string {
	try {
		return readFileSync(file, 'utf8');
	} catch (err) {
		throw new ConfigError(
			`cannot read config file: ${(err as Error).message}`,
			file
		);
	}
}

function parseYaml(file: string): unknown {
	try {
		return yaml.load(readText(file));
	} catch (err) {
		if (err instanceof ConfigError) throw err;
		throw new ConfigError(`invalid YAML: ${(err as Error).message}`, file);
	}
}

function parseJson5(file: string): unknown {
	try {
		return JSON5.parse(readText(file));
	} catch (err) {
		if (err instanceof ConfigError) throw err;
		throw new ConfigError(`invalid JSON5: ${(err as Error).message}`, file);
	}
}

function asObject(v: unknown, file: string): Record<string, unknown> {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) {
		throw new ConfigError('expected a mapping at the document root', file);
	}
	return v as Record<string, unknown>;
}

/** Load + validate agent-pool.yaml. */
export function loadAgentPool(file: string, opts: LoadOpts = {}): AgentPool {
	const raw = { ...asObject(parseYaml(file), file), ...(opts._inject ?? {}) };
	const tiers = raw.tiers;
	if (tiers === null || typeof tiers !== 'object' || Array.isArray(tiers)) {
		throw new ConfigError('agent-pool: "tiers" must be a mapping', file);
	}
	const slots = raw.slots;
	if (!Array.isArray(slots)) {
		throw new ConfigError('agent-pool: "slots" must be a list', file);
	}
	const tierNames = new Set(Object.keys(tiers as object));
	for (const slot of slots) {
		if (!slot || typeof slot !== 'object') {
			throw new ConfigError('agent-pool: each slot must be a mapping', file);
		}
		const s = slot as Record<string, unknown>;
		if (typeof s.id !== 'string' || typeof s.tier !== 'string' || typeof s.role !== 'string') {
			throw new ConfigError('agent-pool: slot needs string id/tier/role', file);
		}
		if (!tierNames.has(s.tier)) {
			throw new ConfigError(
				`agent-pool: slot "${s.id}" references undefined tier "${s.tier}"`,
				file
			);
		}
	}
	return raw as unknown as AgentPool;
}

/** Load + validate a models config (JSON5 or YAML chosen by caller). */
export function loadModels(file: string, opts: LoadOpts = {}): ModelsConfig {
	const isJson5 = file.endsWith('.json5');
	const parsed = isJson5 ? parseJson5(file) : parseYaml(file);
	const raw = { ...asObject(parsed, file), ...(opts._inject ?? {}) };
	const providers = raw.providers;
	if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
		throw new ConfigError('models: "providers" must be a mapping', file);
	}
	for (const [name, spec] of Object.entries(providers as Record<string, unknown>)) {
		if (!spec || typeof spec !== 'object') {
			throw new ConfigError(`models: provider "${name}" must be a mapping`, file);
		}
		const p = spec as Record<string, unknown>;
		if (typeof p.endpoint !== 'string') {
			throw new ConfigError(`models: provider "${name}" needs a string endpoint`, file);
		}
		if (!Array.isArray(p.models) || p.models.some((m) => typeof m !== 'string')) {
			throw new ConfigError(`models: provider "${name}" needs a list of model ids`, file);
		}
		// Project rule: the local Ollama endpoint must NOT carry a /v1 suffix.
		if (name === 'ollama' && /\/v1\/?$/.test(p.endpoint)) {
			throw new ConfigError(
				`models: ollama endpoint must not include a /v1 suffix ("${p.endpoint}")`,
				file
			);
		}
	}
	return raw as unknown as ModelsConfig;
}

/** Load + validate orchestration.yaml. */
export function loadOrchestration(file: string, opts: LoadOpts = {}): Orchestration {
	const raw = { ...asObject(parseYaml(file), file), ...(opts._inject ?? {}) };
	const mode = raw.mode;
	if (typeof mode !== 'string' || !(ORCH_MODES as readonly string[]).includes(mode)) {
		throw new ConfigError(
			`orchestration: "mode" must be one of ${ORCH_MODES.join(' | ')} (got ${String(mode)})`,
			file
		);
	}
	const conc = raw.concurrency;
	if (conc === null || typeof conc !== 'object' || Array.isArray(conc)) {
		throw new ConfigError('orchestration: "concurrency" must be a mapping', file);
	}
	const c = conc as Record<string, unknown>;
	if (!Number.isInteger(c.maxAgents) || (c.maxAgents as number) < 1) {
		throw new ConfigError('orchestration: concurrency.maxAgents must be a positive integer', file);
	}
	if (!Number.isInteger(c.perProject) || (c.perProject as number) < 1) {
		throw new ConfigError('orchestration: concurrency.perProject must be a positive integer', file);
	}
	// TASK 2.12: validate the intent-adaptive bundles at the boundary (D-020). Each key
	// MUST be one of the five intents; each known knob MUST be the right shape/range.
	if (raw.bundles !== undefined) {
		validateBundles(raw.bundles, file);
	}
	return raw as unknown as Orchestration;
}

/** A non-negative-integer knob check shared across the numeric bundle fields. */
function assertNonNegInt(value: unknown, intent: string, knob: string, file: string): void {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new ConfigError(
			`orchestration: bundle "${intent}".${knob} must be a non-negative integer`,
			file
		);
	}
}

/**
 * Validate orchestration.bundles (D-020) at the config boundary. Rejects:
 *   • a non-mapping `bundles`
 *   • any key that is not one of the five INTENT_CLASSES (a typo would silently
 *     mis-route — fail closed instead)
 *   • a non-mapping bundle value
 *   • an unknown `thinking` level
 *   • a negative / non-integer numeric knob (retrievalDepth/toolCalls/concurrency/tokenBudget)
 *   • a retrievalShare outside [0,1]
 * Unknown extra keys are PERMITTED (forward-compat tunables — the type keeps `[k]` open).
 */
export function validateBundles(bundles: unknown, file: string): void {
	if (bundles === null || typeof bundles !== 'object' || Array.isArray(bundles)) {
		throw new ConfigError('orchestration: "bundles" must be a mapping of intent → config', file);
	}
	const valid = new Set<string>(INTENT_CLASSES);
	for (const [intent, bundle] of Object.entries(bundles as Record<string, unknown>)) {
		if (!valid.has(intent)) {
			throw new ConfigError(
				`orchestration: bundle key "${intent}" is not a known intent (${INTENT_CLASSES.join(' | ')})`,
				file
			);
		}
		if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
			throw new ConfigError(`orchestration: bundle "${intent}" must be a mapping`, file);
		}
		const b = bundle as Record<string, unknown>;
		if (b.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(b.thinking as string)) {
			throw new ConfigError(
				`orchestration: bundle "${intent}".thinking must be one of ${THINKING_LEVELS.join(' | ')} (got ${String(b.thinking)})`,
				file
			);
		}
		if (b.retrievalDepth !== undefined) assertNonNegInt(b.retrievalDepth, intent, 'retrievalDepth', file);
		if (b.toolCalls !== undefined) assertNonNegInt(b.toolCalls, intent, 'toolCalls', file);
		if (b.concurrency !== undefined) assertNonNegInt(b.concurrency, intent, 'concurrency', file);
		if (b.tokenBudget !== undefined) assertNonNegInt(b.tokenBudget, intent, 'tokenBudget', file);
		if (b.retrievalShare !== undefined) {
			const s = b.retrievalShare;
			if (typeof s !== 'number' || Number.isNaN(s) || s < 0 || s > 1) {
				throw new ConfigError(
					`orchestration: bundle "${intent}".retrievalShare must be a number in [0,1] (got ${String(s)})`,
					file
				);
			}
		}
		// TASK 5.1 (D-036): the capability block — SHAPE only at this boundary. Each of
		// skills/agents/mcp must be a list of string ids. The cc-config CATALOG allow-list
		// (id is real / fails closed) is enforced by the runtime at spawn time, where the
		// (DB-backed, drift-tracked) catalog actually lives.
		if (b.capabilities !== undefined) {
			validateCapabilityBundle(b.capabilities, intent, file);
		}
	}
}

/** A skills/agents/mcp dimension must be a list of strings, or absent. */
function assertIdList(value: unknown, intent: string, dim: string, file: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
		throw new ConfigError(
			`orchestration: bundle "${intent}".capabilities.${dim} must be a list of string ids`,
			file
		);
	}
}

/** Validate the SHAPE of a bundle's capability block (D-036). Catalog id-validation is runtime-side. */
export function validateCapabilityBundle(caps: unknown, intent: string, file: string): void {
	if (caps === null || typeof caps !== 'object' || Array.isArray(caps)) {
		throw new ConfigError(
			`orchestration: bundle "${intent}".capabilities must be a mapping { skills, agents, mcp }`,
			file
		);
	}
	const c = caps as Record<string, unknown>;
	assertIdList(c.skills, intent, 'skills', file);
	assertIdList(c.agents, intent, 'agents', file);
	assertIdList(c.mcp, intent, 'mcp', file);
}

// --- intent → bundle resolution (D-020 — the canonical map, TASK 2.12) ------
//
// resolveRoute (2.3) consumes these so the intent→config mapping lives in ONE place
// (the config layer that owns the bundle shape), not duplicated in routing. An intent
// with no configured bundle resolves to an empty bundle (all-defaults) — never throws,
// so a sparsely-configured orchestration.yaml still routes every intent.

/** The adaptive config bundle for an intent (D-020). Empty bundle when none is configured. */
export function resolveAdaptiveConfig(orchestration: Orchestration, intent: IntentClass): ConfigBundle {
	return orchestration.bundles?.[intent] ?? {};
}

/** Derive the spawn-budget subset from a bundle (thinking/toolCalls/concurrency → SpawnBudgets). */
export function bundleToBudgets(bundle: ConfigBundle): BundleBudgets {
	const out: BundleBudgets = {};
	if (bundle.thinking !== undefined) out.thinking = bundle.thinking;
	if (typeof bundle.toolCalls === 'number') out.toolCalls = bundle.toolCalls;
	if (typeof bundle.concurrency === 'number') out.concurrency = bundle.concurrency;
	return out;
}

/**
 * Composite loader: read all three config files from `configDir`.
 * Models prefers `models.json5`, falling back to `models.yaml`.
 */
export function loadConfig(configDir: string): AppConfig {
	const agentPool = loadAgentPool(join(configDir, 'agent-pool.yaml'));

	const json5Path = join(configDir, 'models.json5');
	const yamlPath = join(configDir, 'models.yaml');
	let models: ModelsConfig;
	try {
		readFileSync(json5Path);
		models = loadModels(json5Path);
	} catch {
		models = loadModels(yamlPath);
	}

	const orchestration = loadOrchestration(join(configDir, 'orchestration.yaml'));
	return { agentPool, models, orchestration };
}
