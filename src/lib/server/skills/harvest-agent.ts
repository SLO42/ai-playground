// SH-2 GO-LIVE — the PRODUCTION skill-harvest GENERATOR (SKILL-HARVEST-SPEC §"CAPTURE").
//
// The SH-2 capture seam in sessions/launch.ts takes an INJECTED `SkillHarvester` and, on a
// SUCCESSFUL (status==='done') CODE-WRITE session ONLY, offers it the SCREENED (D-026) session
// trajectory; a returned `ProposeSkillInput` is persisted through SH-1 `proposeSkill` (born 'open').
// Until now only TEST STUBS implemented that seam — NO production generator was wired, so no real
// proposal was ever drafted (the capture loop was dormant). This module is the production generator:
// it runs a BOUNDED read-only cheap-tier model session over the screened trajectory and returns a
// candidate skill draft (name/description/body/trigger_context/evidence) or `null` (decline).
//
// THE SEAM (mirrors pm-propose.ts makePmProposalAgent + create/agent.ts EXACTLY): the generator is a
// `SkillHarvester` — a `propose(ctx) => Promise<ProposeSkillInput | null>`. PRODUCTION
// (makeSkillHarvestAgent) runs a read-only cheap session via launchSession and parses its structured
// ```json output; UNIT TESTS inject a stub (no creds/network/spend). The raw model output crosses the
// agent trust boundary as `unknown`; parseHarvestOutput + the SH-1 proposeSkill contract are the
// boundaries that prove the shape before anything is written.
//
// INTEGRITY (all preserved — the seam's gates are NOT relaxed here):
//   • BEST-EFFORT (D-019 / F-014): a generator fault (env/timeout/non-'done' session/parse failure)
//     NEVER blocks or fails the driven session — launch.ts's seam try/catches the whole `propose`
//     call and swallows it. Here we surface the runtime's own failure UNSWALLOWED (subprocess
//     discipline: a non-'done' session names its status, never a phantom success) and let the seam
//     swallow it; we NEVER fabricate a draft on a failed generation (F-008 — null/throw, not a guess).
//   • SCREENED (D-026): the seam screens the trajectory BEFORE it reaches `ctx.transcriptText`, and
//     SH-1 proposeSkill re-screens every drafted field at the write boundary. This module never sees
//     a raw secret and never persists — it only drafts.
//   • NARROW TRIGGER: the trigger (successful done code-write only) lives in launch.ts; this generator
//     is only ever called for a qualifying session.
//   • BORN OPEN (G2/D-039): this module NEVER writes — launch.ts persists the draft via proposeSkill,
//     which forces status='open'. No self-promotion path exists here.
//   • BOUNDED SPEND: one read-only cheap-tier session per qualifying session-end (like the PM-proposal
//     / memory-review forks) — no new uncapped spend path; READ-ONLY tool allow-list (no write/exec).
//
// Boundary discipline (D-016): this module composes launchSession; it opens NO query surface and
// interpolates no id. The prompt is built from the (already-screened) ctx — pure, no I/O.

import type { Db } from '../db/client';
import type { EventBus } from '../events/bus';
import type { AgentRuntime, ModelSelection } from '../runtime/index';
import { launchSession, type LaunchInput, type SkillHarvester, type SkillHarvestContext } from '../sessions/launch';
import type { ProposeSkillInput } from './proposal';

// ── Bounds (bounded capture — a runaway draft cannot bloat a row; SH-1 re-bounds at persist) ─────────

/** Max length of a freetext field the generator may draft (SH-1's MAX_FREETEXT is the harder cap). */
const MAX_FREETEXT_CHARS = 20_000;
/** Max length of the kebab name (a skill id, not a paragraph — SH-1 reqKebabName re-validates). */
const MAX_NAME_CHARS = 80;
/** Max evidence refs a single draft may carry (SH-1's MAX_EVIDENCE_REFS is the harder cap). */
const MAX_EVIDENCE_REFS = 32;
/** Max length of one evidence ref. */
const MAX_EVIDENCE_REF_CHARS = 128;

// ── Named error (EVERY ERROR HAS A NAME) ─────────────────────────────────────────────────────────────

/**
 * The generator's structured output violated the harvest contract (un-parseable / wrong shape / a
 * declared field over a bound). NAMED so the seam's best-effort catch logs WHAT failed. A
 * DECLINE (no reusable procedure) is NOT an error — it returns `null`, never throws.
 */
export class SkillHarvestContractError extends Error {
	override readonly name = 'SkillHarvestContractError';
}

// ── Structured-output parsing (mirrors pm-propose.parsePmProposalOutput) ─────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
	return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Require a non-empty trimmed string, bounded; throw (named) on violation. */
function reqStr(v: unknown, field: string, max = MAX_FREETEXT_CHARS): string {
	if (typeof v !== 'string' || v.trim() === '') {
		throw new SkillHarvestContractError(`skill-harvest field '${field}' must be a non-empty string`);
	}
	const t = v.trim();
	if (t.length > max) {
		throw new SkillHarvestContractError(
			`skill-harvest field '${field}' is ${t.length} chars — exceeds the ${max}-char cap (bounded capture)`
		);
	}
	return t;
}

/** Validate one evidence ref: non-empty trimmed string, bounded (SH-1 re-validates + screens). */
function reqEvidenceRef(v: unknown, idx: number): string {
	if (typeof v !== 'string' || v.trim() === '') {
		throw new SkillHarvestContractError(`skill-harvest evidence[${idx}] must be a non-empty string`);
	}
	const t = v.trim();
	if (t.length > MAX_EVIDENCE_REF_CHARS) {
		throw new SkillHarvestContractError(
			`skill-harvest evidence[${idx}] is ${t.length} chars — exceeds the ${MAX_EVIDENCE_REF_CHARS}-char ref cap`
		);
	}
	return t;
}

/**
 * Parse the structured harvest output out of the agent's final summary text into a
 * {@link ProposeSkillInput} draft, OR `null` when the session established nothing reusable.
 *
 * Contract: the agent emits ONE fenced ```json block (the SAME carrier convention pm-propose +
 * create + pm-panel use), with an outermost-braces fallback so a fence-less honest reply still
 * parses. The DECLINE convention (the common case — most sessions harvest nothing) is an explicit
 * shape so a decline is never confused with a malformed output:
 *   • `{ "harvest": false }` (or `{ "skill": null }`) → `null` (honest decline, NOT an error).
 *   • `{ "harvest": true, "skill": { name, description, body, trigger_context, evidence? } }` → draft.
 *   • a bare object that already looks like a skill (`{ name, description, body, trigger_context }`)
 *     is also accepted as a draft (lenient envelope — the model may omit the wrapper).
 *
 * Shadow paths each fail LOUD with the channel named (never silence-as-success):
 *   • nil/empty text → SkillHarvestContractError ('EMPTY output');
 *   • text with no JSON block → SkillHarvestContractError ('no JSON block');
 *   • a JSON block that does not parse → SkillHarvestContractError ('malformed JSON');
 *   • a draft missing/blank a required field, or evidence not an array / over the cap → named throw.
 * `null`/empty/false-harvest are the ONLY non-error empties (F-008 — decline, never fabricate).
 */
export function parseHarvestOutput(text: string | null | undefined): ProposeSkillInput | null {
	if (!text || !text.trim()) {
		throw new SkillHarvestContractError('skill-harvest contract violated: the agent produced EMPTY output');
	}
	const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
	let candidate: string | undefined = fences.length > 0 ? fences[fences.length - 1] : undefined;
	if (candidate === undefined) {
		const first = text.indexOf('{');
		const last = text.lastIndexOf('}');
		if (first !== -1 && last > first) candidate = text.slice(first, last + 1);
	}
	if (candidate === undefined) {
		throw new SkillHarvestContractError('skill-harvest contract violated: no JSON block found in the agent output');
	}
	let raw: unknown;
	try {
		raw = JSON.parse(candidate);
	} catch (e) {
		throw new SkillHarvestContractError(
			`skill-harvest contract violated: the JSON block did not parse — ${(e as Error).message}`
		);
	}

	// ── Decline shapes (honest empty — F-008, the common case) ──
	if (raw == null) return null;
	if (!isObj(raw)) {
		throw new SkillHarvestContractError(
			`skill-harvest output must be an object (a draft or a decline) — got ${typeof raw}`
		);
	}
	// Explicit decline: { harvest:false } or { skill:null } or an empty object.
	if (raw.harvest === false) return null;
	if ('skill' in raw && (raw.skill === null || raw.skill === undefined) && raw.harvest !== true) return null;

	// Unwrap the envelope: prefer raw.skill when present, else the object itself (lenient).
	const skillObj: unknown = isObj(raw.skill) ? raw.skill : raw;
	if (!isObj(skillObj)) {
		throw new SkillHarvestContractError("skill-harvest 'skill' must be an object when present");
	}
	// A bare object with NO skill fields at all is a decline, not a malformed draft.
	const hasAnyField =
		skillObj.name !== undefined ||
		skillObj.description !== undefined ||
		skillObj.body !== undefined ||
		skillObj.trigger_context !== undefined;
	if (!hasAnyField) return null;

	// ── Draft shape — every required field validated (the trust boundary; SH-1 re-validates) ──
	const name = reqStr(skillObj.name, 'name', MAX_NAME_CHARS);
	const description = reqStr(skillObj.description, 'description');
	const body = reqStr(skillObj.body, 'body');
	const trigger_context = reqStr(skillObj.trigger_context, 'trigger_context');

	const rawEv = skillObj.evidence;
	let evidence: string[] | undefined;
	if (rawEv !== undefined && rawEv !== null) {
		if (!Array.isArray(rawEv)) {
			throw new SkillHarvestContractError("skill-harvest field 'evidence' must be an array when present");
		}
		if (rawEv.length > MAX_EVIDENCE_REFS) {
			throw new SkillHarvestContractError(
				`skill-harvest has ${rawEv.length} evidence refs — exceeds the ${MAX_EVIDENCE_REFS} cap (bounded capture)`
			);
		}
		evidence = rawEv.map((e, i) => reqEvidenceRef(e, i));
	}

	// NOTE: session/project are stamped server-side by launch.ts (it overrides any field the seam
	// supplies), so we intentionally do NOT set them here — the generator cannot forge provenance.
	return { name, description, body, trigger_context, ...(evidence ? { evidence } : {}) };
}

// ── Production agent leg (mirrors pm-propose.makePmProposalAgent) ────────────────────────────────────

/** Inputs the production skill-harvest generator needs beyond the per-session ctx. */
export interface SkillHarvestAgentDeps {
	db: Db;
	bus: EventBus;
	runtime: AgentRuntime;
	/** The agent slot id the read-only harvest session runs as. */
	agentId: string;
	/** Model selection (cheap tier; opus-everywhere resolves the same id). */
	model: ModelSelection;
}

/** The read-only tool allow-list for the harvest session (NO write/exec tools — D-018/F-008). */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/**
 * Build the prompt that instructs the harvest agent to look at the SCREENED trajectory and either
 * DRAFT one reusable skill or DECLINE. The trajectory is REFERENCE DATA (already D-026-screened);
 * the agent grounds the draft in it. Pure (no I/O). parseHarvestOutput + SH-1's contract/screen are
 * the only gates on the output — a hostile trajectory string cannot relax them.
 *
 * DECLINE-BY-DEFAULT is emphasized: most sessions establish NO reusable procedure (a one-off bug fix,
 * a feature with no transferable recipe). The agent must decline unless the session demonstrates a
 * GENERAL, REPLAYABLE procedure worth proposing to the operator (F-008 — decline, never invent).
 */
export function buildHarvestPrompt(ctx: SkillHarvestContext): { title: string; description: string } {
	const description = [
		`A coding session just completed SUCCESSFULLY. Review its screened trajectory below and decide:`,
		`did this session establish a GENERAL, REUSABLE procedure (a recipe another agent could replay on`,
		`a DIFFERENT task) that is worth proposing as a new skill? Most sessions do NOT — a one-off fix or`,
		`a task-specific change has nothing reusable. DECLINE unless there is a clear transferable procedure.`,
		``,
		`READ-ONLY: you scaffold nothing, you run nothing, you write nothing. You emit a contract only.`,
		`Reference ENV NAMES only (D-026) — never a literal secret. Take a position; do not hedge.`,
		``,
		`TASK THAT DROVE THE SESSION: ${ctx.taskTitle}`,
		``,
		`SCREENED TRAJECTORY (secrets already redacted; ground your draft + evidence in this):`,
		ctx.transcriptText,
		``,
		`Emit ONE fenced \`\`\`json block. To DECLINE (the common, correct answer when nothing is reusable):`,
		`{ "harvest": false }`,
		`To PROPOSE a skill:`,
		`{ "harvest": true, "skill": { "name": string (lower-kebab id, e.g. "retry-flaky-network-call"),`,
		`"description": string (one line — what the skill does), "body": string (the SKILL.md markdown — the`,
		`replayable steps), "trigger_context": string (WHEN this skill applies), "evidence": string[] (refs`,
		`grounding it — a file path, a transcript anchor; ≥0) } }`,
		`Propose AT MOST ONE skill — the single most reusable procedure, or decline.`
	].join('\n');
	return { title: `Skill harvest: ${ctx.taskTitle}`, description };
}

/**
 * Build a production {@link SkillHarvester} that runs the read-only cheap-tier session over the
 * screened trajectory and parses its structured output into a draft (or null). Surfaces the runtime's
 * own error (env/timeout/non-'done') UNSWALLOWED — never a phantom success (subprocess discipline).
 * The SH-2 seam in launch.ts is best-effort (D-019): it try/catches this whole call, so a throw here
 * NEVER fails the driven session — it is logged + swallowed there. A `null` return is an honest
 * decline (F-008 — most sessions harvest nothing).
 */
export function makeSkillHarvestAgent(deps: SkillHarvestAgentDeps): SkillHarvester {
	return {
		async propose(ctx: SkillHarvestContext): Promise<ProposeSkillInput | null> {
			const prompt = buildHarvestPrompt(ctx);
			const input: LaunchInput = {
				projectId: ctx.projectId,
				// No real task — a synthetic prompt task (D-013 shape), so nothing is written to `task`.
				promptTask: { id: `skill_harvest_${Date.now()}`, title: prompt.title, description: prompt.description },
				agentId: deps.agentId,
				model: deps.model,
				intent: 'deep-explore',
				budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
				// READ-ONLY: allow-list carries no write/exec tools (D-018). No skillHarvester is passed
				// onto THIS launch, so the harvest session can never recursively harvest itself.
				toolPolicy: { allow: [...READ_ONLY_TOOLS] }
			};
			const res = await launchSession({ db: deps.db, bus: deps.bus, runtime: deps.runtime, input });
			if (res.status !== 'done') {
				throw new SkillHarvestContractError(
					`skill-harvest session ended '${res.status}' (not 'done') — no draft produced. summary: ${res.summary}`
				);
			}
			return parseHarvestOutput(res.summary);
		}
	};
}
