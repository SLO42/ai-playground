// TASK 16.1 — the PM session seams (PM-SPEC §1/§2):
//
//   • assemblePmContext — the ONE assembly for the PM's three context layers (§2):
//     the operator-written CHARTER (durable, injected as fenced context — D-008/D-026,
//     never folded into the prompt as instructions), the plan macro, and the accumulated
//     typed PM memory. pmChat consumes it for every PM session; runPmReview consumes it
//     so every review pass runs over the same bundle (the seam the session-driven review
//     of PM-SPEC §3 plugs into). The fresh snapshot layer stays computed-per-action in
//     pm-review.ts (never stale, never assumed).
//
//   • resolvePmRoute — PM sessions route with the EXPLICIT {provider, model_id} override
//     from config/workforce.yaml pm.* (F-005: explicit wins, short-circuits classify/
//     tier/health entirely), recorded as a `routing_event` with method "explicit" and a
//     rationale naming the config source. The PM is the conductor, not a gauntleted
//     workforce role — its model choice is config, not certification (PM-SPEC §1).
//     F-005 also demands the explicit fallback branch: an unreadable workforce.yaml
//     falls back to the caller-supplied default, recorded honestly as method "fallback"
//     with the real reason — never a silent constant.

import { join } from 'node:path';
import type { Db } from '../db/client';
import { ConfigError, loadWorkforce } from '../config/index';
import { writeRoutingEvent } from '../routing/index';
import type { ModelSelection } from '../runtime/index';
import { getProject } from './repo';
import { getPm, listPmMemory } from './pm-repo';

// ── Context assembly (PM-SPEC §2 — charter + plan + memory, one manual) ───────────

/** One fenced context item (mirrors runtime ContextBundle items — D-026 fencing is
 *  applied by the runtime's prompt builder; these are the DATA payloads). */
export interface PmContextItem {
	text: string;
	citationId: string;
}

export interface PmContextBundle {
	/** Charter (when in force) FIRST, then the plan macro, then typed PM memory. */
	items: PmContextItem[];
	/** The charter text in force, or null — the honest signal for callers/surfaces. */
	charter: string | null;
}

/**
 * Assemble the PM's strategic context from LIVE rows (F-008): the hired PM's charter
 * (PM-SPEC §2 layer 1), the project plan macro, and recent typed PM memory. Every
 * layer degrades honestly — no PM / no charter / no plan / no memory simply omit
 * their items (shadow paths), never a fabricated placeholder.
 */
export async function assemblePmContext(
	db: Db,
	projectId: string,
	opts: { memoryLimit?: number } = {}
): Promise<PmContextBundle> {
	const [pm, project, memories] = await Promise.all([
		getPm(db, projectId),
		getProject(db, projectId),
		listPmMemory(db, projectId, { limit: opts.memoryLimit ?? 20 })
	]);

	const items: PmContextItem[] = [];
	const charter = pm?.charter?.trim() || null;

	// Layer 1 — the charter (operator directives; background DATA, never instructions).
	if (charter && pm) {
		items.push({
			text: `PM charter (operator-written directives for this project):\n${charter}`,
			citationId: pm.id
		});
	}

	// Layer 2 — the plan macro (purpose / vision / role / DoD), when set.
	if (project?.plan) {
		const p = project.plan;
		const planLine = [
			p.purpose ? `Purpose: ${p.purpose}` : '',
			p.long_term_vision ? `Vision: ${p.long_term_vision}` : '',
			p.role ? `Role: ${p.role}` : '',
			p.definition_of_done ? `Definition of done: ${p.definition_of_done}` : ''
		]
			.filter(Boolean)
			.join('\n');
		if (planLine) items.push({ text: planLine, citationId: 'plan' });
	}

	// Layer 3 — accumulated typed PM memory (append-only, D-015), newest first.
	for (const m of memories) {
		items.push({ text: `[${m.kind}] ${m.content}`, citationId: m.id });
	}

	return { items, charter };
}

// ── Explicit PM model route (PM-SPEC §1 / F-005) ───────────────────────────────────

export interface PmRoute {
	model: ModelSelection;
	/** "explicit" = the workforce.yaml override won; "fallback" = config unreadable. */
	method: 'explicit' | 'fallback';
	reason: string;
	/** The persisted routing_event id (analytics first-class). */
	routingEventId: string;
}

/**
 * Resolve the model a PM session runs on. Reads config/workforce.yaml `pm.{provider,
 * model_id}` and records the decision as a routing_event:
 *
 *   • config readable → the EXPLICIT override (F-005 short-circuit — no classify, no
 *     tiering, no health walk), method "explicit", reason naming the config key.
 *   • config missing/malformed → the caller-supplied `fallback` selection, method
 *     "fallback", reason carrying the real ConfigError message (F-008 — named error,
 *     never a silent constant). A malformed workforce.yaml must not brick PM chat;
 *     it is a routing preference, not a security gate.
 */
export async function resolvePmRoute(
	db: Db,
	projectId: string,
	opts: { configDir?: string; fallback: ModelSelection }
): Promise<PmRoute> {
	const configDir = opts.configDir?.trim() || process.env.CONFIG_DIR?.trim() || 'config';

	let model: ModelSelection;
	let method: 'explicit' | 'fallback';
	let reason: string;
	try {
		const wf = loadWorkforce(join(configDir, 'workforce.yaml'));
		model = { provider: wf.pm.provider, modelId: wf.pm.model_id };
		method = 'explicit';
		reason =
			`explicit override → ${model.provider}/${model.modelId} ` +
			'(config/workforce.yaml pm.model_id — PM-SPEC §1; F-005 short-circuit)';
	} catch (err) {
		const msg = err instanceof ConfigError ? err.message : (err as Error).message;
		model = opts.fallback;
		method = 'fallback';
		reason =
			`fallback: workforce.yaml unreadable (${msg}) → ` +
			`${model.provider}/${model.modelId} (the PM default)`;
	}

	const routingEventId = await writeRoutingEvent(db, {
		project: projectId,
		chosen: model,
		method,
		reason,
		// A PM chat/review turn is a strategic discussion — recorded for analytics only;
		// the explicit override never runs the classifier (F-005).
		intent: 'simple-question'
	});

	return { model, method, reason, routingEventId };
}
