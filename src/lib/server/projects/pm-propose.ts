// PM-LC-1 — the PM proposal GENERATOR (PM-LIFECYCLE-SPEC.md §PM-LC-1; the missing GENERATE step).
//
// Today the PM VALIDATES proposals (pm-panel.ts runValidationPanel) but nothing GENERATES them.
// This module closes that gap: given a project, it gathers the project's LIVE strategic state —
// the plan macro (purpose/vision/role/DoD), the open tasks, the accumulated pm_memory
// (risks/patterns/learnings/observations/decisions), and the capability needs/gaps
// (recommendStaffing) — runs a PM agent session through an INJECTED `PmProposalGenerator` seam,
// and turns each returned proposal into a BORN-'proposed' task through the existing §4.1
// Act-with-Purpose chokepoint (proposeTask).
//
// THE SEAM (mirrors create/agent.ts exactly): the generator is a function (brief) => Promise<unknown>.
// PRODUCTION (makePmProposalAgent) runs a read-only cheap session via launchSession and parses its
// structured ```json output; UNIT TESTS inject a stub — NO creds, NO network, NO spend. The raw
// output crosses the agent trust boundary as `unknown`; validateProposalsOutput is the boundary that
// proves the shape before anything is written.
//
// REUSE, do not rebuild (integrity LOCKED): task creation goes through proposeTask (pm-proposals.ts),
// NOT a bare createTask. proposeTask is the SINGLE write chokepoint that enforces the §4.1 contract
// (objective/purpose/acceptance_criteria/provenance — D-039), the PM-authority precondition (no
// hired PM / observe-only PM → refused), the anti-spam ladder (duplicate absorb / defer suppression /
// open-proposal cap → pm_memory), and the structural fingerprint. This module GENERATES candidates;
// proposeTask is the gate every candidate passes. We NEVER promote anything (proposed is the born
// state; nothing here moves a task to ready — that is the lifecycle tick's 'act'-authority job).
//
// D-026 (screen at the writer boundary): every agent-authored freetext field (title / objective /
// purpose / acceptance_criteria) is run through screen() HERE, before it reaches proposeTask →
// createTask. A redactable span (email / home-path / known-prefix token) is stored as its SAFE
// screen().text ([REDACTED:*]); an un-redactable 'quarantined' block drops the whole candidate
// (F-008 honest — a half-redacted secret is never persisted). This mirrors create/execute.ts
// screenWriterText (the DB-bound chokepoint) — createTask persists RAW, so the screen MUST be here.
//
// F-008 honest empties: if the generator returns no proposals (a healthy project with no actionable
// gap), this creates ZERO tasks and returns an honest 'no actionable gaps' summary — it NEVER
// fabricates a task. Likewise a candidate that fails the contract or screen is DROPPED with a named,
// honest reason — never a half-specified row.
//
// Grounded / no-guessing (PM-LIFECYCLE-SPEC §PM-LC-1): the prompt instructs PROPOSE-FROM-EVIDENCE —
// the agent receives the REAL plan/memory/gap rows and must ground every proposal's provenance.
// evidence in those rows. The generator does not invent work the project context does not support.
//
// Boundary discipline (D-016): this module composes existing repos (getProject, listTasksByProject,
// listPmMemory, recommendStaffing, proposeTask); it opens NO new query surface and interpolates no id.

import type { Db } from '../db/client';
import type { EventBus } from '../events/bus';
import type { AgentRuntime } from '../runtime/index';
import { launchSession, type LaunchInput } from '../sessions/launch';
import { screen } from '../memory/screen';
import { getProject, type ProjectPlan } from './repo';
import { listTasksByProject, type TaskProvenance } from '../tasks/repo';
import { listPmMemory, type PmMemoryRow } from './pm-repo';
import { recommendStaffing } from '../workforce/capability-match';
import {
	proposeTask,
	ProposalContractError,
	type ProposeTaskResult,
	type ProposalOpts
} from './pm-proposals';

// ── Caps (bounded per tick — PM-LIFECYCLE-SPEC §PM-LC-1 "bounded by a max-proposals cap") ──────────
//
// The generator can emit any number of candidates; we bound how many a single tick will ATTEMPT to
// create so a runaway/adversarial generation cannot drive an unbounded write storm. The per-project
// OPEN-proposal cap (proposeTask's anti-spam ladder, default 2) is the harder downstream gate; this
// tick cap bounds the upstream attempt independently. Generous so a real tick is never clipped.

/** Max candidates a single tick will ATTEMPT (excess candidates are dropped with an honest note). */
export const MAX_PROPOSALS_PER_TICK = 5;

/** Cap a single freetext field's length before it is screened/stored (bounded capture). */
const MAX_FREETEXT_CHARS = 4000;
/** Cap acceptance-criteria count + per-item length (bounded capture). */
const MAX_ACCEPTANCE_CRITERIA = 12;

// ── Errors (EVERY ERROR HAS A NAME) ──────────────────────────────────────────────────────────────

/** The generator's structured output violated the contract (not parseable / wrong shape). */
export class PmProposalContractError extends Error {
	override readonly name = 'PmProposalContractError';
}

// ── The injected seam (stubbed in unit tests — NO spend) ───────────────────────────────────────────

/**
 * The brief the generator runs against — the LIVE strategic context, assembled from real rows
 * (F-008). The production agent leg serializes this into the prompt; a test stub may inspect it.
 */
export interface PmProposalBrief {
	projectId: string;
	projectName: string;
	plan: ProjectPlan;
	/** Honest counts/titles of the project's open (non-terminal) tasks — avoids re-proposing them. */
	openTasks: Array<{ id: string; title: string; status: string }>;
	/** The accumulated PM memory the proposals must be grounded in (risks/patterns/learnings/…). */
	memory: Array<{ id: string; kind: string; content: string }>;
	/** The capability gaps (HIRE recommendations) + REUSE/EXTEND candidates from recommendStaffing. */
	capabilityGaps: Array<{ defectClass: string; evidence: string }>;
	/** The single-best staffing posture line (honest summary of recommendStaffing). */
	staffingSummary: string;
}

/**
 * The generator seam: produce RAW proposal candidates from the brief. PRODUCTION
 * (makePmProposalAgent) runs a read-only cheap-tier session via launchSession; UNIT TESTS inject a
 * stub (no creds/network/spend — mirrors create/agent.ts ProposalGenerator). Returns `unknown`
 * because it crosses the agent boundary; validateProposalsOutput is the trust boundary.
 */
export type PmProposalGenerator = (brief: PmProposalBrief) => Promise<unknown>;

// ── Structured-output parsing (mirrors create/agent.ts parseProposalOutput) ─────────────────────────

/**
 * Parse the structured proposals JSON out of the agent's final summary text. Contract: the agent
 * emits ONE fenced ```json block (the SAME carrier convention pm-panel's verdict parser + create's
 * proposal parser use), with an outermost-braces fallback so a fence-less honest reply still parses.
 *
 * Shadow paths each fail LOUD with the channel named (never silence-as-success):
 *   • nil/empty text → PmProposalContractError ('EMPTY output');
 *   • text with no JSON block → PmProposalContractError ('no JSON block');
 *   • a JSON block that does not parse → PmProposalContractError ('malformed JSON').
 * The SHAPE is then proven by validateProposalsOutput — this only extracts the object.
 */
export function parsePmProposalOutput(text: string | null | undefined): unknown {
	if (!text || !text.trim()) {
		throw new PmProposalContractError('PM proposal contract violated: the agent produced EMPTY output');
	}
	const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
	let candidate: string | undefined = fences.length > 0 ? fences[fences.length - 1] : undefined;
	if (candidate === undefined) {
		const first = text.indexOf('{');
		const last = text.lastIndexOf('}');
		if (first !== -1 && last > first) candidate = text.slice(first, last + 1);
	}
	if (candidate === undefined) {
		throw new PmProposalContractError(
			'PM proposal contract violated: no JSON block found in the agent output'
		);
	}
	try {
		return JSON.parse(candidate);
	} catch (e) {
		throw new PmProposalContractError(
			`PM proposal contract violated: the JSON block did not parse — ${(e as Error).message}`
		);
	}
}

// ── Validation (the trust boundary) ─────────────────────────────────────────────────────────────

/** One validated proposal candidate, BEFORE the D-026 screen + the proposeTask contract gate. */
export interface PmProposalCandidate {
	title: string;
	objective: string;
	purpose: string;
	acceptance_criteria: string[];
	/** Real evidence row ids/refs grounding this proposal (no-guessing). */
	evidence: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
	return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Require a non-empty trimmed string, bounded; throw PmProposalContractError naming the field. */
function reqStr(v: unknown, field: string): string {
	if (typeof v !== 'string' || v.trim() === '') {
		throw new PmProposalContractError(`PM proposal field '${field}' must be a non-empty string`);
	}
	const t = v.trim();
	if (t.length > MAX_FREETEXT_CHARS) {
		throw new PmProposalContractError(
			`PM proposal field '${field}' is ${t.length} chars — exceeds the ${MAX_FREETEXT_CHARS}-char cap (bounded capture)`
		);
	}
	return t;
}

/**
 * Validate the raw generator output into typed candidates — the TRUST BOUNDARY. The agent returns
 * either an array of proposals, or an object with a `proposals` array, OR an object with an empty/
 * absent `proposals` (an HONEST "no actionable gaps" reply — F-008, NOT an error). Every candidate
 * is shape-checked (PmProposalContractError, named). The COUNT is bounded to MAX_PROPOSALS_PER_TICK
 * at the orchestration layer (we keep the first N + report the drop); here we accept any array and
 * let the caller bound it, so an over-long array is honestly truncated, not hard-failed.
 *
 * Shadow paths: nil → []; an object with no proposals key / empty array → [] (honest empty); a
 * non-array `proposals` → throw (named); a malformed candidate object → throw (named, indexed).
 */
export function validateProposalsOutput(raw: unknown): PmProposalCandidate[] {
	// Honest-empty shapes first: nil, or an object that simply has no proposals.
	if (raw == null) return [];
	let arr: unknown;
	if (Array.isArray(raw)) {
		arr = raw;
	} else if (isObj(raw)) {
		if (raw.proposals === undefined || raw.proposals === null) return []; // honest "no gaps"
		arr = raw.proposals;
	} else {
		throw new PmProposalContractError(
			`PM proposal output must be an array or an object with a 'proposals' array (got ${typeof raw})`
		);
	}
	if (!Array.isArray(arr)) {
		throw new PmProposalContractError("PM proposal field 'proposals' must be an array");
	}
	return arr.map((c, i): PmProposalCandidate => {
		if (!isObj(c)) {
			throw new PmProposalContractError(`PM proposal[${i}] must be an object`);
		}
		// acceptance_criteria: ≥1 non-empty string, bounded count + per-item length.
		const rawAc = c.acceptance_criteria;
		if (!Array.isArray(rawAc) || rawAc.length === 0) {
			throw new PmProposalContractError(
				`PM proposal[${i}].acceptance_criteria must be a non-empty array (a build agent must be able to execute against it)`
			);
		}
		if (rawAc.length > MAX_ACCEPTANCE_CRITERIA) {
			throw new PmProposalContractError(
				`PM proposal[${i}].acceptance_criteria has ${rawAc.length} items — exceeds the ${MAX_ACCEPTANCE_CRITERIA} cap (bounded capture)`
			);
		}
		const acceptance_criteria = rawAc.map((a, j) => reqStr(a, `proposal[${i}].acceptance_criteria[${j}]`));
		// evidence: ≥1 real ref (no-guessing — every proposal grounds in a real plan/memory/gap row).
		const rawEv = c.evidence;
		if (!Array.isArray(rawEv) || rawEv.length === 0) {
			throw new PmProposalContractError(
				`PM proposal[${i}].evidence must be a non-empty array of real refs (no-guessing — ground every proposal)`
			);
		}
		const evidence = rawEv.map((e, j) => reqStr(e, `proposal[${i}].evidence[${j}]`));
		return {
			title: reqStr(c.title, `proposal[${i}].title`),
			objective: reqStr(c.objective, `proposal[${i}].objective`),
			purpose: reqStr(c.purpose, `proposal[${i}].purpose`),
			acceptance_criteria,
			evidence
		};
	});
}

// ── D-026 writer-boundary screen ──────────────────────────────────────────────────────────────────

/** A field that was redacted at the writer boundary (honest, surfaced — never silent). */
export interface ScreenedField {
	field: string;
	reasons: string[];
}

/**
 * D-026 writer-boundary screen for an agent-authored DB-bound freetext value. createTask persists
 * the value RAW (it does NOT pass through writeFileMap/screen()), so the screen MUST happen HERE,
 * mirroring create/execute.ts screenWriterText (the canonical DB-bound chokepoint). A redactable span
 * (email / home-path / known-prefix provider key) is stored as the SAFE screen().text ([REDACTED:*]);
 * the collected reasons feed an honest, non-fatal note (F-008 — a redaction is visible).
 *
 * Returns the safe text + whether the value was QUARANTINED (an un-redactable secret block) — the
 * caller DROPS a candidate with any quarantined field (a half-redacted secret is never persisted).
 */
function screenWriterText(
	value: string,
	field: string,
	into: ScreenedField[]
): { text: string; quarantined: boolean } {
	const res = screen(value);
	if (res.status !== 'clean') into.push({ field, reasons: res.reasons });
	return { text: res.text, quarantined: res.status === 'quarantined' };
}

/**
 * Screen every freetext field of a candidate (D-026). Returns the screened candidate, or null when a
 * field quarantined (drop the candidate — F-008 honest, never a partially-redacted persisted row).
 */
function screenCandidate(
	c: PmProposalCandidate,
	idx: number,
	into: ScreenedField[]
): PmProposalCandidate | null {
	const title = screenWriterText(c.title, `proposal[${idx}].title`, into);
	const objective = screenWriterText(c.objective, `proposal[${idx}].objective`, into);
	const purpose = screenWriterText(c.purpose, `proposal[${idx}].purpose`, into);
	if (title.quarantined || objective.quarantined || purpose.quarantined) return null;
	const acceptance_criteria: string[] = [];
	for (let j = 0; j < c.acceptance_criteria.length; j++) {
		const ac = screenWriterText(c.acceptance_criteria[j], `proposal[${idx}].acceptance_criteria[${j}]`, into);
		if (ac.quarantined) return null;
		acceptance_criteria.push(ac.text);
	}
	return { title: title.text, objective: objective.text, purpose: purpose.text, acceptance_criteria, evidence: c.evidence };
}

// ── Brief assembly (live rows only — F-008) ─────────────────────────────────────────────────────

/** Trim a freetext line for the brief so one runaway memory row cannot bloat the prompt. */
function brief1Line(s: string, max = 280): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Assemble the LIVE strategic brief from real rows (F-008 — every field is a real read, never a
 * fabricated default). Open tasks are the non-terminal statuses (proposed/backlog/ready/in_progress/
 * review/blocked) so the agent does not re-propose work already in flight. Memory is the most recent
 * active rows (listPmMemory caps at 500). capabilityGaps are recommendStaffing's HIRE gaps.
 */
async function assembleBrief(db: Db, projectId: string): Promise<PmProposalBrief> {
	const project = await getProject(db, projectId);
	if (!project) {
		throw new PmProposalContractError(`project ${projectId} not found — cannot generate proposals`);
	}
	const NON_TERMINAL = ['proposed', 'backlog', 'ready', 'in_progress', 'review', 'blocked'] as const;
	const taskLists = await Promise.all(NON_TERMINAL.map((s) => listTasksByProject(db, projectId, s)));
	const openTasks = taskLists
		.flat()
		.map((t) => ({ id: t.id, title: t.title, status: t.status }));

	const memoryRows: PmMemoryRow[] = await listPmMemory(db, projectId, { limit: 60 });
	const memory = memoryRows.map((m) => ({ id: m.id, kind: m.kind, content: brief1Line(m.content) }));

	// recommendStaffing is honest-empty when no defect_classes are declared (fullyCovered:true).
	const staffing = await recommendStaffing(db, projectId);
	const capabilityGaps = staffing.gaps.map((g) => ({ defectClass: g.defectClass, evidence: g.evidence }));
	const staffingSummary = staffing.fullyCovered
		? capabilityGaps.length === 0
			? 'No declared capability gaps — staffing fully covered (or no defect classes declared).'
			: 'Declared needs fully covered by the catalog.'
		: `${capabilityGaps.length} capability gap(s) need a specialized hire; ${staffing.candidates.length} REUSE/EXTEND candidate(s) available.`;

	return {
		projectId,
		projectName: project.name,
		plan: project.plan ?? {},
		openTasks,
		memory,
		capabilityGaps,
		staffingSummary
	};
}

// ── Production agent leg (mirrors create/agent.ts makeProposalAgent) ────────────────────────────────

/** Inputs the production PM proposal agent needs beyond the brief. */
export interface PmProposalAgentDeps {
	db: Db;
	bus: EventBus;
	runtime: AgentRuntime;
	/** The agent slot id the read-only PM session runs as. */
	agentId: string;
	/** Model selection (opus-everywhere; cheap tier resolved by the caller's routing). */
	model: LaunchInput['model'];
	/** Optional synchronous session-id surface (live transcript key) — forwarded to launchSession. */
	onSessionCreated?: (sessionId: string) => void;
}

/** The read-only tool allow-list for the PM proposal session (NO write/exec tools — D-018/F-008). */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/**
 * Build the prompt that instructs the PM agent to PROPOSE-FROM-EVIDENCE (no-guessing). The brief's
 * live rows are serialized as REFERENCE DATA; the agent must ground every proposal's `evidence` in
 * those rows and emit ONE fenced ```json block. Pure (no I/O). The structured contract +
 * validateProposalsOutput + the D-026 screen downstream are the only gates on the output — a hostile
 * memory/plan string cannot relax them.
 */
export function buildPmProposalPrompt(brief: PmProposalBrief): { title: string; description: string } {
	const plan = brief.plan;
	const planLines = [
		plan.purpose ? `- purpose: ${brief1Line(plan.purpose, 500)}` : '',
		plan.long_term_vision ? `- vision: ${brief1Line(plan.long_term_vision, 500)}` : '',
		plan.role ? `- role: ${brief1Line(plan.role, 500)}` : '',
		plan.definition_of_done ? `- definition of done: ${brief1Line(plan.definition_of_done, 800)}` : ''
	].filter(Boolean);
	const openLines = brief.openTasks.map((t) => `- [${t.status}] ${t.title} (${t.id})`);
	const memLines = brief.memory.map((m) => `- (${m.kind}) ${m.content} [${m.id}]`);
	const gapLines = brief.capabilityGaps.map((g) => `- gap: ${g.defectClass} — ${g.evidence}`);

	const description = [
		`You are the Project Manager for "${brief.projectName}". Review the project's LIVE state below and`,
		`propose the NEXT actionable work. PROPOSE-FROM-EVIDENCE: every proposal MUST ground its`,
		`\`evidence\` array in the real row ids/refs shown below (a plan field, a pm_memory row id, a`,
		`capability gap class). DO NOT invent work the context does not support; if there is NO actionable`,
		`gap, return an empty proposals array — that is the correct, honest answer (never fabricate work).`,
		``,
		`READ-ONLY: you scaffold nothing, you run nothing. You emit a proposal contract only.`,
		``,
		planLines.length ? `PLAN MACRO:\n${planLines.join('\n')}` : 'PLAN MACRO: (none recorded)',
		``,
		brief.openTasks.length ? `OPEN TASKS (do NOT re-propose these):\n${openLines.join('\n')}` : 'OPEN TASKS: none.',
		``,
		brief.memory.length ? `PM MEMORY (risks/patterns/learnings/observations/decisions):\n${memLines.join('\n')}` : 'PM MEMORY: none recorded.',
		``,
		`STAFFING: ${brief.staffingSummary}`,
		brief.capabilityGaps.length ? `CAPABILITY GAPS:\n${gapLines.join('\n')}` : '',
		``,
		`Propose AT MOST ${MAX_PROPOSALS_PER_TICK} tasks. Emit ONE fenced \`\`\`json block of the shape:`,
		`{ "proposals": [ { "title": string, "objective": string (one clear objective), "purpose": string`,
		`(why this, why now — tie to the plan/DoD/a memory row/a gap), "acceptance_criteria": string[] (≥1,`,
		`what a build agent proves), "evidence": string[] (≥1 REAL ref from the rows above) } ] }`,
		`Config/values reference ENV NAMES only (D-026) — never a literal secret. Take positions; no hedging.`
	]
		.filter((l) => l !== '')
		.join('\n');
	return { title: `PM lifecycle proposals: ${brief.projectName}`, description };
}

/**
 * Build a production PmProposalGenerator that runs the read-only cheap-tier session and parses its
 * structured output. Surfaces the runtime's own error (env/timeout) UNSWALLOWED — never a phantom
 * success (subprocess discipline: a non-'done' session names its status, never reported as success).
 */
export function makePmProposalAgent(deps: PmProposalAgentDeps): PmProposalGenerator {
	return async (brief: PmProposalBrief): Promise<unknown> => {
		const prompt = buildPmProposalPrompt(brief);
		const input: LaunchInput = {
			projectId: brief.projectId,
			// No real task — a synthetic prompt task (D-013 shape), so nothing is written to `task`.
			promptTask: { id: `pm_propose_${Date.now()}`, title: prompt.title, description: prompt.description },
			agentId: deps.agentId,
			model: deps.model,
			intent: 'deep-explore',
			budgets: { thinking: 'high', toolCalls: 30, concurrency: 1 },
			// READ-ONLY: allow-list carries no write/exec tools (D-018).
			toolPolicy: { allow: [...READ_ONLY_TOOLS] }
		};
		const res = await launchSession({
			db: deps.db,
			bus: deps.bus,
			runtime: deps.runtime,
			input,
			...(deps.onSessionCreated ? { onSessionCreated: deps.onSessionCreated } : {})
		});
		if (res.status !== 'done') {
			throw new PmProposalContractError(
				`PM proposal session ended '${res.status}' (not 'done') — no proposals produced. summary: ${res.summary}`
			);
		}
		return parsePmProposalOutput(res.summary);
	};
}

// ── The orchestration entry point (PM-LC-1) ─────────────────────────────────────────────────────

export interface GeneratePmProposalsOpts {
	/** Config dir override forwarded to proposeTask (tests). */
	configDir?: string;
	/** Max candidates this tick attempts (default MAX_PROPOSALS_PER_TICK). */
	maxProposals?: number;
}

export interface GeneratePmProposalsResult {
	/** The per-candidate outcomes from proposeTask (created / duplicate_open / capped / defer_suppressed). */
	outcomes: ProposeTaskResult[];
	/** How many tasks were actually BORN 'proposed' this tick. */
	created: number;
	/** Honest, human-readable one-line summary of the tick (F-008 — never a fabricated count). */
	summary: string;
	/** Candidates DROPPED before proposeTask, each with a named reason (contract / screen / over-cap). */
	dropped: Array<{ reason: string }>;
	/** D-026 writer-boundary redactions performed (surfaced, non-fatal — never silent). */
	redactions: ScreenedField[];
}

/**
 * GENERATE PM proposals for a project (PM-LIFECYCLE-SPEC §PM-LC-1). Assembles the live brief, runs the
 * injected generator, validates + screens (D-026) + bounds (cap) the candidates, and creates each
 * through the proposeTask chokepoint (§4.1 contract + PM-authority + anti-spam). NEVER promotes a
 * task; NEVER fabricates work.
 *
 * Shadow paths (all four built + tested):
 *   • HAPPY: candidates → screened → proposeTask → 'created' outcomes + honest count.
 *   • NIL: generator returns null/undefined → zero candidates → zero tasks + honest 'no gaps' summary.
 *   • EMPTY: generator returns { proposals: [] } (or []) → same honest-empty path.
 *   • UPSTREAM ERROR: the generator throws (env/timeout/contract) → the named error PROPAGATES
 *     unswallowed (the caller — the lifecycle tick — records it honestly); a per-candidate contract/
 *     screen failure DROPS that candidate (named) without nuking the whole tick.
 *
 * proposeTask itself throws ProposalContractError when the project has NO hired PM or an observe-only
 * PM — that precondition is the caller's (the lifecycle tick gates on getPm/authority first); here it
 * propagates named so a misuse is loud, never a silent no-op.
 */
export async function generatePmProposals(
	db: Db,
	generate: PmProposalGenerator,
	projectId: string,
	opts: GeneratePmProposalsOpts = {}
): Promise<GeneratePmProposalsResult> {
	const cap = Math.max(1, Math.min(opts.maxProposals ?? MAX_PROPOSALS_PER_TICK, MAX_PROPOSALS_PER_TICK));
	const proposeOpts: ProposalOpts = opts.configDir ? { configDir: opts.configDir } : {};

	const brief = await assembleBrief(db, projectId);
	const raw = await generate(brief);
	const candidates = validateProposalsOutput(raw);

	// F-008 honest empty: no candidates → zero tasks, honest summary, never fabricate.
	if (candidates.length === 0) {
		return {
			outcomes: [],
			created: 0,
			summary: 'PM reviewed the project and found no actionable gaps — no proposals generated.',
			dropped: [],
			redactions: []
		};
	}

	const dropped: Array<{ reason: string }> = [];
	const redactions: ScreenedField[] = [];

	// Bound the attempt to the cap (over-cap candidates dropped with an honest note — bounded capture).
	const attempted = candidates.slice(0, cap);
	for (let i = cap; i < candidates.length; i++) {
		dropped.push({ reason: `over the per-tick cap of ${cap} (candidate ${i + 1} of ${candidates.length})` });
	}

	const outcomes: ProposeTaskResult[] = [];
	for (let i = 0; i < attempted.length; i++) {
		// D-026 — screen every freetext field at the writer boundary BEFORE proposeTask → createTask.
		const screened = screenCandidate(attempted[i], i, redactions);
		if (!screened) {
			dropped.push({ reason: `proposal[${i}] dropped — an un-redactable secret (quarantined) in a freetext field (D-026)` });
			continue;
		}
		const provenance: TaskProvenance = {
			kind: 'pm_lifecycle',
			evidence: screened.evidence,
			detail: { generated_by: 'pm-propose', project: projectId }
		};
		try {
			const outcome = await proposeTask(
				db,
				{
					project: projectId,
					title: screened.title,
					objective: screened.objective,
					purpose: screened.purpose,
					acceptance_criteria: screened.acceptance_criteria,
					provenance
				},
				proposeOpts
			);
			outcomes.push(outcome);
		} catch (err) {
			// A per-candidate contract failure (e.g. proposeTask's authority/contract gate) DROPS that
			// candidate with a NAMED reason — it never nukes the whole tick. A non-contract error (DB
			// fault) re-throws so the tick fails honestly rather than masking it.
			if (err instanceof ProposalContractError) {
				dropped.push({ reason: `proposal[${i}] refused by proposeTask: ${err.message}` });
				continue;
			}
			throw err;
		}
	}

	const created = outcomes.filter((o) => o.outcome === 'created').length;
	const absorbed = outcomes.filter((o) => o.outcome === 'duplicate_open').length;
	const capped = outcomes.filter((o) => o.outcome === 'capped').length;
	const deferred = outcomes.filter((o) => o.outcome === 'defer_suppressed').length;
	const parts = [`${created} proposal(s) created`];
	if (absorbed) parts.push(`${absorbed} absorbed as already-open`);
	if (capped) parts.push(`${capped} held at the open-proposal cap`);
	if (deferred) parts.push(`${deferred} suppressed by an operator defer`);
	if (dropped.length) parts.push(`${dropped.length} dropped (see reasons)`);
	const summary =
		created === 0 && outcomes.length === 0
			? 'PM generated candidates but none survived the contract/screen — no proposals created (honest).'
			: `PM lifecycle proposal pass: ${parts.join('; ')}.`;

	return { outcomes, created, summary, dropped, redactions };
}
