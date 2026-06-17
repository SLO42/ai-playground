// server/create/plan.ts — the generative PLAN half of Create-with-AI (CREATE-SPEC §2.1-2.3, §3).
//
// NOTHING here touches disk or writes the DB. This module produces a CONFIRM-GATED, EPHEMERAL
// creation proposal: given a brief {name, description, hints?}, it runs a cheap-tier READ-ONLY
// agent (injected seam — mirrors how launchSession's backend is stubbed in tests) that returns a
// STRUCTURED proposal, validates it (anti-sycophancy §3 + D-026 no-secret-echo + D-039
// objective/purpose + defect_class enum), and mints a confirmToken (sha256 over the canonicalized
// proposal — the planEdit shape) the executor re-submits. The proposal is returned to the caller
// and re-submitted at execute; nothing is persisted (D-010: nothing touches disk before confirm).
//
// Honest (F-008): stack/layout derive from the brief+hints+reference, never fabricated. The agent
// MAY read a reference repo as PRIOR ART (read-only) for §2.1 greenfield-with-reference, but it
// generates a FRESH scaffold — NOT adoption (adopt is the scanner's job, fork 1 LOCKED greenfield).

import type { Db } from '../db/client';
import { listDefectClassVocabulary } from '../workforce/capability-match';
import { screen } from '../memory/screen';
import { stableStringify } from '../cc-config/index';
import { createHash } from 'node:crypto';
import { assertNoSycophancy, SycophancyError } from './anti-sycophancy';
import type { AdapterKind } from '../adapters/types';

// ── Brief (input) ───────────────────────────────────────────────────────────────

/** Optional hints that steer the generator (CREATE-SPEC §2 step 1). All optional. */
export interface CreateHints {
	/** Ecosystem hint, e.g. 'node' | 'rust' | 'python' (free text — the agent specializes). */
	ecosystem?: string;
	/** A reference repo URL to mine as PRIOR ART (read-only). Greenfield only — not adoption. */
	refRepoUrl?: string;
	/** Target platform hint, e.g. 'web' | 'cli' | 'github-pages'. */
	targetPlatform?: string;
}

/** The brief the operator submits (CREATE-SPEC §2 step 1). */
export interface CreateBrief {
	name: string;
	description: string;
	hints?: CreateHints;
}

// ── Proposal (output) ─────────────────────────────────────────────────────────────

/** The plan macro draft — Project-Plan-v3 shape (purpose/vision/role/DoD), DATA-MODEL §4.1. */
export interface PlanMacroDraft {
	purpose: string;
	vision: string;
	role: string;
	/** The project's Definition of Done (D-038-shaped, project-specific). */
	definition_of_done: string;
}

/**
 * A founding task draft (D-039 Act-with-Purpose): objective + purpose are MANDATORY — a task
 * with no stated purpose is rejected at validation, never born. 3-7 of these (fork 4 milestone-
 * level, LOCKED). These are DRAFTS — they become real `task` rows ONLY at execute (CA-2), not here.
 */
export interface FoundingTaskDraft {
	objective: string;
	purpose: string;
}

/** A deploy/publish target draft (D-037) — {adapterId, config}. config is env-NAMES only (D-026). */
export interface TargetDraft {
	kind: AdapterKind;
	adapterId: string;
	config: Record<string, unknown>;
}

/** Capability needs draft (workforce capability-match shape). defect_classes is enum-validated. */
export interface CapabilityNeedsDraft {
	languages: string[];
	frameworks: string[];
	defect_classes: string[];
}

/**
 * A clarifier (CREATE-SPEC §2 step 1 + §3): a position-taking question the agent asks ONLY where
 * the brief genuinely forks. 2-4 ONLY (G4: number wins over the must-not-interrogate rail). Each
 * states a POSITION and pairs it with its FALSIFIER — and contains ZERO banned phrases (§3).
 */
export interface Clarifier {
	/** The forking question. */
	question: string;
	/** The position the agent takes on the evidence in the brief (not a strawman). */
	position: string;
	/** The evidence that would change the position (CREATE-SPEC §3 — every position has one). */
	falsifier: string;
}

/** The structured proposal the agent returns (CREATE-SPEC §2.2). Ephemeral — never persisted here. */
export interface CreationProposal {
	/** The directory layout the FRESH scaffold will create (paths, relative to the project root). */
	dirLayout: string[];
	/** The stack + tooling the scaffold uses (derived from brief+hints+reference — F-008). */
	stack: string[];
	planMacro: PlanMacroDraft;
	/** 3-7 founding tasks (fork 4 milestone-level). Each carries objective+purpose (D-039). */
	foundingTasks: FoundingTaskDraft[];
	targetDrafts: TargetDraft[];
	capabilityNeeds: CapabilityNeedsDraft;
	/** Present only when PM-hire was requested (fork 3 default ON) — the charter seed text. */
	pmCharterDraft?: string;
	/** 2-4 position-taking clarifiers (§2 step 1 + §3). May be empty when the brief does not fork. */
	clarifiers: Clarifier[];
}

/**
 * The full, confirm-gated result CA-1 returns to the caller: the validated proposal + the brief it
 * was generated for (so the executor can detect a changed brief at confirm) + the confirmToken the
 * executor MUST re-submit. EPHEMERAL — nothing is on disk or in the DB.
 */
export interface CreationProposalEnvelope {
	brief: CreateBrief;
	proposal: CreationProposal;
	/** sha256 over the canonicalized {brief, proposal} (planEdit shape) — bound at execute. */
	confirmToken: string;
}

// ── The agent seam (stubbed in unit tests — no real spend) ─────────────────────────

/**
 * The generator seam: produces a RAW proposal from a brief. The PRODUCTION implementation
 * (`launchProposalAgent` below) runs a cheap-tier read-only session via launchSession; UNIT TESTS
 * inject a stub (mirroring how launchSession tests script the CcBackend — no creds, no network, no
 * spend). Returns `unknown` because it crosses the agent boundary — validateProposal is the trust
 * boundary that proves the shape before anything downstream sees it.
 */
export type ProposalGenerator = (brief: CreateBrief) => Promise<unknown>;

// ── Errors (EVERY ERROR HAS A NAME) ────────────────────────────────────────────────

/** The proposal the agent returned violated the structured contract (§2.2). */
export class ProposalContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProposalContractError';
	}
}

/** A draft referenced a literal secret value where only an env NAME is allowed (D-026). */
export class SecretEchoError extends Error {
	readonly field: string;
	constructor(message: string, field: string) {
		super(message);
		this.name = 'SecretEchoError';
		this.field = field;
	}
}

/** The brief changed between proposal and confirm; the confirmToken is stale (D-010 shape). */
export class StaleProposalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StaleProposalError';
	}
}

// Re-export so callers catch §3 violations from this module's surface too.
export { SycophancyError };

// ── Validation helpers ──────────────────────────────────────────────────────────

const MIN_FOUNDING_TASKS = 3;
const MAX_FOUNDING_TASKS = 7;
const MIN_CLARIFIERS = 0; // a brief that does not fork asks zero.
const MAX_CLARIFIERS = 4; // G4: the number cap wins over interrogation.

function isObj(v: unknown): v is Record<string, unknown> {
	return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Require a non-empty trimmed string at `field`; throw ProposalContractError naming the field. */
function reqStr(v: unknown, field: string): string {
	if (typeof v !== 'string' || v.trim() === '') {
		throw new ProposalContractError(`proposal field '${field}' must be a non-empty string`);
	}
	return v;
}

/** Require an array of non-empty strings; throw naming the field. Shadow path: non-array → throw. */
function reqStrArray(v: unknown, field: string): string[] {
	if (!Array.isArray(v)) {
		throw new ProposalContractError(`proposal field '${field}' must be an array of strings`);
	}
	return v.map((x, i) => reqStr(x, `${field}[${i}]`));
}

/**
 * D-026 secret-echo guard for a config blob: EVERY string value (recursively) is screened; if
 * screen() REDACTS it (status not 'clean'), a literal secret was echoed where only an env NAME is
 * allowed — reject with SecretEchoError (NAMED) instead of silently storing a redaction. This is
 * stricter than "redact and continue" on purpose: a scaffold config that names a value rather than
 * an env var is a brief/agent bug to surface, not to paper over.
 */
function assertNoSecretEcho(value: unknown, path: string): void {
	if (typeof value === 'string') {
		const res = screen(value);
		if (res.status !== 'clean') {
			throw new SecretEchoError(
				`proposal '${path}' echoes a literal secret (D-026: config references env NAMES only) — ` +
					`screen reasons: [${res.reasons.join(', ')}]`,
				path
			);
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((v, i) => assertNoSecretEcho(v, `${path}[${i}]`));
		return;
	}
	if (isObj(value)) {
		for (const [k, v] of Object.entries(value)) assertNoSecretEcho(v, `${path}.${k}`);
	}
	// numbers/booleans/null pass through.
}

function validatePlanMacro(raw: unknown): PlanMacroDraft {
	if (!isObj(raw)) throw new ProposalContractError("proposal 'planMacro' must be an object");
	return {
		purpose: reqStr(raw.purpose, 'planMacro.purpose'),
		vision: reqStr(raw.vision, 'planMacro.vision'),
		role: reqStr(raw.role, 'planMacro.role'),
		definition_of_done: reqStr(raw.definition_of_done, 'planMacro.definition_of_done')
	};
}

function validateFoundingTasks(raw: unknown): FoundingTaskDraft[] {
	if (!Array.isArray(raw)) {
		throw new ProposalContractError("proposal 'foundingTasks' must be an array");
	}
	// fork 4 (LOCKED): milestone-level, 3-7.
	if (raw.length < MIN_FOUNDING_TASKS || raw.length > MAX_FOUNDING_TASKS) {
		throw new ProposalContractError(
			`proposal 'foundingTasks' must have ${MIN_FOUNDING_TASKS}-${MAX_FOUNDING_TASKS} tasks ` +
				`(milestone-level, fork 4) — got ${raw.length}`
		);
	}
	return raw.map((t, i) => {
		if (!isObj(t)) throw new ProposalContractError(`foundingTasks[${i}] must be an object`);
		// D-039: objective + purpose are MANDATORY — a purposeless task is never born.
		return {
			objective: reqStr(t.objective, `foundingTasks[${i}].objective`),
			purpose: reqStr(t.purpose, `foundingTasks[${i}].purpose`)
		};
	});
}

function validateTargetDrafts(raw: unknown): TargetDraft[] {
	if (!Array.isArray(raw)) {
		throw new ProposalContractError("proposal 'targetDrafts' must be an array");
	}
	const KINDS: AdapterKind[] = ['publish', 'deploy', 'sync'];
	return raw.map((t, i) => {
		if (!isObj(t)) throw new ProposalContractError(`targetDrafts[${i}] must be an object`);
		const kind = reqStr(t.kind, `targetDrafts[${i}].kind`) as AdapterKind;
		if (!KINDS.includes(kind)) {
			throw new ProposalContractError(
				`targetDrafts[${i}].kind '${kind}' is not a valid adapter kind (${KINDS.join('|')})`
			);
		}
		const adapterId = reqStr(t.adapterId, `targetDrafts[${i}].adapterId`);
		const config = isObj(t.config) ? t.config : {};
		// D-026: the config blob references env NAMES only — reject any literal secret echo.
		assertNoSecretEcho(config, `targetDrafts[${i}].config`);
		return { kind, adapterId, config };
	});
}

/**
 * Validate capabilityNeeds. defect_classes is ENUM-CLOSED against the operator-confirmed
 * vocabulary (the SAME guard setCapabilityNeeds enforces, §3 D4) — an unknown class is rejected
 * here so the proposal can never seed a need the workforce matcher will silently never satisfy.
 * languages/frameworks are free text (screened at the execute boundary, not here — this is a plan).
 *
 * Shadow path: empty arrays are honest (F-008) — a brief that declares no capability needs is valid.
 */
async function validateCapabilityNeeds(db: Db, raw: unknown): Promise<CapabilityNeedsDraft> {
	if (!isObj(raw)) {
		throw new ProposalContractError("proposal 'capabilityNeeds' must be an object");
	}
	const languages = reqStrArrayAllowEmpty(raw.languages, 'capabilityNeeds.languages');
	const frameworks = reqStrArrayAllowEmpty(raw.frameworks, 'capabilityNeeds.frameworks');
	const defect_classes = reqStrArrayAllowEmpty(raw.defect_classes, 'capabilityNeeds.defect_classes');

	if (defect_classes.length > 0) {
		const vocab = new Set(await listDefectClassVocabulary(db));
		const unknown = defect_classes.filter((c) => !vocab.has(c));
		if (unknown.length > 0) {
			throw new ProposalContractError(
				`proposal 'capabilityNeeds.defect_classes' contains class(es) not in the operator-confirmed ` +
					`vocabulary (§3 D4): [${unknown.join(', ')}]. A class only exists once an operator key uses it.`
			);
		}
	}
	return { languages, frameworks, defect_classes };
}

/** Like reqStrArray but tolerates an absent/empty array (honest empty — F-008). */
function reqStrArrayAllowEmpty(v: unknown, field: string): string[] {
	if (v === undefined || v === null) return [];
	return reqStrArray(v, field);
}

function validateClarifiers(raw: unknown): Clarifier[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new ProposalContractError("proposal 'clarifiers' must be an array");
	}
	// G4: 0-4 ONLY. The must-not-interrogate rail wins — more than 4 is interrogation.
	if (raw.length < MIN_CLARIFIERS || raw.length > MAX_CLARIFIERS) {
		throw new ProposalContractError(
			`proposal 'clarifiers' must have ${MIN_CLARIFIERS}-${MAX_CLARIFIERS} entries ` +
				`(G4: must-not-interrogate) — got ${raw.length}`
		);
	}
	return raw.map((c, i) => {
		if (!isObj(c)) throw new ProposalContractError(`clarifiers[${i}] must be an object`);
		return {
			question: reqStr(c.question, `clarifiers[${i}].question`),
			position: reqStr(c.position, `clarifiers[${i}].position`),
			// §3: every position carries its falsifier.
			falsifier: reqStr(c.falsifier, `clarifiers[${i}].falsifier`)
		};
	});
}

/**
 * Validate the raw agent output into a typed CreationProposal — the TRUST BOUNDARY. Every field
 * is shape-checked (ProposalContractError, named), then the cross-cutting rails run:
 *   • D-026 no-secret-echo across every target config (SecretEchoError, named);
 *   • §3 anti-sycophancy across EVERY agent-authored string (dirLayout + stack + plan macro +
 *     charter + task objectives/purposes + clarifiers) — assertNoSycophancy throws
 *     SycophancyError (named).
 *
 * Shadow paths: nil → throw (named); empty object → throw on the first missing required field.
 */
export async function validateProposal(db: Db, raw: unknown): Promise<CreationProposal> {
	if (!isObj(raw)) {
		throw new ProposalContractError(
			`proposal must be an object (the agent returned ${raw === null ? 'null' : typeof raw})`
		);
	}

	const dirLayout = reqStrArray(raw.dirLayout, 'dirLayout');
	if (dirLayout.length === 0) {
		throw new ProposalContractError("proposal 'dirLayout' must be non-empty (F-008: derive from the brief)");
	}
	const stack = reqStrArray(raw.stack, 'stack');
	if (stack.length === 0) {
		throw new ProposalContractError("proposal 'stack' must be non-empty (F-008: derive from the brief)");
	}
	const planMacro = validatePlanMacro(raw.planMacro);
	const foundingTasks = validateFoundingTasks(raw.foundingTasks);
	const targetDrafts = validateTargetDrafts(raw.targetDrafts);
	const capabilityNeeds = await validateCapabilityNeeds(db, raw.capabilityNeeds);
	const clarifiers = validateClarifiers(raw.clarifiers);

	let pmCharterDraft: string | undefined;
	if (raw.pmCharterDraft !== undefined && raw.pmCharterDraft !== null) {
		pmCharterDraft = reqStr(raw.pmCharterDraft, 'pmCharterDraft');
	}

	// §3 ANTI-SYCOPHANCY across EVERY agent-authored string. One pass, named SycophancyError.
	// dirLayout[] and stack[] are agent-authored descriptive free-text too, so they are screened
	// here alongside the macro/charter/tasks/clarifiers — "EVERY agent-authored string" is the
	// contract, and a hedge in a stack/dirLayout entry must not slip past to the operator.
	const authored: (string | undefined)[] = [
		...dirLayout,
		...stack,
		planMacro.purpose,
		planMacro.vision,
		planMacro.role,
		planMacro.definition_of_done,
		pmCharterDraft,
		...foundingTasks.flatMap((t) => [t.objective, t.purpose]),
		...clarifiers.flatMap((c) => [c.question, c.position, c.falsifier])
	];
	assertNoSycophancy(authored);

	return {
		dirLayout,
		stack,
		planMacro,
		foundingTasks,
		targetDrafts,
		capabilityNeeds,
		pmCharterDraft,
		clarifiers
	};
}

// ── confirmToken (planEdit sha-over-content shape) ─────────────────────────────────

/**
 * Canonicalize {brief, proposal} deterministically (recursively key-sorted JSON — the SAME
 * stableStringify cc-config's digest uses) and sha256 it. The token binds the confirm to BOTH the
 * brief and the exact proposed bytes, so a brief edited between propose and execute mismatches and
 * the executor re-validates (StaleProposalError) rather than scaffolding a stale plan (D-010 shape).
 */
export function computeConfirmToken(brief: CreateBrief, proposal: CreationProposal): string {
	const stable = stableStringify({ brief, proposal });
	return createHash('sha256').update(stable, 'utf8').digest('hex');
}

/**
 * Re-validate at the execute boundary that the brief+proposal the executor holds STILL hashes to
 * the token CA-1 issued. Throws StaleProposalError (NAMED) on a mismatch — the equivalent of
 * StaleConfirmError for the ephemeral (DB-less) create flow. Pure; no I/O.
 */
export function assertProposalFresh(
	brief: CreateBrief,
	proposal: CreationProposal,
	confirmToken: string
): void {
	const fresh = computeConfirmToken(brief, proposal);
	if (fresh !== confirmToken) {
		throw new StaleProposalError(
			'the brief or proposal changed since the proposal was generated — re-generate before confirming ' +
				'(D-010 shape): the confirm token no longer matches the canonicalized proposal.'
		);
	}
}

// ── The orchestration entry point (CA-1) ───────────────────────────────────────────

/**
 * Generate a confirm-gated creation proposal (CREATE-SPEC §2.1-2.3, §3). NOTHING touches disk or
 * the DB here (the only DB read is listDefectClassVocabulary for enum validation). The `generate`
 * seam runs the cheap-tier read-only agent (production: launchProposalAgent; tests: a stub).
 *
 * Sequence: run the agent → validateProposal (shape + D-026 + §3 + D-039 + enum) → mint the
 * confirmToken over the canonicalized {brief, proposal}. Returns the EPHEMERAL envelope.
 *
 * Shadow paths:
 *   • nil brief fields → reqStr inside validation throws ProposalContractError (named);
 *   • the agent returns empty/garbage → validateProposal throws (named), never a phantom proposal;
 *   • the agent leg errors (env/timeout) → the rejection propagates from `generate` with its own
 *     name (launchProposalAgent surfaces the runtime error) — never swallowed as success.
 */
export async function generateCreationProposal(
	db: Db,
	brief: CreateBrief,
	generate: ProposalGenerator
): Promise<CreationProposalEnvelope> {
	// Validate the brief itself at the boundary (SHADOW PATHS: nil/empty name or description).
	reqStr(brief.name, 'brief.name');
	reqStr(brief.description, 'brief.description');

	const raw = await generate(brief);
	const proposal = await validateProposal(db, raw);
	const confirmToken = computeConfirmToken(brief, proposal);
	return { brief, proposal, confirmToken };
}
