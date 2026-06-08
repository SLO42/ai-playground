// TASK 5.1 — per-task capability provisioning (D-036; depends on: 2.11/2.12, 1.4, 1.8).
//
// The intent→config bundle (orchestration.yaml, D-020) carries a `capabilities`
// block — an explicit, ALLOW-LISTED `{ skills:[], agents:[], mcp:[] }` selection drawn
// from the cc-config CATALOG (the cc_* mirror, 1.8/2.11). This module is the PURE
// composer: given a declared capability set, the catalog id-set, and the harness base
// settings, it returns the isolated session's settings = harness-base ⊕ the capability
// set. NO DB, NO spawn, NO network here — the DB read of the catalog id-set happens at
// the boundary (cc-config/sync.catalogIds); this layer composes against the in-memory
// set so it stays deterministic + unit-testable against a fixture (same posture as 1.4).
//
// Two load-bearing invariants this module enforces (D-036 / D-002):
//   • CATALOG-VALIDATED, FAIL CLOSED — an unknown skill/agent/mcp id throws
//     CapabilityValidationError; we NEVER silently drop the bad id and keep the rest.
//   • ISOLATION PRESERVED — the composed settings carry EXACTLY the declared set onto
//     the harness base; `plugins`/`marketplaces` stay EMPTY (never the operator's whole
//     plugin soup — the S1/D-002 determinism guard). The capability set is additive DATA
//     describing which catalog entries the driven session may wield; it is NOT a channel
//     for inheriting operator config.
//
// Security note (proved in the gate tests): a capability set is data. It does not feed
// the gate evaluator (D-018/D-024) or permissions.deny (1.4a) — provisioned skills/MCP
// still issue ordinary tool calls that flow through the gate layer. A capability set can
// therefore never grant a tool the gates would deny.

/** A per-task capability selection from the bundle (D-036). All three lists allow-listed. */
export interface CapabilitySet {
	/** Skill ids (cc_skill.name) to provision into the driven session. */
	skills: string[];
	/** Agent ids (cc_agent.name) to provision. */
	agents: string[];
	/** MCP server ids (cc_mcp_server.name) to provision. */
	mcp: string[];
}

/** The validated id-set drawn from the cc-config mirror — the allow-list source of truth. */
export interface CapabilityCatalog {
	skills: ReadonlySet<string>;
	agents: ReadonlySet<string>;
	mcp: ReadonlySet<string>;
}

/** The harness's own base settings (gates/hooks) the capability set composes ONTO. */
export interface HarnessBase {
	gates?: Record<string, string>;
	hooks?: Record<string, string>;
}

/** The composed session settings: harness base + the validated capability set. */
export interface ComposedCapabilitySettings {
	gates: Record<string, string>;
	hooks: Record<string, string>;
	/** EXACTLY the declared, catalog-validated set (never the operator's whole plugin set). */
	capabilities: CapabilitySet;
	/** ALWAYS empty — the S1/D-002 isolation guard (no inherited operator plugins). */
	plugins: string[];
	/** ALWAYS empty — no inherited marketplaces. */
	marketplaces: string[];
	/** Open for forward-compat — structurally assignable to the runtime's HarnessSettings. */
	[k: string]: unknown;
}

/** Which catalog dimension an id failed validation against — for fail-closed telemetry. */
export type CapabilityKind = 'skill' | 'agent' | 'mcp';

/** Thrown when a declared capability id is not in the catalog (fail closed, D-036/D-016). */
export class CapabilityValidationError extends Error {
	override readonly name = 'CapabilityValidationError';
	constructor(
		readonly kind: CapabilityKind | 'shape',
		readonly id: string,
		message: string
	) {
		super(message);
	}
}

const EMPTY_SET: CapabilitySet = { skills: [], agents: [], mcp: [] };

/** Assert a value is a string array, failing closed (D-016 discipline) otherwise. */
function assertStringArray(v: unknown, kind: CapabilityKind): string[] {
	if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
		throw new CapabilityValidationError(
			'shape',
			kind,
			`capability "${kind}" must be a list of string ids (fail closed, D-036)`
		);
	}
	return v as string[];
}

/**
 * Validate one declared dimension against the catalog allow-list. EVERY id must be in
 * the catalog set; the FIRST unknown id throws (fail closed — we never silently drop a
 * bad id and provision the rest). Returns the validated ids verbatim (order preserved).
 */
function validateDimension(
	declared: string[],
	allowed: ReadonlySet<string>,
	kind: CapabilityKind
): string[] {
	for (const id of declared) {
		if (!allowed.has(id)) {
			throw new CapabilityValidationError(
				kind,
				id,
				`unknown ${kind} capability id "${id}" — not in the cc-config catalog (fail closed, D-036)`
			);
		}
	}
	return [...declared];
}

/**
 * Compose a driven session's settings as harness-base ⊕ the intent capability set.
 *
 * - An absent/undefined set composes to the EMPTY capability set (all-defaults) — never
 *   throws, so a bundle with no `capabilities` block still spawns (mirrors
 *   resolveAdaptiveConfig's empty-bundle default).
 * - Each declared id is CATALOG-VALIDATED against `catalog`; an unknown skill/agent/mcp
 *   id throws CapabilityValidationError (FAIL CLOSED — reject the whole compose).
 * - `plugins`/`marketplaces` are forced EMPTY (D-002 isolation — no operator-plugin bleed).
 */
export function composeCapabilities(
	set: CapabilitySet | undefined,
	catalog: CapabilityCatalog,
	base: HarnessBase
): ComposedCapabilitySettings {
	const src = set ?? EMPTY_SET;

	const skills = validateDimension(assertStringArray(src.skills, 'skill'), catalog.skills, 'skill');
	const agents = validateDimension(assertStringArray(src.agents, 'agent'), catalog.agents, 'agent');
	const mcp = validateDimension(assertStringArray(src.mcp, 'mcp'), catalog.mcp, 'mcp');

	return {
		gates: { ...(base.gates ?? {}) },
		hooks: { ...(base.hooks ?? {}) },
		capabilities: { skills, agents, mcp },
		// The S1/D-002 determinism guard — never inherit the operator's plugins/marketplaces.
		plugins: [],
		marketplaces: []
	};
}
