// TASK 16.4 — the validation-panel runner + operator decision briefs
// (PM-SPEC §4.2–§4.7; WORKFORCE-SPEC §8/§9; D-039).
//
// 1–2 INDEPENDENT validator sessions judge a 'proposed' task's purpose / spec /
// duplication / feasibility against the project plan + charter. This wave ships the
// §9 bootstrap bridge: INLINE-prompt validators (`validator_kind='inline'`, role
// fields NONE) — once the launch five pass their gauntlets, composition flips to
// catalog roles. Independence is identity-keyed (§4.4): each validator is its own
// session with no shared transcript, the PM is never a panelable identity, and no
// validator session has a write path to verdicts — the RUNNER (harness code, here)
// parses the session's verdict contract and writes the `panel_verdict` row (D-035).
//
// Mechanical closure (§2.2 + §4.5), all harness-side:
//   • any verdict classified `operator_challenge` → NOTHING auto-proceeds; a
//     decision brief (WORKFORCE §8 canonical format) goes to the operator — the
//     operator's direction is the DEFAULT, agents make the case for change;
//   • any `pushback` → the proposal returns to the PM; pushback reasons become
//     pm_memory (the PM learns its team's bar);
//   • all `approve` + pm.authority='act'  → task 'proposed' → 'ready' (taste-class
//     decisions proceed decided-but-VISIBLE: a notification row surfaces them);
//   • all `approve` + pm.authority='propose' → a proposal-gate brief — the operator
//     is the promotion authority the PM lacks.
//
// Verdict evidence rule (§4.3, G1): presence-claims must quote the motivating text
// verbatim; absence-claims name the expected artifact + the search proving absence.
// An evidence item the validator could not ground is folded in tagged
// "(unverified)" — kept, never silently dropped.

import { join } from 'node:path';
import type { Db } from '../db/client';
import type { EventBus } from '../events/bus';
import { ConfigError, loadOrchestration, loadWorkforce } from '../config/index';
import { launchSession, listSessionMessages } from '../sessions/index';
import type { AgentRuntime, ModelSelection, SpawnBudgets } from '../runtime/index';
import {
	getTask,
	listTasksByProject,
	setStatus,
	type TaskRow
} from '../tasks/repo';
import {
	addPanelVerdict,
	closeOpenPanelVerdictsForArtifact,
	closePanelVerdictOutcome,
	listPanelVerdictsForArtifact,
	type PanelClassification,
	type PanelVerdictRow
} from '../workforce/repo';
import {
	createDecisionBrief,
	getBrief,
	getOpenBriefForArtifact,
	markBriefDecided,
	BriefError,
	type BriefArtifactKind,
	type BriefChallenge,
	type DecisionBriefRow
} from './briefs';
import { addPmMemory, getPm, hasPmMemoryRelatedTo, type PmRow } from './pm-repo';
import { resolvePmRoute } from './pm-session';
import { parseCron, cronMatches } from './pm-triggers';
import { ProposalContractError } from './pm-proposals';
import { getProject } from './repo';
// PJH-1 (PROJECTS-SPEC §7) — the per-kind decide-effects the ONE operator brief surface routes
// through. Each is the kind's EXISTING gate/effect (F-055: route every gated state-change through
// the existing gate — NEVER re-implement one inline): cert_hire → the workforce hire path (its D-039
// B4 operator gate intact); repo_create → the RC-2 outward gate (via the proposal decide, F-050
// main-default normalization lives inside runRepoCreationGate). These are called ONLY from inside the
// per-brief ceremony lock below — the analytics + refusal policy stays here; the effect stays theirs.
import { applyHireDecision } from '../workforce/recruiter-hire';
import { applyRepoCreateDecision } from './repo-create-proposal';
import type { GitHubClient } from '../sync/gh-client';
import type { CommandRunner } from '../orchestrator/post-task';

// ── Named errors ──────────────────────────────────────────────────────────────────

/** The validator session violated the verdict output contract. The message names
 *  WHICH channel failed: empty output / no JSON block / schema-invalid verdict. */
export class ValidatorContractError extends Error {
	override readonly name = 'ValidatorContractError';
}

/** The panel runner was driven against an artifact it cannot judge. */
export class PanelInputError extends Error {
	override readonly name = 'PanelInputError';
}

// ── The verdict output contract (parsed in product code, never trusted raw) ───────

interface VerdictEvidence {
	claim: string;
	kind: 'presence' | 'absence';
	/** presence: the verbatim quote of the motivating artifact text (G1). */
	quote?: string;
	/** absence: the expected artifact + the search that proved absence (G1). */
	artifact?: string;
	search?: string;
}

export interface ValidatorVerdict {
	verdict: 'approve' | 'pushback';
	confidence: 'low' | 'medium' | 'high';
	classification: PanelClassification;
	reasons: string[];
	/** Anti-sycophancy: a position carries its falsifier (CREATE-SPEC §3 rules). */
	falsifier: string;
	evidence: VerdictEvidence[];
	/** Step-0 scope-challenge findings (§4.6) — may be honestly empty. */
	scope_findings?: string[];
	/** REQUIRED when classification='operator_challenge' (§4.5). */
	operator_challenge?: BriefChallenge;
}

const CONFIDENCES = ['low', 'medium', 'high'] as const;
const CLASSIFICATIONS = ['mechanical', 'taste', 'operator_challenge'] as const;

/**
 * Parse + schema-validate a validator session's verdict from its final output.
 * Shadow paths each fail LOUD with the channel named (never silence-as-success):
 * nil/empty text, text with no JSON block, JSON that is not the contract shape.
 */
export function parseValidatorVerdict(text: string | null | undefined): ValidatorVerdict {
	if (!text || !text.trim()) {
		throw new ValidatorContractError('verdict contract violated: the validator produced EMPTY output');
	}
	// Prefer the LAST fenced ```json block (the contract's required carrier); fall
	// back to the outermost braces so a fence-less but otherwise honest reply parses.
	const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
	const candidate =
		fences.length > 0
			? fences[fences.length - 1]
			: text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
	if (!candidate || !candidate.trim().startsWith('{')) {
		throw new ValidatorContractError(
			'verdict contract violated: no JSON verdict block found in the validator output'
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(candidate);
	} catch (err) {
		throw new ValidatorContractError(
			`verdict contract violated: verdict block is not valid JSON (${(err as Error).message})`
		);
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ValidatorContractError('verdict contract violated: verdict must be a JSON object');
	}
	const v = raw as Record<string, unknown>;
	const bad = (field: string, why: string): never => {
		throw new ValidatorContractError(`verdict contract violated: ${field} ${why}`);
	};
	if (v.verdict !== 'approve' && v.verdict !== 'pushback') bad('verdict', `must be approve|pushback (got ${JSON.stringify(v.verdict)})`);
	if (!CONFIDENCES.includes(v.confidence as never)) bad('confidence', 'must be low|medium|high');
	if (!CLASSIFICATIONS.includes(v.classification as never)) {
		bad('classification', 'must be mechanical|taste|operator_challenge (PM-SPEC §4.5)');
	}
	if (!Array.isArray(v.reasons) || v.reasons.length === 0 || v.reasons.some((r) => typeof r !== 'string' || !r.trim())) {
		bad('reasons', 'must be a non-empty string array (criteria are never bare checkmarks, §4.5)');
	}
	if (typeof v.falsifier !== 'string' || !v.falsifier.trim()) {
		bad('falsifier', 'is required (a position carries its falsifier — anti-sycophancy)');
	}
	const evidence: VerdictEvidence[] = [];
	if (v.evidence !== undefined) {
		if (!Array.isArray(v.evidence)) bad('evidence', 'must be an array when present');
		for (const e of v.evidence as unknown[]) {
			if (!e || typeof e !== 'object') bad('evidence[]', 'items must be objects');
			const item = e as Record<string, unknown>;
			if (typeof item.claim !== 'string' || (item.kind !== 'presence' && item.kind !== 'absence')) {
				bad('evidence[]', 'items need {claim, kind: presence|absence}');
			}
			evidence.push({
				claim: String(item.claim),
				kind: item.kind as 'presence' | 'absence',
				...(typeof item.quote === 'string' ? { quote: item.quote } : {}),
				...(typeof item.artifact === 'string' ? { artifact: item.artifact } : {}),
				...(typeof item.search === 'string' ? { search: item.search } : {})
			});
		}
	}
	let challenge: BriefChallenge | undefined;
	if (v.classification === 'operator_challenge') {
		const fields = ['operator_said', 'recommendation', 'why', 'context_we_might_be_missing', 'cost_if_wrong'] as const;
		const c = v.operator_challenge;
		if (!c || typeof c !== 'object' || Array.isArray(c)) {
			bad('operator_challenge', `payload must carry ${fields.join(', ')} (§4.5 — the brief needs all five)`);
		}
		const co = c as Record<string, unknown>;
		const built: Record<string, string> = {};
		for (const f of fields) {
			const val = co[f];
			if (typeof val !== 'string' || !val.trim()) {
				bad('operator_challenge', `payload must carry ${fields.join(', ')} (§4.5 — missing ${f})`);
			}
			built[f] = String(val);
		}
		challenge = built as unknown as BriefChallenge;
	}
	return {
		verdict: v.verdict as 'approve' | 'pushback',
		confidence: v.confidence as 'low' | 'medium' | 'high',
		classification: v.classification as PanelClassification,
		reasons: (v.reasons as string[]).map((r) => r.trim()),
		falsifier: (v.falsifier as string).trim(),
		evidence,
		...(Array.isArray(v.scope_findings)
			? { scope_findings: (v.scope_findings as unknown[]).map(String) }
			: {}),
		...(challenge ? { operator_challenge: challenge } : {})
	};
}

/** Fold a parsed verdict into the persisted reasons array. Evidence renders per the
 *  G1 rule; an item missing its grounding (no quote / no search) is tagged
 *  "(unverified)" — kept, never dropped (§4.3). The falsifier is persisted as a
 *  named line so brief assembly can recover it from absorbed rows. */
export function foldVerdictReasons(v: ValidatorVerdict): string[] {
	const out = [...v.reasons];
	for (const e of v.evidence) {
		if (e.kind === 'presence') {
			out.push(
				e.quote
					? `evidence(presence): "${e.quote}" — ${e.claim}`
					: `evidence(presence, unverified): ${e.claim} (no verbatim quote supplied)`
			);
		} else {
			out.push(
				e.artifact && e.search
					? `evidence(absence): expected ${e.artifact}; search: ${e.search} — ${e.claim}`
					: `evidence(absence, unverified): ${e.claim} (artifact/search not named)`
			);
		}
	}
	for (const s of v.scope_findings ?? []) out.push(`scope: ${s}`);
	out.push(`falsifier: ${v.falsifier}`);
	return out;
}

// ── The inline validator prompt core (§9 Lane-A bridge) ───────────────────────────

/** Build the validator's task prompt. The ARTIFACT + plan + charter ride as fenced
 *  reference context (D-026 — data, not instructions); the prompt carries the
 *  methodology + the output contract. */
export function buildValidatorPrompt(seat: number, panelSize: number): string {
	return [
		`You are independent validator ${seat} of ${panelSize} on a project-management validation panel.`,
		'A project-manager agent (the PM) proposed a task. Judge the PROPOSED TASK in the reference',
		'context against the project plan and the operator charter. You are reviewing a management',
		'artifact, not code. Work every criterion at full depth; "no concerns" on a criterion is valid',
		'only with one or two sentences of what you examined and why nothing was flagged.',
		'',
		'STEP 0 — scope challenge, reuse-first (before any other judgment):',
		'• What existing task/flow already partially or fully covers this? Duplication = pushback,',
		'  quoting the existing artifact verbatim.',
		'• What is the SMALLEST change set that achieves the stated objective? Flag deferrable scope.',
		'• Complexity tripwires are unarmed (null) unless armed values are shown in context — raise',
		'  complexity as an evidenced judgment finding, never a numeric verdict.',
		'',
		'THEN judge: purpose (why this, why now — does it tie to plan/charter/evidence?), spec',
		'(are the acceptance criteria executable by a build agent as written?), duplication (against',
		'the open-task list in context), feasibility (can this project realistically do it?).',
		'',
		'EVIDENCE RULE: a presence-claim ("duplicates task X") must quote the motivating text',
		'verbatim; an absence-claim ("no duplicate found", "criteria missing X") names the expected',
		'artifact and the search that proved absence. Tag anything you cannot ground "(unverified)".',
		'',
		'DECISION CLASS (classification field):',
		'• "mechanical" — one clearly right answer under the rails.',
		'• "taste" — reasonable people could disagree; decide, and record your recommendation.',
		'• "operator_challenge" — ONLY when the artifact runs against explicit operator direction',
		'  (charter text or a recorded operator instruction shown in context). You must then fill',
		'  operator_challenge with: operator_said (verbatim), recommendation, why,',
		'  context_we_might_be_missing, cost_if_wrong. The operator decides — never you.',
		'',
		'Anti-sycophancy: state a position and its falsifier. No hedge phrases.',
		'',
		'OUTPUT CONTRACT — end your reply with EXACTLY ONE fenced ```json block:',
		'```json',
		'{',
		'  "verdict": "approve" | "pushback",',
		'  "confidence": "low" | "medium" | "high",',
		'  "classification": "mechanical" | "taste" | "operator_challenge",',
		'  "reasons": ["<one line per criterion examined>"],',
		'  "falsifier": "<the strongest reason your verdict could be wrong>",',
		'  "evidence": [{"claim": "...", "kind": "presence", "quote": "..."} |',
		'               {"claim": "...", "kind": "absence", "artifact": "...", "search": "..."}],',
		'  "scope_findings": ["<step-0 findings, may be empty>"],',
		'  "operator_challenge": { "operator_said": "...", "recommendation": "...", "why": "...",',
		'                          "context_we_might_be_missing": "...", "cost_if_wrong": "..." }',
		'}',
		'```',
		'Omit operator_challenge unless classification is "operator_challenge". The JSON block is',
		'machine-parsed; an invalid block fails the panel run honestly.'
	].join('\n');
}

// ── Panel context assembly ────────────────────────────────────────────────────────

interface PanelContextItem {
	text: string;
	citationId: string;
}

async function assemblePanelContext(
	db: Db,
	task: TaskRow,
	pm: PmRow,
	opts: PanelRunOpts
): Promise<PanelContextItem[]> {
	const items: PanelContextItem[] = [];

	// The ARTIFACT under review (§4.1 fields verbatim — the panel judges THIS).
	items.push({
		text:
			`PROPOSED TASK (the artifact under review):\n` +
			`title: ${task.title}\n` +
			`objective: ${task.objective ?? '—'}\n` +
			`purpose: ${task.purpose ?? '—'}\n` +
			`acceptance criteria:\n${(task.acceptance_criteria ?? []).map((c, i) => `  ${i + 1}. ${c}`).join('\n')}\n` +
			`provenance: trigger=${task.provenance?.kind ?? '—'}; evidence=${(task.provenance?.evidence ?? []).join(', ') || '—'}`,
		citationId: task.id
	});

	// Charter (operator direction — the §4.5 Operator-Challenge reference text).
	if (pm.charter?.trim()) {
		items.push({
			text: `OPERATOR CHARTER (operator-written direction — treat as the operator's voice):\n${pm.charter.trim()}`,
			citationId: pm.id
		});
	}

	// Plan macro.
	const project = await getProject(db, task.project);
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
		if (planLine) items.push({ text: `PROJECT PLAN:\n${planLine}`, citationId: 'plan' });
	}

	// Duplication corpus: the project's live open tasks (bounded; excludes the artifact).
	const all = await listTasksByProject(db, task.project);
	const corpus = all
		.filter((t) => t.id !== task.id && t.status !== 'withdrawn' && t.status !== 'failed')
		.slice(0, 50)
		.map((t) => `• [${t.status}] ${t.id} — ${t.title}`);
	items.push({
		text:
			corpus.length > 0
				? `OPEN TASK LIST (duplication corpus — ${corpus.length} task(s)):\n${corpus.join('\n')}`
				: 'OPEN TASK LIST: no other open tasks (an honest empty corpus — duplication absence-claims should cite this list as the search).',
		citationId: 'tasks'
	});

	// Panel tunables (§4.6.3 — armed values or the honest unarmed statement).
	let scopeLine = 'panel.scope tripwires: max_files=unarmed(null), max_new_services=unarmed(null)';
	try {
		const wf = loadWorkforce(join(configDir(opts), 'workforce.yaml'));
		const fmt = (v: number | null) => (v === null ? 'unarmed(null)' : String(v));
		scopeLine = `panel.scope tripwires: max_files=${fmt(wf.panel.scope.max_files)}, max_new_services=${fmt(wf.panel.scope.max_new_services)}`;
	} catch {
		/* unreadable config = unarmed statement above (honest default) */
	}
	items.push({ text: `PANEL CONFIG:\n${scopeLine}`, citationId: 'workforce.yaml' });

	return items;
}

function configDir(opts: PanelRunOpts): string {
	return opts.configDir?.trim() || process.env.CONFIG_DIR?.trim() || 'config';
}

// ── The runner ────────────────────────────────────────────────────────────────────

export type PanelDecision = 'approved' | 'operator_gate' | 'pushback' | 'operator_challenge';

export interface PanelRunResult {
	decision: PanelDecision;
	task: TaskRow;
	verdicts: PanelVerdictRow[];
	/** The §8 brief created for operator_gate / operator_challenge decisions. */
	brief?: DecisionBriefRow;
	/** pm_memory rows written from pushback reasons (the PM learns its bar). */
	pushbackMemories: number;
}

export interface PanelRunOpts {
	/** 1 or 2 independent validators (PM-SPEC §4.2). Default 2. */
	validators?: 1 | 2;
	configDir?: string;
}

export interface PanelDeps {
	db: Db;
	bus: EventBus;
	runtime: AgentRuntime;
	/** Used when config/workforce.yaml is unreadable (recorded as a fallback route). */
	fallbackModel: ModelSelection;
	budgets: SpawnBudgets;
}

/**
 * Run the validation panel over one 'proposed' task: launch the validator sessions,
 * parse + record their verdicts, then close the panel mechanically (§2.2/§4.5).
 * Interrupt contract: verdicts already recorded for this artifact are ABSORBED —
 * a re-run after a crash launches only the missing seats, then decides.
 */
export async function runValidationPanel(
	deps: PanelDeps,
	taskId: string,
	opts: PanelRunOpts = {}
): Promise<PanelRunResult> {
	const { db, bus, runtime } = deps;
	const panelSize = opts.validators ?? 2;

	const task = await getTask(db, taskId);
	if (!task) throw new PanelInputError(`task not found: ${taskId}`);
	if (task.status !== 'proposed') {
		throw new PanelInputError(`task ${taskId} is '${task.status}' — the panel judges 'proposed' artifacts only`);
	}
	if (!task.objective || !task.purpose || !task.acceptance_criteria?.length || !task.provenance) {
		throw new ProposalContractError(
			`task ${taskId} lacks the §4.1 contract fields — not a reviewable proposal (was it created outside proposeTask?)`
		);
	}
	const pm = await getPm(db, task.project);
	if (!pm) throw new PanelInputError(`project ${task.project} has no hired PM — nothing to return a verdict to`);

	// Absorb prior seats (re-run convergence): only OPEN verdicts count — closed ones
	// belong to a finished prior campaign (e.g. a revision's 'revised' rows).
	const prior = (await listPanelVerdictsForArtifact(db, task.id)).filter((v) => v.outcome == null);
	const seatsToRun = Math.max(0, panelSize - prior.length);

	// In-memory payloads from THIS run (challenge briefs need the full §4.5 payload;
	// absorbed rows reconstruct from their persisted reasons).
	const parsedThisRun: ValidatorVerdict[] = [];

	if (seatsToRun > 0) {
		const context = await assemblePanelContext(db, task, pm, opts);
		const route = await resolvePmRoute(db, task.project, {
			...(opts.configDir ? { configDir: opts.configDir } : {}),
			fallback: deps.fallbackModel
		});
		for (let seat = prior.length + 1; seat <= panelSize; seat++) {
			const result = await launchSession({
				db,
				bus,
				runtime,
				input: {
					projectId: task.project,
					promptTask: {
						id: `panel:${task.id}:seat${seat}`,
						title: `Validation panel — ${task.title}`,
						description: buildValidatorPrompt(seat, panelSize)
					},
					agentId: `panel-validator-${seat}`,
					model: route.model,
					// A validation read is a judgment turn, not an edit turn.
					intent: 'simple-question',
					budgets: deps.budgets,
					toolPolicy: { allow: ['Read'] },
					context: { items: context }
				}
			});
			// Parse the verdict: the final summary first; else walk the persisted
			// transcript backwards for the last assistant text that parses.
			let verdict: ValidatorVerdict | null = null;
			let lastErr: ValidatorContractError | null = null;
			const candidates: string[] = [result.summary];
			const messages = await listSessionMessages(db, result.sessionId);
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === 'assistant') candidates.push(messages[i].content);
			}
			for (const c of candidates) {
				try {
					verdict = parseValidatorVerdict(c);
					break;
				} catch (err) {
					if (err instanceof ValidatorContractError) lastErr = err;
					else throw err;
				}
			}
			if (!verdict) {
				throw new ValidatorContractError(
					`validator seat ${seat} (session ${result.sessionId}) violated the verdict contract: ` +
						`${lastErr?.message ?? 'no parsable output'} — raw output preserved in the session transcript`
				);
			}
			parsedThisRun.push(verdict);
			await addPanelVerdict(db, {
				project: task.project,
				artifact: task.id,
				artifact_kind: 'task',
				validator_session: result.sessionId,
				validator_kind: 'inline', // §9 bridge — role fields stay NONE
				verdict: verdict.verdict,
				reasons: foldVerdictReasons(verdict),
				confidence: verdict.confidence,
				classification: verdict.classification
			});
		}
	}

	const verdicts = (await listPanelVerdictsForArtifact(db, task.id)).filter((v) => v.outcome == null);
	return decidePanel(db, task, pm, verdicts, parsedThisRun, panelSize);
}

/** The falsifier line persisted by foldVerdictReasons, recovered from a verdict row. */
function falsifierOf(v: PanelVerdictRow): string | null {
	for (let i = v.reasons.length - 1; i >= 0; i--) {
		if (v.reasons[i].startsWith('falsifier: ')) return v.reasons[i].slice('falsifier: '.length);
	}
	return null;
}

/** Mechanical panel closure (§2.2/§4.5) — pure policy over recorded rows. */
async function decidePanel(
	db: Db,
	task: TaskRow,
	pm: PmRow,
	verdicts: PanelVerdictRow[],
	parsed: ValidatorVerdict[],
	panelSize: number
): Promise<PanelRunResult> {
	const challenges = verdicts.filter((v) => v.classification === 'operator_challenge');
	const pushbacks = verdicts.filter((v) => v.verdict === 'pushback');
	const tastes = verdicts.filter((v) => v.classification === 'taste');

	// 1. Operator Challenge — NEVER auto-decided against the operator (§4.5).
	if (challenges.length > 0) {
		const payload =
			parsed.find((p) => p.operator_challenge)?.operator_challenge ??
			// Absorbed row: reconstruct honestly from the persisted verdict text.
			({
				operator_said: 'see the charter text quoted in the verdict reasons',
				recommendation: challenges[0].reasons[0] ?? 'see verdict reasons',
				why: challenges[0].reasons.join(' · '),
				context_we_might_be_missing: 'reconstructed from a persisted verdict — full payload was on the original run',
				cost_if_wrong: falsifierOf(challenges[0]) ?? '—'
			} satisfies BriefChallenge);
		const brief = await createDecisionBrief(db, {
			project: task.project,
			artifact: task.id,
			artifact_kind: 'task',
			classification: 'operator_challenge',
			ask: `The panel challenges your direction on "${task.title}" — keep your direction, or accept the change?`,
			issue:
				`${challenges.length} of ${verdicts.length} validator(s) flagged this proposal as running against ` +
				`operator direction. Your direction is the default; the agents make the case for change. ` +
				`Operator said: "${payload.operator_said}". Agents recommend: ${payload.recommendation}.`,
			completeness: panelCompleteness(verdicts, panelSize),
			effort: { apply: '—', wrongness: payload.cost_if_wrong || '—' },
			evidence: briefEvidence(task, verdicts),
			falsifier: payload.context_we_might_be_missing,
			options: [
				{
					id: 'reject',
					label: 'Keep your direction (reject the change)',
					pro: 'Your recorded direction stands unchanged; zero churn.',
					con: payload.cost_if_wrong || 'the panel’s concern goes unaddressed',
					recommended: 'Operator direction is the default — agents make the case for change, not the other way around (PM-SPEC §4.5).'
				},
				{
					id: 'approve',
					label: 'Accept the change (promote the proposal)',
					pro: payload.why || 'the agents’ case as recorded on the verdict',
					con: `Cost if your original direction was right: ${payload.cost_if_wrong || '—'}`
				},
				{
					id: 'defer',
					label: 'Defer',
					pro: 'Decide later with more evidence; the matter is suppressed for one cadence window.',
					con: 'The underlying trigger evidence remains unaddressed meanwhile.'
				}
			],
			net_tradeoff: 'Net: keeping your direction is free today; accepting trades that certainty for the panel’s case.',
			challenge: payload,
			fingerprint: task.proposal_fingerprint
		});
		return { decision: 'operator_challenge', task, verdicts, brief, pushbackMemories: 0 };
	}

	// 2. Pushback — returned to the PM; reasons become pm_memory (the PM learns).
	// Idempotent over panel re-runs (16.4 re-review DEFECT 3): absorbed seats
	// re-enter this closure, so each learning row is keyed by related_to = the
	// verdict id — a row already written for that verdict absorbs, never duplicates.
	if (pushbacks.length > 0) {
		let written = 0;
		for (const v of pushbacks) {
			if (await hasPmMemoryRelatedTo(db, v.id, 'validation-panel')) continue;
			await addPmMemory(db, {
				project: task.project,
				kind: 'learning',
				content:
					`Panel pushback on proposal "${task.title}" (${task.id}): ` +
					v.reasons.filter((r) => !r.startsWith('falsifier: ')).join(' · '),
				source: 'validation-panel',
				confidence: 0.9,
				importance: 6,
				related_to: v.id
			});
			written++;
		}
		return { decision: 'pushback', task, verdicts, pushbackMemories: written };
	}

	// 3. All approve.
	if (pm.authority === 'act') {
		const ready = (await setStatus(db, task.id, 'ready')) ?? task;
		// Taste decisions proceed decided-but-VISIBLE (§4.5): surface via the tray.
		if (tastes.length > 0) {
			await db.query(`CREATE notification CONTENT $content;`, {
				content: {
					message:
						`Panel approved "${task.title}" on a taste call (${tastes.length} verdict(s)) — ` +
						`recommendation recorded on the verdict row(s); see the PM tab proposals queue.`
				}
			});
		}
		return { decision: 'approved', task: ready, verdicts, pushbackMemories: 0 };
	}

	// authority 'propose' (or anything below 'act'): the operator holds the gate.
	const approveReason = `${verdicts.length}/${panelSize} validator(s) approved; PM authority is '${pm.authority}' — promotion is yours.`;
	const brief = await createDecisionBrief(db, {
		project: task.project,
		artifact: task.id,
		artifact_kind: 'task',
		classification: 'proposal_gate',
		ask: `Promote the panel-approved proposal "${task.title}" to ready?`,
		issue:
			`The PM proposed this task (trigger: ${task.provenance?.kind ?? '—'}) and the validation panel ` +
			`approved it ${verdicts.length}/${panelSize}. The PM's authority is '${pm.authority}', so the ` +
			`promotion decision is the operator's.`,
		completeness: panelCompleteness(verdicts, panelSize),
		effort: { apply: '—', wrongness: '—' },
		evidence: briefEvidence(task, verdicts),
		falsifier:
			verdicts.map(falsifierOf).find((f): f is string => !!f) ??
			'No falsifier line recovered from the panel verdicts (older rows) — treat approval cautiously.',
		options: [
			{
				id: 'approve',
				label: 'Promote to ready',
				pro: approveReason,
				con: 'A wrongly-scoped task enters the build queue and consumes a session.',
				recommended: approveReason
			},
			{
				id: 'reject',
				label: 'Reject (withdraw the proposal)',
				pro: 'Nothing enters the queue; the panel verdicts close overridden-by-operator (honest record).',
				con: 'The trigger evidence the PM cited remains unaddressed.'
			},
			{
				id: 'defer',
				label: 'Defer',
				pro: 'Re-asks after one cadence window; the structural fingerprint suppresses re-proposals meanwhile.',
				con: 'The proposal idles; its evidence may go stale.'
			}
		],
		net_tradeoff: 'Net: approving costs one build slot if wrong; rejecting costs the cited evidence going unworked.',
		fingerprint: task.proposal_fingerprint
	});
	return { decision: 'operator_gate', task, verdicts, brief, pushbackMemories: 0 };
}

/** Completeness from REAL panel rows (§8 — never fabricated). */
function panelCompleteness(verdicts: PanelVerdictRow[], expected: number) {
	return {
		validators: verdicts.length,
		expected,
		approve: verdicts.filter((v) => v.verdict === 'approve').length,
		pushback: verdicts.filter((v) => v.verdict === 'pushback').length
	};
}

/** 2–4 evidence links: the artifact + its verdict rows (real ids, bounded). */
function briefEvidence(task: TaskRow, verdicts: PanelVerdictRow[]): string[] {
	return [task.id, ...verdicts.map((v) => v.id)].slice(0, 4);
}

// ── Operator decision application (the /api/briefs write path) ───────────────────

export type BriefAction = 'approve' | 'reject' | 'defer';

/**
 * The operator asked for an action this brief KIND does not support — e.g. DEFER on an
 * approve/reject-only hire-gate (cert_hire) or repo-create brief. This is a client-side bad-action
 * (the surface HIDES the Defer control for those kinds; this is the server backstop), so the route
 * maps it to 400 — DISTINCT from a 409 state/authority refusal. It extends BriefError so every
 * existing `instanceof BriefError` catch still absorbs it (the route checks the subclass FIRST → 400).
 */
export class BriefActionError extends BriefError {
	// BriefError types `name` as the literal 'BriefError', so a subclass cannot RE-DECLARE the field to
	// a different literal (override-compat). Set it at runtime via the constructor instead — honest name,
	// no type conflict, and `instanceof BriefError` still absorbs it (the route checks the subclass first).
	constructor(message?: string) {
		super(message);
		(this as { name: string }).name = 'BriefActionError';
	}
}

/**
 * Options carried into a brief decision. Beyond configDir (task defer-window derivation), the
 * operator-gated kinds need their B4 inputs threaded through the ONE dispatcher (the route sets these
 * from the operator's loopback request, NEVER from agent text — the integrity wall):
 *   • operatorConfirmed — REQUIRED true for a cert_hire / repo_create APPROVE (fail-closed, no auto-effect).
 *   • staffingProposal / charterNote — OPTIONAL cert_hire staffing feed (screened downstream, D-026).
 *   • branch — OPTIONAL repo_create push branch (defaults 'main' inside the gate, F-050).
 *   • client / gitRunner — TEST SEAMS (repo_create only): inject stubbed gh/git so a routing test drives
 *     the gate with NO real network. Production callers omit them (mirrors ApplyRepoCreateInput).
 */
export interface BriefDecisionOpts {
	configDir?: string;
	operatorConfirmed?: boolean;
	staffingProposal?: string;
	charterNote?: string;
	branch?: string;
	client?: GitHubClient;
	gitRunner?: CommandRunner;
}

export interface BriefDecisionResult {
	/** Which artifact_kind's effect ran — the route renders per kind (a discriminated surface). */
	kind: BriefArtifactKind;
	brief: DecisionBriefRow;
	/** task: the artifact task's resulting status, when it changed. */
	taskStatus?: string;
	/** cert_hire: the hire effect's surface fields (from applyHireDecision). */
	hire?: {
		recommendation: 'hire' | 'no_hire';
		lifecycle: string;
		certFlipped: boolean;
		staffed?: boolean;
		staffId?: string;
	};
	/** repo_create: the RC-2 gate's surface fields (from applyRepoCreateDecision). */
	repo?: {
		created: boolean;
		failedAt?: string;
		summary?: string;
		repoUrl?: string;
	};
}

/** The documented defer fallback: pm-cadence-derived when a cadence is set, else
 *  the configured D-004 periodic interval, else one day (the conservative re-ask
 *  window — a named constant, surfaced on the brief row as defer_until). */
const FALLBACK_DEFER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The gap between the cadence's next two fires (bounded scan, 60 days), or null. */
export function cadenceWindowMs(cadence: string | undefined, from = new Date()): number | null {
	if (!cadence) return null;
	const spec = parseCron(cadence);
	if (!spec) return null;
	const fires: number[] = [];
	const start = new Date(from.getTime());
	start.setSeconds(0, 0);
	for (let i = 1; i <= 60 * 24 * 60 && fires.length < 2; i++) {
		const t = new Date(start.getTime() + i * 60_000);
		if (cronMatches(spec, t)) fires.push(t.getTime());
	}
	return fires.length === 2 ? fires[1] - fires[0] : null;
}

/**
 * The next future fire of a cadence cron as an ISO string (bounded forward scan, 60 days), or null
 * when the cadence is absent/unparseable or no fire lands inside the horizon. Honest (F-008): the loops
 * read model surfaces null as '—' rather than a fabricated time. Reuses the same minute-granular cron
 * machinery as {@link cadenceWindowMs} so "next fire" and "window" agree.
 */
export function nextCadenceFireAt(cadence: string | undefined, from = new Date()): string | null {
	if (!cadence) return null;
	const spec = parseCron(cadence);
	if (!spec) return null;
	const start = new Date(from.getTime());
	start.setSeconds(0, 0);
	for (let i = 1; i <= 60 * 24 * 60; i++) {
		const t = new Date(start.getTime() + i * 60_000);
		if (cronMatches(spec, t)) return t.toISOString();
	}
	return null;
}

function deferWindowMs(pm: PmRow | null, opts: { configDir?: string }): number {
	const fromCadence = cadenceWindowMs(pm?.cadence);
	if (fromCadence) return fromCadence;
	try {
		const dir = opts.configDir?.trim() || process.env.CONFIG_DIR?.trim() || 'config';
		const orch = loadOrchestration(join(dir, 'orchestration.yaml'));
		if (orch.intervalMs && orch.intervalMs > 0) return orch.intervalMs;
	} catch (err) {
		if (!(err instanceof ConfigError)) throw err;
	}
	return FALLBACK_DEFER_WINDOW_MS;
}

// In-process per-brief ceremony serialization (16.4 re-review gap 6). Probe-proven
// on the real engine: SurrealDB executes concurrent same-connection queries against
// snapshots — two status-guarded UPDATEs AND two THROW-guarded transactions on one
// open brief BOTH committed — so no query-level guard alone stops two simultaneous
// cross-action decides from both passing the status pre-check and running their
// effects. This module is the single decide write path (D-035 server-side), so a
// keyed promise chain serializes ceremonies per brief: the loser re-reads AFTER the
// winner committed and the pre-check refuses it with zero effects.
const briefLocks = new Map<string, Promise<void>>();

async function withBriefLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
	const prev = briefLocks.get(briefId) ?? Promise.resolve();
	const run = prev.then(fn);
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	briefLocks.set(briefId, tail);
	void tail.then(() => {
		if (briefLocks.get(briefId) === tail) briefLocks.delete(briefId);
	});
	return run;
}

/**
 * Apply the operator's answer to an OPEN brief — the single write path the
 * RightTray actions hit. Effects are mechanical (§2.2, D-035 server-side):
 *   approve → task 'proposed'→'ready'; pushback-verdicts close
 *             'overridden_by_operator' (the operator went past them); approve-
 *             verdicts stay open for the upheld-on-done closure.
 *   reject  → task → 'withdrawn'; approve-verdicts close 'overridden_by_operator',
 *             pushback-verdicts close 'upheld' (the rejection upheld them).
 *   defer   → brief deferred with a cadence-derived window; the task stays
 *             'proposed'; the structural fingerprint suppresses re-proposals.
 */
export async function applyBriefDecision(
	db: Db,
	briefId: string,
	action: BriefAction,
	opts: BriefDecisionOpts = {}
): Promise<BriefDecisionResult> {
	// Read ONCE to route on the (immutable) artifact_kind — this read only chooses the per-kind
	// handler; it NEVER gates an effect. The status pre-check that guards every effect is re-read
	// INSIDE the lock below (a pre-lock status read could be stale against a serialized winner).
	const routing = await getBrief(db, briefId);
	if (!routing) throw new BriefError(`decision brief not found: ${briefId}`);

	// Per-brief ceremony serialization across ALL kinds (16.4 gap 6, generalized to the whole decision
	// surface): two simultaneous cross-action decides on the SAME brief serialize here so the loser
	// re-reads the winner's committed status and refuses with ZERO effects — the operator-authority
	// invariant. The delegated cert_hire/repo_create effects run inside this lock too (their own
	// markBriefDecided status-guard is the durable backstop; the lock removes the interleave window).
	return withBriefLock(briefId, async () => {
		const brief = await getBrief(db, briefId);
		if (!brief) throw new BriefError(`decision brief vanished mid-decision: ${briefId}`);
		switch (brief.artifact_kind) {
			case 'task':
				return applyTaskBriefDecision(db, brief, action, opts);
			case 'cert_hire':
				return applyCertHireBriefDecision(db, brief, action, opts);
			case 'repo_create':
				return applyRepoCreateBriefDecision(db, brief, action, opts);
			case 'review_proposal':
			case 'fixture_proposal':
				// Declared brief kinds that are NEVER minted as operator briefs (grep-verified: these are
				// panel_verdict artifact kinds — a review/fixture PROPOSAL is JUDGED by a panel, not decided on
				// a brief) and carry NO built decide-effect. Honest unbuilt seam: a typed refusal names the gap;
				// never a crash, never a fake success (F-008).
				throw new BriefError(
					`brief ${briefId} targets '${brief.artifact_kind}' — that kind is a panel-verdict artifact, ` +
						`not an operator decision brief; it has no decide-effect and the decision surface refuses it honestly`
				);
			default:
				// Fail-closed on any future/unknown kind (D-024 spirit on the operator-authority surface):
				// never silently no-op, never crash — a typed refusal. The schema ASSERT admits only the kinds
				// handled above, so this is the defensive net for a kind added to the enum without a handler.
				throw new BriefError(
					`brief ${briefId} targets unknown artifact_kind '${String(brief.artifact_kind)}' — ` +
						`refusing (fail-closed decision surface: no decide-effect is wired for this kind)`
				);
		}
	});
}

// ── Per-kind decide handlers (each routes through the kind's EXISTING gate/effect) ────────────────

/**
 * TASK briefs — the panel-gated proposed→ready promotion (D-039 propose-authority path). Effects are
 * mechanical (§2.2, D-035 server-side); effect-first / ceremony-last so a crash between them converges
 * on re-POST (the brief stays OPEN until the ceremony write lands). Receives the FRESH in-lock brief.
 *   approve → task 'proposed'→'ready'; pushback-verdicts close 'overridden_by_operator'; approve-
 *             verdicts stay open for the upheld-on-done closure.
 *   reject  → task → 'withdrawn'; approve-verdicts close 'overridden_by_operator', pushback-verdicts
 *             close 'upheld' (the rejection upheld them).
 *   defer   → brief deferred with a cadence-derived window; the task stays 'proposed'; the structural
 *             fingerprint suppresses re-proposals.
 */
async function applyTaskBriefDecision(
	db: Db,
	brief: DecisionBriefRow,
	action: BriefAction,
	opts: { configDir?: string } = {}
): Promise<BriefDecisionResult> {
	const briefId = brief.id;
	const task = await getTask(db, brief.artifact);
	if (!task) throw new BriefError(`brief artifact vanished: ${brief.artifact}`);

	// 16.4 re-review fix (DEFECTS 1+2): the ceremony state is checked BEFORE any
	// effect. The effect-first reorder below is only safe when the ceremony cannot
	// refuse — markBriefDecided's relabel guard threw AFTER setStatus/verdict-closures
	// had already run, so a different-action POST on a decided/deferred brief told the
	// operator "refused" (409) while having promoted the refused task into the
	// orchestrator's spawn-ready set, or closed the deliberately-open approve-verdicts.
	// Same action on a decided brief → pure absorb (the original decision's effects
	// stand; re-running them is what the interrupt contract absorbs). Different
	// action → refuse with ZERO effects.
	if (brief.status !== 'open') {
		const terminal = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'deferred';
		if (brief.status === terminal) {
			// Idempotent absorb (same answer re-POSTed): the original decision's effects + its analytics
			// row already stand — do NOT re-write analytics (that would double-count the one decision).
			return { kind: 'task', brief, taskStatus: task.status };
		}
		throw new BriefError(
			`decision brief ${briefId} already '${brief.status}' — refusing '${action}' ` +
				`(no effect was applied; the ceremony record is append-once)`
		);
	}

	// 16.4 fix (interrupt contract): EFFECT first, ceremony LAST. The original order
	// (markBriefDecided → setStatus) meant a crash between the two stranded a DECIDED
	// brief with an untouched 'proposed' task — and because the tray lists only OPEN
	// briefs, the decide affordance vanished with no way to converge. Effect-first
	// keeps the brief OPEN (re-POSTable) through every crash window: on re-run the
	// status guard absorbs the already-moved task, the verdict closures absorb
	// (same-outcome no-op), and the ceremony write completes the decision.

	if (action === 'approve') {
		const ready = task.status === 'proposed' ? await setStatus(db, task.id, 'ready') : task;
		// The operator moved PAST any pushback verdicts (none exist on gate briefs;
		// challenge briefs may carry them) — close them honestly.
		const open = (await listPanelVerdictsForArtifact(db, task.id)).filter((v) => v.outcome == null);
		for (const v of open) {
			if (v.verdict === 'pushback') await closePanelVerdictOutcome(db, v.id, 'overridden_by_operator');
		}
		const decided = await markBriefDecided(db, brief.id, 'approved');
		await recordBriefDecisionAnalytics(
			db,
			decided,
			'approve',
			`task ${task.id} → ${ready?.status ?? task.status}`,
			`panel-gated promotion approved by the operator: ${brief.ask}`
		);
		return { kind: 'task', brief: decided, taskStatus: ready?.status ?? task.status };
	}

	if (action === 'reject') {
		const withdrawn = task.status === 'proposed' ? await setStatus(db, task.id, 'withdrawn') : task;
		const open = (await listPanelVerdictsForArtifact(db, task.id)).filter((v) => v.outcome == null);
		for (const v of open) {
			await closePanelVerdictOutcome(
				db,
				v.id,
				v.verdict === 'approve' ? 'overridden_by_operator' : 'upheld'
			);
		}
		const decided = await markBriefDecided(db, brief.id, 'rejected');
		await recordBriefDecisionAnalytics(
			db,
			decided,
			'reject',
			`task ${task.id} → ${withdrawn?.status ?? task.status}`,
			`operator rejected the panel-gated promotion: ${brief.ask}`
		);
		return { kind: 'task', brief: decided, taskStatus: withdrawn?.status ?? task.status };
	}

	// defer — the ceremony IS the effect here (the task stays 'proposed').
	const pm = await getPm(db, task.project);
	const until = new Date(Date.now() + deferWindowMs(pm, opts));
	const decided = await markBriefDecided(db, brief.id, 'deferred', { deferUntil: until });
	// Defer is first-class and feeds pm_memory (WORKFORCE §8 one-click list) — ONLY
	// on the actual open→deferred transition (16.4 fix): a repeat defer POST is
	// absorbed by the status pre-check above and never reaches this write.
	await addPmMemory(db, {
		project: task.project,
		kind: 'observation',
		content:
			`Operator DEFERRED the brief on "${task.title}" until ${until.toISOString()} — ` +
			`the matter is suppressed (structural fingerprint) until the window lapses.`,
		source: 'decision-brief',
		confidence: 1.0
	});
	// First-class analytics of the DECISION itself (kind/decision/outcome/why), distinct from the
	// suppression 'observation' above (that feeds the WORKFORCE §8 one-click list; this feeds the
	// decision audit). Content deliberately carries no 'DEFERRED' token so the two rows never conflate.
	await recordBriefDecisionAnalytics(
		db,
		decided,
		'defer',
		`task ${task.id} stays proposed; suppressed until ${until.toISOString()}`,
		brief.ask
	);
	return { kind: 'task', brief: decided, taskStatus: task.status };
}

/**
 * CERT_HIRE briefs — route through the EXISTING workforce hire path (applyHireDecision; HR-5 §7.5, B4).
 * The hire gate is approve/reject ONLY: a hire-gate has no defer window (the candidate stays OPEN until
 * the operator disposes), so a defer is a typed refusal — never a crash, never a silent no-op. APPROVE
 * requires operatorConfirmed (B4 fail-closed — enforced INSIDE applyHireDecision; the dispatcher only
 * threads it through). The cert flip + staffing feed live in applyHireDecision (F-055: never inline).
 */
async function applyCertHireBriefDecision(
	db: Db,
	brief: DecisionBriefRow,
	action: BriefAction,
	opts: BriefDecisionOpts
): Promise<BriefDecisionResult> {
	if (action === 'defer') {
		throw new BriefActionError(
			`brief ${brief.id} is a cert_hire (hire-gate) brief — it is approve/reject only; there is no defer ` +
				`(the candidate stays open until the operator disposes)`
		);
	}
	const result = await applyHireDecision(db, brief.id, action, {
		operatorConfirmed: opts.operatorConfirmed === true,
		...(opts.staffingProposal ? { staffingProposal: opts.staffingProposal } : {}),
		...(opts.charterNote !== undefined ? { charterNote: opts.charterNote } : {})
	});
	await recordBriefDecisionAnalytics(
		db,
		result.brief,
		action,
		action === 'approve'
			? `cert ${result.certFlipped ? 'flipped→passed' : 'already-passed (no-op)'}${result.staffing ? '; staffing fed' : ''}`
			: 'no cert flip, no staffing (reject withholds)',
		`recommendation=${result.recommendation}; lifecycle=${result.lifecycle}`
	);
	return {
		kind: 'cert_hire',
		brief: result.brief,
		hire: {
			recommendation: result.recommendation,
			lifecycle: result.lifecycle,
			certFlipped: result.certFlipped,
			...(result.staffing ? { staffed: result.staffing.staffed, staffId: result.staffing.staff.id } : {})
		}
	};
}

/**
 * REPO_CREATE briefs — route through the EXISTING RC-2 outward gate (applyRepoCreateDecision; RC-3, B4).
 * Approve/reject ONLY (the project stays repo-less until decided) — a defer is a typed refusal. APPROVE
 * requires operatorConfirmed (B4 fail-closed — enforced INSIDE applyRepoCreateDecision, the integrity
 * wall a PM/agent cannot cross). The consent record + confirm-token derivation + gate drive (with F-050
 * main-default branch normalization) live in applyRepoCreateDecision (F-055: never inline).
 */
async function applyRepoCreateBriefDecision(
	db: Db,
	brief: DecisionBriefRow,
	action: BriefAction,
	opts: BriefDecisionOpts
): Promise<BriefDecisionResult> {
	if (action === 'defer') {
		throw new BriefActionError(
			`brief ${brief.id} is a repo_create brief — it is approve/reject only; there is no defer ` +
				`(the project stays repo-less until the operator disposes)`
		);
	}
	const result = await applyRepoCreateDecision(db, brief.id, action, {
		operatorConfirmed: opts.operatorConfirmed === true,
		...(opts.branch ? { branch: opts.branch } : {}),
		...(opts.client ? { client: opts.client } : {}),
		...(opts.gitRunner ? { gitRunner: opts.gitRunner } : {})
	});
	await recordBriefDecisionAnalytics(
		db,
		result.brief,
		action,
		action === 'approve'
			? result.gate?.created
				? `repo created (${result.repoUrl ?? 'url pending'})`
				: `repo gate red at ${result.gate?.failedAt ?? '—'} (brief stays open)`
			: 'no repo created (reject withholds)',
		result.gate?.summary ?? 'operator disposed the repo-create recommendation'
	);
	return {
		kind: 'repo_create',
		brief: result.brief,
		repo: {
			created: result.gate?.created ?? false,
			...(result.gate?.failedAt ? { failedAt: result.gate.failedAt } : {}),
			...(result.gate?.summary ? { summary: result.gate.summary } : {}),
			...(result.repoUrl ? { repoUrl: result.repoUrl } : {})
		}
	};
}

/**
 * First-class analytics on an operator brief decision (the studio records HOW/WHY a decision was made —
 * never a flat event; analytics-first rule). Best-effort + wrapped-and-swallowed (§5 invariant 8): an
 * analytics append NEVER fails the decision it records nor crashes the server (F-014/F-048). Written as
 * a typed pm_memory 'decision' row ONLY for a project-bearing brief — pm_memory is project-scoped, so a
 * project-less brief (a cert_hire is raised WITHOUT a project) is skipped honestly rather than attributed
 * to a fabricated project (its own audit lives in the workforce role_event/lifecycle rows). Idempotent by
 * placement: called only on the ACTUAL transition (never the absorb path), so a re-POST never re-counts.
 */
async function recordBriefDecisionAnalytics(
	db: Db,
	brief: DecisionBriefRow,
	action: BriefAction,
	outcome: string,
	why: string
): Promise<void> {
	if (!brief.project) return;
	await addPmMemory(db, {
		project: brief.project,
		kind: 'decision',
		content: `Operator decision on ${brief.artifact_kind} brief ${brief.id}: decision=${action}; outcome=${outcome}. Why: ${why}`,
		source: 'decision-brief',
		confidence: 1.0,
		related_to: brief.id
	}).catch((err) =>
		console.warn(
			`[pm-panel] brief-decision analytics append failed (decision unaffected): ${(err as Error).message}`
		)
	);
}

// ── Proposals queue read model (the PM tab surface) ───────────────────────────────

export interface ProposalQueueEntry {
	task: TaskRow;
	verdicts: PanelVerdictRow[];
	openBrief: DecisionBriefRow | null;
}

/** The project's open proposals with their panel history + any open brief —
 *  composed from live rows (F-008); an empty queue is honestly empty. */
export async function listProposalQueue(db: Db, projectId: string): Promise<ProposalQueueEntry[]> {
	const proposed = await listTasksByProject(db, projectId, 'proposed');
	const out: ProposalQueueEntry[] = [];
	for (const task of proposed) {
		out.push({
			task,
			verdicts: await listPanelVerdictsForArtifact(db, task.id),
			openBrief: await getOpenBriefForArtifact(db, task.id)
		});
	}
	return out;
}

// Re-export for the §2.2 closure the API layer needs alongside decisions.
export { closeOpenPanelVerdictsForArtifact };
