// SPAWN-IDENTITY — the ONE table of purposeful names for the spawn seams that are NOT the
// orchestrator drain.
//
// THE DEFECT THIS CLOSES. `session.agent` (m0069) is the only agent identity a session row carries
// at birth. The orchestrator drain fills it from the agent-pool slot, which now carries a
// purposeful `name` (config/agent-pool.yaml). But SEVEN other seams call `launchSession` directly
// and pass a hard-coded pool slot id — five of them the literal `DEFAULT_AGENT` (`opus-1`). Live,
// that is `sonnet-1` × 26 and `opus-1` × 2: a MODEL TIER BUCKET standing in as an identity, which
// the standing operator rule (2026-07-26 — "a display name must convey PURPOSE, never
// tier/model/slot/id") classes as a defect of F-008 severity, and which clusters unrelated work
// under one node in the living scene (F-046 leaking into the UI).
//
// Each of those seams KNOWS exactly what it is — the skill harvester harvests skills, the panel
// validator judges a proposal. That knowledge was simply never written down anywhere the row could
// see. It is written down HERE, once, rather than as a literal at each call site: a per-site
// literal is the "degrading fallback chain" shape the operator called out, and it drifts.
//
// HONESTY (F-008). Every entry names work the seam ACTUALLY does — each is anchored to the module
// that spawns it (see `seam`). Nothing here is inferred, scored, or recommended: an agent identity
// that was GUESSED would be a fabricated attribution, which is precisely why no `specialist` is
// declared here (see `config/agent-pool.yaml`'s note — the spawn argv carries no agent directive,
// so `session.specialist` may only record a DELIBERATE routing decision, never a heuristic one).
//
// WHAT IS PERSISTED. `name` → `session.agent` (m0069, replacing the slot id, which is preserved on
// the spawn `agent_event.detail.agentSlot` so provenance is complete). `purpose` → that same
// event's `detail.agentPurpose` (analytics first-class: WHY this agent ran). There is no session
// column for the purpose and this change adds no migration.

/** One spawn seam's purposeful identity. Both fields are required — a half-named entry is worse
 *  than none, because a blank name silently falls back to the slot id at the launch boundary. */
export interface SpawnIdentity {
	/**
	 * The persisted `session.agent` value: a short, stable, human-readable handle for WHAT this
	 * agent is. Lowercase kebab-case so it reads the same as a `.claude/agents` name and a role
	 * slug. MUST NOT be a model tier, a provider, a pool-slot id, or an ordinal.
	 */
	readonly name: string;
	/** One sentence: what this agent exists to do. Prose — never used as a key or an id. */
	readonly purpose: string;
	/** The module that spawns it, so an entry can never drift from a real call site. */
	readonly seam: string;
}

/**
 * The purposeful identity of every non-drain spawn seam, keyed by a stable symbol.
 *
 * ADDING ONE: name the WORK, not the worker's model or rank; keep it distinct from every other
 * entry (two seams sharing a name merge into one node in the living scene, which is only correct
 * if they really are the same agent); and add the call site in the same commit — an entry with no
 * caller is dead config, and `spawn-identity.test.ts` asserts the shape but cannot assert intent.
 */
export const SPAWN_IDENTITIES = {
	/** Create-with-AI: drafts a brand-new project's charter, plan and founding tasks. */
	projectFounder: {
		name: 'project-founder',
		purpose: "Draft a new project's charter, plan and founding tasks from the operator's brief",
		seam: 'create/agent.ts'
	},
	/** The PM's autonomous proposal turn — what should this project do next. */
	pmPlanner: {
		name: 'pm-planner',
		purpose: 'Propose the next tasks for a project as its Project Manager',
		seam: 'projects/pm-propose.ts'
	},
	/** The PM's operator-facing strategy chat (a read-only discussion turn). */
	pmStrategist: {
		name: 'pm-strategist',
		purpose: "Answer the operator's strategy questions as the project's Project Manager",
		seam: 'routes/projects/[id]/+page.server.ts (talk-to-PM)'
	},
	/** One seat on the D-039 validation panel that judges a proposed task. */
	validationPanelist: {
		name: 'validation-panelist',
		purpose: 'Judge one proposed task against the validation-panel criteria (D-039)',
		seam: 'projects/pm-panel.ts'
	},
	/** SKILL-HARVEST-SPEC: reads a finished session's trajectory and may draft a skill proposal. */
	skillHarvester: {
		name: 'skill-harvester',
		purpose: "Read a finished session's trajectory and draft a reusable skill proposal",
		seam: 'skills/harvest-agent.ts'
	},
	/** The operator's manual "run this task now" control on the project command centre. */
	taskRunner: {
		name: 'task-runner',
		purpose: 'Run one operator-dispatched task end to end',
		seam: 'routes/projects/[id]/+page.server.ts (run-task)'
	}
} as const satisfies Record<string, SpawnIdentity>;

/** The stable keys of {@link SPAWN_IDENTITIES}. */
export type SpawnIdentityKey = keyof typeof SPAWN_IDENTITIES;

/**
 * The `LaunchInput` fragment for a seam — spread it next to `agentId`, which stays the RUNTIME key
 * (the isolated-config dir, the SpawnRequest) and is untouched:
 *
 * ```ts
 * input: { projectId, agentId: DEFAULT_AGENT, ...spawnIdentity('skillHarvester'), … }
 * ```
 *
 * Returns BOTH fields always — every entry is validated non-blank by `spawn-identity.test.ts`, so
 * there is no partial shape to guard against here. An unknown key is a TypeScript error, not a
 * runtime fallback: a silently-unnamed spawn is the defect this module exists to prevent.
 */
export function spawnIdentity(key: SpawnIdentityKey): { agentName: string; agentPurpose: string } {
	const entry = SPAWN_IDENTITIES[key];
	return { agentName: entry.name, agentPurpose: entry.purpose };
}
