// TASK 16.5 — PM GitHub issue/PR TRIAGE (PM-SPEC §5 — triage-ONLY; D-039).
//
// When the 16.2 trigger engine wakes the PM on a GitHub issue/PR arrival
// (provenance.kind === 'github_arrival'), the review pass TRIAGES each arrival:
//
//   • SUMMARIZE — a deterministic, honest summary built ONLY from the real arrival
//     metadata the 9.4 SyncAdapter detected (kind / number / title / url). The PM
//     never fetches the issue body or the PR diff — triage is summary-level by
//     design (PM-SPEC §5 role separation; the PM context stays lean).
//   • LINK / DUPLICATE-CHECK — against the 9.4 `task_sync` ledger (an external id
//     already mapped to a task IS that task) and the project's OPEN tasks by exact
//     title match (the same dedup rule the 9.4 push uses to LINK instead of
//     duplicating). A linked arrival produces NO new proposal — the note records
//     the link instead (G1 presence-claim: the matched task is named verbatim).
//   • FLAG RISKS — derived from REAL properties only (F-008): a PR is external
//     code pending review; a duplicate overlaps named open work; an arrival linked
//     to a BLOCKED task may be a symptom of the blocker. Never an invented score.
//   • PROPOSE through the 16.4 §4 pipeline (pm-review.ts runs these through the
//     proposeTask chokepoint — full §4.1 contract, structural-fingerprint
//     anti-spam, validation panel downstream):
//       – an UNLINKED issue → a triage task for the issue;
//       – a PR → a proposal to SPAWN A CODE-REVIEWER. Until W-D7c certifies the
//         catalog roles, the proposal names the INLINE reviewer shape (inline
//         prompt core, role fields NONE — the §9 bridge the 16.4 panel uses).
//
// Triage notes persist as pm_memory rows (source 'pm-triage') carrying the
// issue/PR provenance in their content + related_to — every note derives from a
// real arrival the SyncAdapter detected (F-008).
//
// THE PM NEVER READS DIFFS (PM-SPEC §5). Three structural guarantees, each tested:
//   1. This module (and pm-review.ts) imports NOTHING from the sync/gh boundary —
//      the deterministic triage path has no code path to `gh`/the network at all.
//   2. Any SESSION-DRIVEN PM triage turn launches under TRIAGE_TOOL_POLICY
//      (Read-only — no Bash, so no `gh pr diff` channel) + TRIAGE_CAPABILITIES
//      (the EMPTY capability set): composeCapabilities provisions no skill/agent/
//      MCP, so a diff-fetch capability is structurally absent even when the
//      catalog offers one (the composeCapabilities proof in pm-triage.test.ts).
//   3. Creds-absent degrades honestly UPSTREAM: the sync route's probe gate stops
//      before the adapter runs, so no arrivals are detected, the trigger never
//      fires, and no triage row exists (never a fabricated triage).
//
// Boundary discipline (D-016): the project id passes the db/validate chokepoint;
// every value binds via $param. Arrival metadata is EXTERNAL input (GitHub titles)
// — sanitized at ingress (control chars stripped, length-bounded, urls must be
// http(s)) before it reaches a memory row or a proposal title.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { CapabilitySet, ToolPolicy } from '../runtime/index';
import type { TaskRow } from '../tasks/repo';
import type { ProposeTaskInput } from './pm-proposals';
import type { AddPmMemoryInput, PmReviewProvenance } from './pm-repo';

// ── The triage-session capability contract (PM-never-reads-diff, guard #2) ─────────

/**
 * The tool policy ANY session-driven PM triage turn launches under (the same shape
 * pmChat uses): Read-only. No 'Bash' ⇒ no `gh pr diff` / `git diff` channel; the
 * diff-fetch path belongs to the code-reviewer session the PM PROPOSES, never to
 * the PM itself (PM-SPEC §5 role separation).
 */
export const TRIAGE_TOOL_POLICY: ToolPolicy = Object.freeze({ allow: ['Read'] });

/**
 * The capability set for a PM triage session: EMPTY on every dimension. Composed
 * through composeCapabilities (D-036) this provisions no skill/agent/MCP — a
 * diff-fetch capability is structurally absent even when the catalog offers one,
 * and plugins/marketplaces stay forcibly empty (the S1/D-002 isolation guard).
 */
export const TRIAGE_CAPABILITIES: CapabilitySet = Object.freeze({
	skills: [],
	agents: [],
	mcp: []
}) as CapabilitySet;

// ── Shapes ──────────────────────────────────────────────────────────────────────────

/** One GitHub arrival as the triage pass sees it (sanitized at ingress). */
export interface TriageArrival {
	kind: 'issue' | 'pr';
	externalId: string;
	title?: string;
	url?: string;
}

/** Where the arrival metadata came from (honest signal for the note text). */
export type ArrivalSource = 'detail' | 'evidence';

export interface ParsedArrivals {
	arrivals: TriageArrival[];
	/** Entries that failed shape validation — counted + surfaced, never silent. */
	malformed: number;
	/** 'detail' = the engine's titled metadata; 'evidence' = bare refs only (older
	 *  provenance rows) — triage degrades honestly to ref-level. */
	source: ArrivalSource;
}

/** A duplicate-check hit: WHICH task and HOW it matched (G1 presence-claim data). */
export interface TriageLink {
	taskId: string;
	taskTitle: string;
	taskStatus: string;
	via: 'task_sync' | 'title';
}

/** The full triage of one arrival (the note + the proposal it derived, if any). */
export interface ArrivalTriage {
	arrival: TriageArrival;
	/** The stable arrival ref ('issue#7' / 'pr#8') — the dedup/evidence identity. */
	ref: string;
	link: TriageLink | null;
	risks: string[];
	proposal: ProposeTaskInput | null;
}

export interface GithubTriageResult {
	/** pm_memory seeds — one triage note per arrival (+ one honest note when every
	 *  entry was malformed). Source 'pm-triage', provenance in content/related_to. */
	notes: AddPmMemoryInput[];
	/** Proposals to run through the §4 proposeTask chokepoint, in arrival order. */
	proposals: ProposeTaskInput[];
	malformed: number;
	triaged: ArrivalTriage[];
}

// ── Ingress sanitation (arrival metadata is EXTERNAL input) ─────────────────────────

const MAX_ARRIVALS = 20;
const MAX_TITLE = 160;
const EXTERNAL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** The 16.2 arrivalRef format ('issue#12' / 'pr#34') — the evidence-fallback parse. */
const ARRIVAL_REF_RE = /^(issue|pr)#([A-Za-z0-9._-]{1,64})$/;

/** Strip control characters and bound the length (external titles, F-008-honest). */
function sanitizeTitle(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	// eslint-disable-next-line no-control-regex
	const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
	if (!clean) return undefined;
	return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean;
}

/** Accept only http(s) urls (boundary validation — never persist a junk scheme). */
function sanitizeUrl(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	const t = raw.trim();
	return /^https?:\/\/\S+$/.test(t) && t.length <= 500 ? t : undefined;
}

/** Truncate for a task title (proposal titles stay scannable on the board). */
function shortTitle(title: string | undefined, max = 80): string {
	if (!title) return '';
	return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

/**
 * Parse the arrivals a github_arrival provenance carries. Preferred source: the
 * engine's `detail.arrivals` (kind/externalId/title/url — TASK 16.5 enrichment).
 * Fallback: the bare evidence refs ('issue#7') older rows carry — triage degrades
 * honestly to ref-level (no title, no url; the note says so). Shadow paths:
 * nil detail → evidence fallback; empty/zero arrivals → empty result; a malformed
 * entry is SKIPPED and counted (never silently dropped, never a crash).
 */
export function parseTriageArrivals(provenance: PmReviewProvenance): ParsedArrivals {
	const rawDetail = provenance.detail?.arrivals;
	if (Array.isArray(rawDetail)) {
		const arrivals: TriageArrival[] = [];
		let malformed = 0;
		for (const entry of rawDetail.slice(0, MAX_ARRIVALS)) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				malformed++;
				continue;
			}
			const e = entry as Record<string, unknown>;
			const kind = e.kind === 'issue' || e.kind === 'pr' ? e.kind : null;
			const externalId =
				typeof e.externalId === 'string' && EXTERNAL_ID_RE.test(e.externalId)
					? e.externalId
					: null;
			if (!kind || !externalId) {
				malformed++;
				continue;
			}
			const title = sanitizeTitle(e.title);
			const url = sanitizeUrl(e.url);
			arrivals.push({
				kind,
				externalId,
				...(title !== undefined ? { title } : {}),
				...(url !== undefined ? { url } : {})
			});
		}
		return { arrivals, malformed, source: 'detail' };
	}

	// Evidence-ref fallback (pre-16.5 provenance rows): 'issue#7' / 'pr#8'.
	const arrivals: TriageArrival[] = [];
	let malformed = 0;
	for (const ref of (provenance.evidence ?? []).slice(0, MAX_ARRIVALS)) {
		const m = typeof ref === 'string' ? ref.match(ARRIVAL_REF_RE) : null;
		if (!m) {
			malformed++;
			continue;
		}
		arrivals.push({ kind: m[1] as 'issue' | 'pr', externalId: m[2] });
	}
	return { arrivals, malformed, source: 'evidence' };
}

// ── Duplicate-check (the 9.4 task_sync ledger + the 9.4 title-link rule) ────────────

/** Task statuses a duplicate-check counts as "open work" (terminal rows are not
 *  duplicates — a new report against finished work is NEW work). */
const OPEN_FOR_DUP = new Set(['proposed', 'backlog', 'ready', 'in_progress', 'review', 'blocked']);

/** Look up the 9.4 task_sync mapping for one external id (D-016: id via the
 *  validate chokepoint, values via $param). Returns the mapped task id or null. */
async function findMappedTaskId(db: Db, projectId: string, externalId: string): Promise<string | null> {
	const project = new StringRecordId(assertRecordId(projectId));
	const [rows] = await db.query<[Array<{ task?: unknown }>]>(
		`SELECT task FROM task_sync WHERE project = $project AND provider = $provider AND external_id = $ext LIMIT 1;`,
		{ project, provider: 'github', ext: externalId }
	);
	return rows.length && rows[0].task != null ? String(rows[0].task) : null;
}

/**
 * Duplicate-check one arrival against (1) the task_sync ledger by external id and
 * (2) the project's OPEN tasks by exact (case-insensitive, trimmed) title — the
 * same rule the 9.4 push uses to LINK instead of duplicating. `tasks` is the live
 * task list the review pass already loaded (no second read).
 */
export async function findLinkedTask(
	db: Db,
	projectId: string,
	arrival: TriageArrival,
	tasks: TaskRow[]
): Promise<TriageLink | null> {
	const mappedId = await findMappedTaskId(db, projectId, arrival.externalId);
	if (mappedId) {
		const t = tasks.find((row) => row.id === mappedId);
		return {
			taskId: mappedId,
			taskTitle: t?.title ?? '(task row not in the live list)',
			taskStatus: t?.status ?? 'unknown',
			via: 'task_sync'
		};
	}
	if (arrival.title) {
		const needle = arrival.title.toLowerCase().trim();
		const t = tasks.find(
			(row) => OPEN_FOR_DUP.has(row.status) && row.title.toLowerCase().trim() === needle
		);
		if (t) return { taskId: t.id, taskTitle: t.title, taskStatus: t.status, via: 'title' };
	}
	return null;
}

// ── Proposal builders (the §4.1 contract payloads — pm-review runs them through
//    the proposeTask chokepoint, which enforces the contract + anti-spam) ──────────

function issueTriageProposal(projectId: string, a: TriageArrival, ref: string): ProposeTaskInput {
	const titled = a.title ? ` ("${a.title}")` : '';
	return {
		project: projectId,
		title: `Triage GitHub issue #${a.externalId}${a.title ? `: ${shortTitle(a.title)}` : ''}`,
		objective: `Resolve GitHub issue #${a.externalId}${titled} — classify it, then land a fix or a scoped follow-up.`,
		purpose:
			`An external issue arrived on the project's GitHub repo with no matching task ` +
			`(PM triage, PM-SPEC §5)${a.url ? ` — ${a.url}` : ''}. Un-triaged external reports go stale ` +
			`and hide real defects; the duplicate-check (task_sync mapping + open-task title match) found nothing.`,
		acceptance_criteria: [
			'The issue is classified (defect / feature request / question / invalid) with the reasoning recorded.',
			`A fix lands, or a scoped follow-up task exists — linked to issue #${a.externalId} via the task↔issue sync mapping (9.4).`,
			'The reporter gets an answer on GitHub (comment or close through the sync flow) — never left hanging.'
		],
		provenance: { kind: 'github_arrival', evidence: [ref] }
	};
}

function prReviewerProposal(
	projectId: string,
	a: TriageArrival,
	ref: string,
	link: TriageLink | null
): ProposeTaskInput {
	const titled = a.title ? ` ("${a.title}")` : '';
	return {
		project: projectId,
		title: `Review GitHub PR #${a.externalId}${a.title ? `: ${shortTitle(a.title)}` : ''}`,
		objective: `Get GitHub PR #${a.externalId}${titled} independently code-reviewed to an evidence-backed verdict.`,
		purpose:
			`External code arrived as a PR${a.url ? ` (${a.url})` : ''}` +
			(link ? `; it appears related to task ${link.taskId} ("${link.taskTitle}", ${link.taskStatus})` : '') +
			`. The PM triages but NEVER reviews diffs (PM-SPEC §5 role separation — the PM context stays lean); ` +
			`an independent code-reviewer must judge the change.`,
		acceptance_criteria: [
			`A dedicated code-reviewer session is spawned for PR #${a.externalId} — the INLINE reviewer shape ` +
				`(inline prompt core, role fields NONE — the §9 bridge; the W-D7c catalog 'code-reviewer' is not ` +
				`yet gauntlet-certified), with the diff-fetch capability provisioned to THAT session only.`,
			'The reviewer records a verdict (approve / request changes) whose presence-claims quote the diff verbatim and whose absence-claims name the search that proved absence (G1).',
			'The PM session never fetches or reads the PR diff — triage stays summary-level (role separation).'
		],
		provenance: { kind: 'github_arrival', evidence: [ref] }
	};
}

// ── The triage derivation ───────────────────────────────────────────────────────────

/** Human label for one arrival ('issue #7' / 'PR #8'). */
function label(a: TriageArrival): string {
	return `${a.kind === 'pr' ? 'PR' : 'issue'} #${a.externalId}`;
}

/**
 * Derive the full GitHub triage for one github_arrival provenance: per-arrival
 * summary notes (pm_memory seeds), duplicate-check links, honest risk flags, and
 * the §4 proposal payloads. Pure derivation over REAL inputs — the only read this
 * module performs is the task_sync mapping lookup (bounded, one per arrival).
 *
 * Shadow paths: a provenance with no parsable arrivals at all yields ONE honest
 * note naming the unparseable evidence (never silence-as-success, never a crash);
 * zero arrivals AND zero malformed (cannot happen via the engine, which requires
 * fresh arrivals to fire) yields an empty result.
 */
export async function deriveGithubTriage(
	db: Db,
	args: { projectId: string; tasks: TaskRow[]; provenance: PmReviewProvenance }
): Promise<GithubTriageResult> {
	const { projectId, tasks, provenance } = args;
	const { arrivals, malformed, source } = parseTriageArrivals(provenance);

	const notes: AddPmMemoryInput[] = [];
	const proposals: ProposeTaskInput[] = [];
	const triaged: ArrivalTriage[] = [];

	if (arrivals.length === 0) {
		if (malformed > 0) {
			// Named failure path: the trigger fired but its payload was unusable.
			notes.push({
				project: projectId,
				kind: 'observation',
				content:
					`GitHub triage: the github_arrival trigger fired but all ${malformed} arrival ` +
					`entr${malformed === 1 ? 'y was' : 'ies were'} unparseable (source: ${source}) — ` +
					`no triage performed. Evidence refs: ${(provenance.evidence ?? []).join(', ') || '—'}.`,
				source: 'pm-triage',
				confidence: 1.0
			});
		}
		return { notes, proposals, malformed, triaged };
	}

	const openCount = tasks.filter((t) => OPEN_FOR_DUP.has(t.status)).length;

	for (const arrival of arrivals) {
		const ref = `${arrival.kind}#${arrival.externalId}`;
		const link = await findLinkedTask(db, projectId, arrival, tasks);

		// Risk flags — each derived from a REAL property (F-008, never a score).
		const risks: string[] = [];
		if (arrival.kind === 'pr') {
			risks.push(
				'external code change pending review — unreviewed third-party code is a risk until an independent code-reviewer session reads the diff (the PM does not)'
			);
		}
		if (link) {
			risks.push(`overlaps existing ${link.taskStatus} task ${link.taskId} ("${link.taskTitle}")`);
			if (link.taskStatus === 'blocked') {
				risks.push('the linked task is BLOCKED — this arrival may be a symptom of the blocker');
			}
		}

		// What the PM proposes (run through proposeTask by the caller):
		//   issue + no link → a triage task; PR → a code-reviewer proposal (always —
		//   external code needs review even when it maps to known work); linked issue →
		//   no proposal (the duplicate is absorbed; the note records the link).
		let proposal: ProposeTaskInput | null = null;
		if (arrival.kind === 'pr') {
			proposal = prReviewerProposal(projectId, arrival, ref, link);
		} else if (!link) {
			proposal = issueTriageProposal(projectId, arrival, ref);
		}

		// The triage note (the pm_memory seed) — summary + link + risks + intent,
		// every clause traceable to a real input. The issue/PR provenance rides in
		// the content (ref + url) and related_to (linked task, else the ref).
		const titlePart = arrival.title
			? ` "${arrival.title}"`
			: ' (title unknown — triaged from the arrival ref only)';
		const urlPart = arrival.url ? ` <${arrival.url}>` : '';
		const linkPart = link
			? `linked to existing task ${link.taskId} ("${link.taskTitle}", ${link.taskStatus}) via ${
					link.via === 'task_sync' ? 'the task_sync mapping' : 'an exact title match'
				}`
			: `no existing task matched (duplicate-check: task_sync external_id + title match across ${openCount} open task${openCount === 1 ? '' : 's'})`;
		const intentPart = proposal
			? arrival.kind === 'pr'
				? 'proposing to spawn an independent code-reviewer (inline shape) through the §4 validation pipeline'
				: 'proposing a triage task through the §4 validation pipeline'
			: 'no new proposal — the duplicate is absorbed by the linked task';
		notes.push({
			project: projectId,
			kind: 'observation',
			content:
				`GitHub triage — ${label(arrival)}${titlePart}${urlPart}: ${linkPart}. ` +
				(risks.length ? `Risk: ${risks.join('; ')}. ` : '') +
				`Action: ${intentPart}.`,
			source: 'pm-triage',
			confidence: 1.0,
			related_to: link?.taskId ?? ref
		});

		if (proposal) proposals.push(proposal);
		triaged.push({ arrival, ref, link, risks, proposal });
	}

	if (malformed > 0) {
		notes.push({
			project: projectId,
			kind: 'observation',
			content:
				`GitHub triage: ${malformed} arrival entr${malformed === 1 ? 'y' : 'ies'} in the trigger ` +
				`payload ${malformed === 1 ? 'was' : 'were'} malformed and skipped (source: ${source}).`,
			source: 'pm-triage',
			confidence: 1.0
		});
	}

	return { notes, proposals, malformed, triaged };
}
