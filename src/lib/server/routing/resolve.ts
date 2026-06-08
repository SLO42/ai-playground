// TASK 2.3 — routing + telemetry (ARCHITECTURE §2.5; DATA-MODEL §4.4; D-020;
// F-005; depends on: db, providers, config).
//
// ONE `resolveRoute(task)` resolves a task to a ResolvedPlan through the canonical
// order, then writes the decision as a `routing_event` (the analytics producer —
// §2.5; `analytics` only QUERIES routing_event, never writes it):
//
//   explicit override → intent classify → tier select → adaptive config
//     → provider/health → fallback
//
// F-005 (carried v1 fail): an EXPLICIT override MUST win and short-circuit the
// whole order — no classification, no tiering. Order is enforced top-to-bottom in
// resolveRoute so the override can never be overridden by a later step.
//
// Provider health has a SINGLE owner: `providers` (§2.5). resolveRoute READS health
// via an injected `providerHealth()` (the ProviderRegistry.health surface) and never
// re-probes — keeping the producer/owner split clean and making the unit test inject
// a mocked health source (NO live model, NO creds, NO network).
//
// Boundary discipline (D-016): the routing_event write binds every VALUE via $param;
// the ONLY interpolated tokens are record ids, validated at db/validate.ts FIRST and
// wrapped as StringRecordId so the SDK serializes a true record link. Absent optionals
// are OMITTED, never set to explicit NULL (option<T> rejects NULL — MEMORY-SPEC §6.1).
// Intent classification + tiering are pure JS (set/array legality stays out of SQL).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { Intent, ModelSelection, SpawnBudgets } from '../runtime/index';
import type { ProviderHealth } from '../providers/index';
import type { AgentPool, Orchestration, ConfigBundle, Tier } from '../config/load';
import { resolveAdaptiveConfig, bundleToBudgets } from '../config/load';

// ── routing_event.method enum (DATA-MODEL §4.4 — kept in lock-step with the schema) ─
export const ROUTING_METHODS = ['explicit', 'classify', 'tier', 'fallback'] as const;
export type RoutingMethod = (typeof ROUTING_METHODS)[number];

/** The five intents (mirrors runtime Intent — §2.5). */
export const INTENTS: readonly Intent[] = [
	'simple-question',
	'code-read',
	'code-write',
	'code-debug',
	'deep-explore'
];

/** The minimal task view routing needs — never mutates the stored task (D-008). */
export interface RouteTask {
	id: string;
	project: string;
	title: string;
	description: string;
}

/** The resolved plan resolveRoute returns (ARCHITECTURE §2.5 ResolvedPlan). */
export interface ResolvedPlan {
	/** Chosen provider + model id (+ tier name). */
	model: ModelSelection;
	/** Classified (or override-implied) intent. */
	intent: Intent;
	/** D-020 adaptive config bundle for the intent (thinking/retrievalDepth/…). */
	adaptiveConfig: ConfigBundle;
	/** Spawn budgets derived from the adaptive config (thinking → budgets.thinking). */
	budgets: SpawnBudgets;
	/** Which step decided the route. */
	method: RoutingMethod;
	/** Human-readable WHY (the rationale persisted on the routing_event). */
	reason: string;
	/** Complexity score in [0,1] (NONE for an explicit override — no scoring run). */
	complexity?: number;
	/** Tiers considered-but-rejected, for analytics. */
	alternatives: Array<Record<string, unknown>>;
	/** Id of the persisted routing_event (the analytics record). */
	routingEventId: string;
}

// ── Intent classification (pure JS — §2.5) ──────────────────────────────────────
//
// A deterministic keyword classifier: cheap, explainable, and good enough to drive
// the adaptive config. (2.12 may swap a model-backed classifier behind this same
// signature — D-020.) Order matters: more-specific intents are tested first so a
// "debug" task is not swallowed by the broader "write" bucket.

const DEBUG_RE = /\b(debug|fix|failing|broken|error|crash|race|repair|regression|stack ?trace)\b/i;
const EXPLORE_RE =
	/\b(investigate|research|explore|architecture|design|tradeoffs?|evaluate|compare|deep[- ]?dive|whole system)\b/i;
const WRITE_RE =
	/\b(implement|add|create|build|write|refactor|introduce|migrate|wire|endpoint|feature)\b/i;
const READ_RE = /\b(understand|explain|review|inspect|trace|how (does|do)|what does)\b/i;
// An interrogative LEAD ("What …?", "How …?", "Is …?") with no code-read verb signals
// a plain question. Anchored to the title start so an action task ("Build the X")
// — which may merely contain a question-y word — is NOT swallowed here.
const QUESTION_LEAD_RE = /^\s*(what|why|when|where|which|who|how|is|are|does|do|can|should)\b/i;

/**
 * Classify a task into one of the five intents from its title + description.
 * Deterministic + explainable. Order is load-bearing: debug/explore are matched
 * first (most specific); a leading-interrogative QUESTION is matched BEFORE the
 * broad write/read buckets so "What is the build command?" is a simple-question,
 * not a code-write (it merely contains the word "build").
 */
export function classifyIntent(task: { title: string; description: string }): Intent {
	const text = `${task.title}\n${task.description}`;
	if (DEBUG_RE.test(text)) return 'code-debug';
	if (EXPLORE_RE.test(text)) return 'deep-explore';
	// A question that LEADS the title and ends with '?' is a plain question (checked
	// before write/read so a stray action keyword in the question doesn't mis-bucket it).
	if (QUESTION_LEAD_RE.test(task.title) && task.title.includes('?')) return 'simple-question';
	if (READ_RE.test(text)) return 'code-read';
	if (WRITE_RE.test(text)) return 'code-write';
	// A non-leading question anywhere is still a question if no action verb matched.
	if (text.includes('?')) return 'simple-question';
	// Default: treat an unclassifiable task as a write (the most common agent job).
	return 'code-write';
}

/** Per-intent base weight — drives both complexity and the minimum capable tier. */
const INTENT_WEIGHT: Record<Intent, number> = {
	'simple-question': 0.1,
	'code-read': 0.3,
	'code-write': 0.55,
	'code-debug': 0.75,
	'deep-explore': 0.9
};

/**
 * Complexity in [0,1]: the intent base weight plus a small bump for a long task body
 * (more context to handle). Persisted on the routing_event for analytics + tiering.
 */
export function scoreComplexity(intent: Intent, task: { title: string; description: string }): number {
	const base = INTENT_WEIGHT[intent];
	const len = task.title.length + task.description.length;
	const lengthBump = Math.min(0.1, len / 5000); // up to +0.1 for a very long task
	return Math.max(0, Math.min(1, base + lengthBump));
}

// ── Tier selection (pure JS — §2.5) ─────────────────────────────────────────────
//
// Complexity → the CHEAPEST capable tier along the escalation order (Haiku→Sonnet→
// Opus, plus a `local` floor for trivial work). The escalation order is config-driven
// (agent-pool.escalation.order); `local` is prepended as the cheapest floor so a
// simple-question can route to the offline/$0 model.

/** Ordered cheapest→dearest tier names: local floor + the configured escalation order. */
function tierLadder(pool: AgentPool): string[] {
	const order = pool.escalation?.order ?? ['haiku', 'sonnet', 'opus'];
	const ladder = order.filter((t) => t in pool.tiers);
	// Prepend the `local` floor (cheapest) when present and not already in the order.
	if ('local' in pool.tiers && !ladder.includes('local')) ladder.unshift('local');
	return ladder;
}

/** Complexity → the minimum tier INDEX into the ladder a task needs. */
function minTierIndexFor(complexity: number, ladderLen: number): number {
	// Map [0,1] complexity onto ladder positions: trivial→floor, hardest→top.
	const idx = Math.floor(complexity * ladderLen);
	return Math.min(ladderLen - 1, Math.max(0, idx));
}

/** A tier's ModelSelection from the pool config. */
function selectionForTier(name: string, tier: Tier): ModelSelection {
	return { provider: tier.provider, modelId: tier.model, tier: name };
}

// ── Adaptive config (D-020 — TASK 2.12) ───────────────────────────────────────────
//
// The intent→bundle map and bundle→budgets derivation are OWNED by the config layer
// (config/load.ts: resolveAdaptiveConfig / bundleToBudgets) — the same module that
// validates the bundle shape at the boundary. Routing reuses them so the mapping lives
// in exactly one place (DRY) and a config-validated bundle is the only thing routing
// ever feeds to AgentRuntime. Intent is structurally a config IntentClass.

const adaptiveConfigFor = resolveAdaptiveConfig;
const budgetsFromConfig = (cfg: ConfigBundle): SpawnBudgets => bundleToBudgets(cfg);

// ── resolveRoute (the one entry — order is enforced here) ─────────────────────────

export interface ResolveRouteInput {
	db: Db;
	task: RouteTask;
	pool: AgentPool;
	orchestration: Orchestration;
	/**
	 * Provider health source — the providers single owner's `health()` surface (§2.5).
	 * resolveRoute READS this; it never probes a provider itself.
	 */
	providerHealth: () => Promise<ProviderHealth[]>;
	/** Explicit model override — when set it WINS and short-circuits (F-005). */
	override?: ModelSelection;
	/** Intent override (operator-forced); skips the keyword classifier when set. */
	intent?: Intent;
}

/**
 * Resolve a task to a ResolvedPlan through the canonical order and persist the
 * decision as a routing_event. The order is enforced top-to-bottom:
 *
 *   1. explicit override → method "explicit", short-circuit (F-005 — override wins)
 *   2. intent classify   → keyword classifier (or the supplied intent override)
 *   3. tier select       → complexity → cheapest capable tier on the ladder
 *   4. adaptive config   → D-020 bundle for the intent (thinking/retrieval depth)
 *   5. provider/health   → if the chosen tier's provider is DOWN, fall back (F-005)
 *      → fallback         to the cheapest HEALTHY tier; method becomes "fallback"
 *
 * Returns the plan; `routingEventId` is the persisted analytics record.
 */
export async function resolveRoute(input: ResolveRouteInput): Promise<ResolvedPlan> {
	const { db, task, pool, orchestration, providerHealth } = input;

	// ── 1. EXPLICIT OVERRIDE — wins, short-circuits the whole order (F-005). ──────
	if (input.override) {
		const intent = input.intent ?? classifyIntent(task); // recorded for analytics only
		const adaptiveConfig = adaptiveConfigFor(orchestration, intent);
		const reason = `explicit override → ${input.override.provider}/${input.override.modelId}`;
		const routingEventId = await writeRoutingEvent(db, {
			task: task.id,
			project: task.project,
			chosen: input.override,
			method: 'explicit',
			reason,
			intent,
			complexity: undefined, // no scoring on an override
			alternatives: []
		});
		return {
			model: input.override,
			intent,
			adaptiveConfig,
			budgets: budgetsFromConfig(adaptiveConfig),
			method: 'explicit',
			reason,
			complexity: undefined,
			alternatives: [],
			routingEventId
		};
	}

	// ── 2. INTENT CLASSIFY. ───────────────────────────────────────────────────────
	const intent = input.intent ?? classifyIntent(task);

	// ── 3. TIER SELECT (complexity → cheapest capable tier). ─────────────────────
	const complexity = scoreComplexity(intent, task);
	const ladder = tierLadder(pool);
	if (ladder.length === 0) {
		throw new Error('routing: no tiers configured in the agent pool');
	}
	const wantIdx = minTierIndexFor(complexity, ladder.length);
	const wantedTier = ladder[wantIdx];

	// ── 4. ADAPTIVE CONFIG (D-020). ───────────────────────────────────────────────
	const adaptiveConfig = adaptiveConfigFor(orchestration, intent);
	const budgets = budgetsFromConfig(adaptiveConfig);

	// ── 5. PROVIDER/HEALTH → FALLBACK (F-005). ───────────────────────────────────
	const health = await providerHealth();
	const upByProvider = new Map(health.map((h) => [h.provider, h.up]));
	const isUp = (providerName: string): boolean => upByProvider.get(providerName) ?? true; // unknown ⇒ assume up

	const alternatives: Array<Record<string, unknown>> = [];
	let chosenName = wantedTier;
	let method: RoutingMethod = 'tier'; // tiered by complexity; "classify" upgraded below
	let fellBack = false;

	// Walk UP the ladder from the wanted tier until a healthy provider is found (F-005).
	let idx = wantIdx;
	while (idx < ladder.length) {
		const name = ladder[idx];
		const tier = pool.tiers[name];
		if (isUp(tier.provider)) {
			chosenName = name;
			break;
		}
		alternatives.push({ tier: name, provider: tier.provider, reason: 'provider unhealthy' });
		fellBack = true;
		idx++;
	}
	if (idx >= ladder.length) {
		// Every tier at/above the wanted level is down — walk DOWN as a last resort.
		fellBack = true;
		for (let d = wantIdx - 1; d >= 0; d--) {
			const name = ladder[d];
			if (isUp(pool.tiers[name].provider)) {
				chosenName = name;
				idx = d;
				break;
			}
			alternatives.push({ tier: name, provider: pool.tiers[name].provider, reason: 'provider unhealthy' });
		}
	}

	const chosenTier = pool.tiers[chosenName];
	if (!isUp(chosenTier.provider)) {
		// No healthy provider anywhere — still emit a decision (honest state) so analytics
		// records the failed route; the orchestrator's launch will surface the error.
		fellBack = true;
	}

	const model = selectionForTier(chosenName, chosenTier);
	// method precedence: explicit (handled above) → fallback (health changed the pick)
	// → classify (intent-driven). A pure complexity-tier pick is reported as "classify"
	// since classification produced the intent that drove tiering (§2.5).
	method = fellBack ? 'fallback' : 'classify';

	const reason = fellBack
		? `fallback: ${wantedTier} provider unhealthy → ${chosenName} (intent ${intent}, complexity ${complexity.toFixed(2)})`
		: `classify ${intent} → complexity ${complexity.toFixed(2)} → tier ${chosenName}`;

	const routingEventId = await writeRoutingEvent(db, {
		task: task.id,
		project: task.project,
		chosen: model,
		method,
		reason,
		intent,
		complexity,
		alternatives
	});

	return {
		model,
		intent,
		adaptiveConfig,
		budgets,
		method,
		reason,
		complexity,
		alternatives,
		routingEventId
	};
}

// ── routing_event write (the analytics producer — §2.5 / DATA-MODEL §4.4) ─────────

export interface WriteRoutingEventInput {
	/** Task id (omitted ⇒ NONE for a task-less decision, e.g. chat routing). */
	task?: string;
	/** Project id (omitted ⇒ NONE). */
	project?: string;
	chosen: ModelSelection;
	method: RoutingMethod;
	/** Human-readable rationale (the WHY — carried v1 rule). */
	reason: string;
	/** Classified intent — recorded in the rationale + (folded) for analytics. */
	intent: Intent;
	complexity?: number;
	alternatives?: Array<Record<string, unknown>>;
}

/** Drop keys whose value is `undefined` so option<T> fields stay NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Persist one routing decision as a `routing_event` (DATA-MODEL §4.4). Routing is the
 * SOLE producer of this table (§2.5); analytics only queries it. Record-id links pass
 * the D-016 chokepoint and bind as StringRecordId; all values bind via $param; absent
 * optionals are OMITTED (§6.1). The `reason` carries the rationale; the intent is folded
 * into the reason so a routing_event is self-describing for the reports page. Returns the
 * new row id.
 */
export async function writeRoutingEvent(db: Db, input: WriteRoutingEventInput): Promise<string> {
	// Ensure the intent is present in the persisted rationale (self-describing record).
	const reason = input.reason.includes(input.intent)
		? input.reason
		: `[${input.intent}] ${input.reason}`;

	const chosen = omitUndefined({
		provider: input.chosen.provider,
		model_id: input.chosen.modelId,
		tier: input.chosen.tier
	});

	const content = omitUndefined({
		task: input.task ? link(input.task) : undefined,
		project: input.project ? link(input.project) : undefined,
		chosen,
		method: input.method,
		reason,
		complexity: input.complexity,
		alternatives: input.alternatives && input.alternatives.length ? input.alternatives : undefined
	});

	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE routing_event CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return String(rows[0].id);
}
