// TASK 6.4 — /projects/[id] detail page (UI-SPEC §51, §187–193 v0.1; F-008; D-019).
//
// The project workspace shell: loads ONE project's plan macro (purpose/vision/role/DoD)
// + its plan hierarchy (release / phase / feature / sprint) + its tasks + its Claude Code
// sessions, all from REAL rows (F-008 — never a fabricated count or row). The page renders
// three tabs per UI-SPEC §51 (plan / sessions / release); the Release tab links to the
// existing /projects/[id]/release child (3.4). Degrades honestly (D-019): a malformed id
// is a 404, an unknown project is a 404, and a DB-down boot returns connected:false +
// empty rather than zero-dressed-as-real. Live: the SSE `project`/`task`/`session`
// watchers re-invalidate this loader so the detail updates in place (UI-SPEC §1.2).

import { tryGetDb } from '$lib/server/db/runtime-init';
// Per-PM soul (per-PM identity) — the project-scoped derived self-model + its graduation timeline
// (mirrors /brain's Atelier soul, scoped to THIS project's slice of the brain).
import { loadSoul, type SoulModel } from '$lib/server/memory/soul';
import {
	listGraduations,
	projectSubject,
	GRADUATION_TIMELINE_LIMIT,
	type GraduationRow
} from '$lib/server/memory/soul-graduation';
import {
	getProject,
	listReleases,
	listPhases,
	listFeatures,
	listSprints,
	createSprint,
	parseGameVerifyConfig,
	PROJECT_STATUSES,
	isoOrNull,
	type ProjectPlan,
	type ReleaseRow,
	type PhaseRow,
	type FeatureRow,
	type SprintRow
} from '$lib/server/projects/repo';
import {
	addPmMemory,
	listPmMemory,
	pmMemoryStats,
	addDecision,
	listDecisions,
	completeSprint,
	listPmReviews,
	getPm,
	updatePmCharter,
	updatePmSchedule,
	updatePmAuthority,
	setPmAutonomous,
	setPmAutoPublishPreauthorized,
	setPmRepoCreatePreauthorized,
	PM_MEMORY_KINDS,
	PM_AUTHORITIES,
	type PmAuthority,
	type PmMemoryKind,
	type PmMemoryRow,
	type DecisionRow,
	type PmMemoryStats,
	type PmReviewRow,
	type PmRow
} from '$lib/server/projects/pm-repo';
// Concierge advisories — the Path-B PM↔concierge consult lifecycle (pending → answered), read-only.
import {
	listConciergeAdvisories,
	type ConciergeAdvisoryRow
} from '$lib/server/projects/concierge-advisories';
// TASK 16.4 — the proposed-task pipeline + validation panel (PM-SPEC §4 / D-039).
import {
	listProposalQueue,
	runValidationPanel,
	ValidatorContractError,
	PanelInputError,
	type ProposalQueueEntry
} from '$lib/server/projects/pm-panel';
import {
	revisePmProposal,
	withdrawPmProposal,
	ProposalContractError
} from '$lib/server/projects/pm-proposals';
// RC-2/RC-3 — the operator-create gate driver + the PM-proposed recommendation rail.
import {
	runRepoCreationGate,
	repoCreateConfirmToken
} from '$lib/server/projects/repo-creation-gate';
import {
	proposeRepoCreate,
	RepoProposalError
} from '$lib/server/projects/repo-create-proposal';
// RC-4 — the OPEN PM-proposed repo_create brief for THIS project (artifact = the project row). Surfaced
// read-only for the operator to approve/reject via /api/briefs (applyRepoCreateDecision). One repo per
// project ⇒ at most one open brief.
import { getOpenBriefForArtifact, type DecisionBriefRow } from '$lib/server/projects/briefs';
// PM-LC-2 — the one-click lifecycle tick (PM-LIFECYCLE-SPEC §PM-LC-2).
import { startProjectLifecycle } from '$lib/server/projects/pm-lifecycle';
// PMA — the live autonomous loop's honest last-state (read-only surface; the boot seam owns the loop).
import {
	activeAutonomousLoop,
	DEFAULT_MAX_TICKS_PER_WINDOW
} from '$lib/server/projects/pm-autonomous';
// PMA — the REAL D-021 daily spawn cap the live boot wires (the unsupervised-spend ceiling surfaced to
// the operator on the arm confirm). undefined ⇒ uncapped (honest — never a fabricated number).
import { bootDailySpawnCap } from '$lib/server/orchestrator/boot';
// CC-STATUS — the project command-center status dashboard's spawn-budget read (D-021 daily cap usage).
import { queueStats, type QueueStats } from '$lib/server/orchestrator/queue-monitor';
// GAME-VERIFY GV-4 — surface the latest persisted game_verify verdict(s) (operator visibility). The
// reader is DISPLAY-ONLY: the logTail/stackTraces were screened by the runner before persistence (D-026).
import {
	listGameVerifyVerdicts,
	type GameVerifyVerdictRow
} from '$lib/server/orchestrator/game-verify-read';
// LP-3 — this project's recurring autonomous loops (autonomous PM drive + PM cadence) for the
// command-center Loops tab. getLoops({projectId}) returns ONLY the project-scoped loops (global
// loops excluded), typed + normalized (no raw SDK non-POJOs — F-013); honest states (F-008).
import { getLoops, type LoopView } from '$lib/server/loops/read';
// LP-3 (manifest layer) — the DECLARED loop manifest scoped to THIS project: each running card's
// readiness/override state (manifestMap) plus declared-but-not-running loops surfaced honestly
// (F-008 — never dropped, never dressed as running). Same composition as /loops, project-scoped.
import {
	listLoopManifest,
	reconcileLoops,
	manifestByIdentifier,
	type LoopManifestRow,
	type ReconciledLoop
} from '$lib/server/loops/manifest';
// LP-3 — the readiness ARM GATE (LOOP-ENGINEERING step 5). The Loops tab hosts the same editable
// LoopCards as /loops, so this route's `pmAutonomous` ARM path routes through the SAME gate
// (Design Checklist green OR an explicit recorded operator override) — otherwise arming from this
// page would silently bypass the gate /loops enforces. DISARM (the kill switch) is NEVER gated.
import { armAutonomousLoop } from '$lib/server/loops/arm-gate';
// LP-3 — compose the /loops route's already-validated manifest actions (loopChecklist / loopPhase):
// the LoopReadiness / LoopManageControls forms POST to the CURRENT page (`?/loopChecklist` …), so the
// page hosting the cards must host the actions — the same composition /loops/[identifier] uses.
import { actions as loopsActions } from '../../loops/+page.server';
// CC-CONTROLS — the operator command-center CONTROL seam (CONTINUE re-enqueue / RESTART a failed run).
// Reuses the LIVE orchestrator's enqueue/drain (activeOrchestrator) + the work_item dedup double-spawn
// guard; never bypasses the spawn cap (the orchestrator owns it inside drain).
import {
	continueReadyTasks,
	restartSessionTask,
	OrchestratorUnavailableError,
	SessionControlError
} from '$lib/server/projects/project-controls';
// From the side-effect-free orchestrator registry, NOT from hooks.server — importing
// hooks.server eagerly runs its top-level `bootstrap()` (initDb against the dev DB, live
// watchers, boot reaper), which is invisible under SvelteKit but boots the real server
// inside any test that imports this loader and kills it on the Db singleton guard.
import { activeOrchestrator } from '$lib/server/orchestrator';
import { getFleetSession, estimateLoopRun, toEstimateDisplay, type RunEstimateDisplay } from '$lib/server/analytics';
import { PmProposalContractError } from '$lib/server/projects/pm-propose';
import {
	hirePm,
	hireInterviewFor,
	HIRE_QUESTIONS,
	type HireAnswer,
	type HireInterviewQuestion,
	type HireQuestionId
} from '$lib/server/projects/pm-hire';
import {
	assemblePmContext,
	resolvePmRoute,
	PM_CHAT_CAPABILITIES
} from '$lib/server/projects/pm-session';
import { runPmReview } from '$lib/server/projects/pm-review';
import { parseCron, parseDurationMs } from '$lib/server/projects/pm-triggers';
import { loadOrchestration } from '$lib/server/config';
import {
	listTasksByProject,
	createTask,
	updateTask,
	setStatus,
	canTransition,
	TASK_STATUSES,
	TASK_PRIORITIES,
	type TaskStatus,
	type TaskPriority
} from '$lib/server/tasks/repo';
import { updateProject } from '$lib/server/projects/repo';
import { listFindings, type FindingRow } from '$lib/server/scanner/findings-repo';
import {
	runProjectUxInspection,
	uxInspectionAllowed,
	readOrchestrationMode,
	type UxInspectionTrigger
} from '$lib/server/scanner/maintain-cycle';
import {
	listProjectMemories,
	listProjectGraph,
	type MemoryRow,
	type MemoryGraph
} from '$lib/server/memory';
import { listFleetByProject, type FleetSession } from '$lib/server/analytics';
import {
	recommendStaffing,
	dispatchHireRequest,
	HireDispatchError,
	CapabilityNeedsError,
	loadWorkforcePanel,
	recordPmFitVerdict,
	HireGateError,
	listRecentRoleEvents,
	type HireGap,
	type HireBriefCard,
	type RecentRoleEventRow
} from '$lib/server/workforce';
import {
	listSessionMessages,
	launchSession,
	spawnIdentity,
	type TranscriptMessage
} from '$lib/server/sessions';
import { TokenBudgetExceededError, budgetRefusalEnvelope } from '$lib/server/analytics/spend-budget';
import {
	resumeCreation,
	ConcurrentCreateError,
	ResumeProjectNotFoundError,
	ResumeNotIncompleteError,
	ResumeScaffoldMissingError
} from '$lib/server/create';
import {
	getBus,
	getRuntime,
	getControlCapabilities,
	getMemoryService,
	resolveCapabilitiesForIntent,
	DEFAULT_MODEL,
	DEFAULT_AGENT,
	DEFAULT_BUDGETS,
	DEFAULT_TOOL_POLICY,
	DEFAULT_INTENT,
	type ControlCapabilities
} from '$lib/server/harness';
import { assertRecordId, assertRecordIdOfTable } from '$lib/server/db/validate';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

/**
 * TASK-BOARD-SPEC §4.2 — split the operator's comma-separated tag box into a list.
 *
 * This is the UI-INPUT parser and nothing more: it splits on commas and drops blanks. Trimming,
 * lowercasing, de-duplication and the ≤8 × ≤32 bounds all live in `normalizeTags` at the repo
 * WRITE chokepoint (TB-8) — one validator, not two, so the form and any future caller cannot
 * drift apart, and an over-long tag surfaces the SAME named InvalidTagsError message everywhere.
 * A blank box yields `[]`: "no tags" on create, and an explicit CLEAR on update.
 */
function parseTagInput(raw: string): string[] {
	return raw
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

/** A task row reduced to what the detail page renders (plain, serializable). */
export interface TaskSummary {
	id: string;
	title: string;
	status: TaskStatus;
	priority: TaskPriority;
	/** The statuses this task may legally move TO (the board's move targets). */
	moves: TaskStatus[];
	/** When the task was created (ISO string), or null when absent/unparseable (F-013 — never a
	 *  fabricated time). Drives the board card's "created Nm ago" relative label. */
	createdAt: string | null;
	/** TASK-BOARD-SPEC §4.2 (m0087) — the operator's tags, already trimmed/lowercased/deduped by
	 *  the repo write chokepoint. `[]` means the task carries none, and the card renders NO tag
	 *  row at all — never a placeholder chip implying an empty tag exists (F-008). */
	tags: string[];
}

export interface ProjectDetailData {
	connected: boolean;
	projectId: string;
	/** The PM's project-scoped soul (derived self-model), or null when unreachable / the read failed.
	 *  A cold/new project is honestly `nascent` (F-008) — never a fabricated maturity. */
	pmSoul: SoulModel | null;
	/** The PM soul's graduation timeline (newest-first); [] when it has never graduated / unreachable. */
	pmGraduations: GraduationRow[];
	/** Present only when the project exists + DB connected. */
	project?: {
		id: string;
		name: string;
		root_path: string;
		ecosystem: string[];
		status: string;
		build_tool?: string;
		test_command?: string;
		repo_url?: string;
		/** Create-with-AI materialization state (m0049): 'incomplete' ⇒ the setup did not finish and
		 *  a resume affordance is offered; 'complete'/absent ⇒ fully wired / native (no surface). */
		create_status?: string;
		plan?: ProjectPlan;
	};
	releases: ReleaseRow[];
	phases: PhaseRow[];
	features: FeatureRow[];
	sprints: SprintRow[];
	tasks: TaskSummary[];
	sessions: FleetSession[];
	/** The legal task statuses (board columns) + per-status priority/transition vocab. */
	taskStatuses: readonly TaskStatus[];
	taskPriorities: readonly TaskPriority[];
	/** The canonical project status vocabulary for the Settings select (DATA-MODEL §4.1). */
	projectStatuses: readonly string[];
	/** Project-scoped Maintain rollup: live security/dep-health/UX findings (UI-SPEC §189). */
	findings: FindingRow[];
	/** Project-scoped recall list for the Memory tab (UI-SPEC §195). */
	memories: MemoryRow[];
	/** Project-scoped knowledge graph for the Memory tab (UI-SPEC §195). */
	graph: MemoryGraph;
	/** PM typed memory (observation/learning/risk/pattern/decision), newest first. */
	pmMemory: PmMemoryRow[];
	/** Concierge advisories (Path-B consults) for THIS project — honest lifecycle: PENDING until the
	 *  concierge's real reply landed on the PM peer-identity mailbox, then ANSWERED with the advisory
	 *  text (screened at write, D-026). Newest-first + bounded; [] when never consulted (F-008). */
	conciergeAdvisories: ConciergeAdvisoryRow[];
	/** Per-kind PM memory counts (honest real counts; null until the project loads). */
	pmStats: PmMemoryStats | null;
	/** Architectural decisions for this project, newest first. */
	decisions: DecisionRow[];
	/** PM review passes (manual/periodic), newest first — the review-history surface. */
	pmReviews: PmReviewRow[];
	/** Whether an automatic (periodic) review is permitted under the configured mode (D-004). */
	pmAutoReviewAllowed: boolean;
	/** Whether automatic (periodic) UX inspection is permitted under the configured mode (D-004). */
	uxAutoAllowed: boolean;
	/** Whether this project has any PM memory yet (legacy-bootstrap signal; review gate). */
	pmBootstrapped: boolean;
	/** TASK 16.1 — the hired PM identity row, or null (the honest empty state + hire CTA). */
	pm: PmRow | null;
	/**
	 * PMA — the live autonomous-loop's last honest state for this project (running / blocked /
	 * cap-reached / dod-reached / awaiting-release-confirm), or null when the loop has not acted on this
	 * project yet (or no loop is running — degraded boot). F-008: never a fabricated 'done'.
	 */
	autonomousLoop: { state: string; reason: string; ticksUsed: number } | null;
	/**
	 * PMA — the active HARD spawn caps that bound unsupervised spend (surfaced on the arm confirm so the
	 * operator sees the real ceiling before arming). `reTickCap` is the loop's per-project re-tick cap
	 * (PMA-2 — always enforced). `dailySpawnCap` is the REAL D-021 daily session-claim ceiling the live
	 * boot wires (null ⇒ uncapped — honest, never a fabricated number; F-008). Static config reads, not
	 * per-project rows — always present so the confirm never lacks the cap copy.
	 */
	spendCaps: { reTickCap: number; dailySpawnCap: number | null };
	/**
	 * CG-4 — the recent-window per-driven-session spend estimate rendered on the autonomous-loop ARM
	 * confirm (so the operator sees the likely cost BEFORE arming unsupervised spend). Always present +
	 * honest: measured '~N tokens (~$X) per driven session' from THIS project's completion history, or
	 * '—' with 'no history yet' when the project has no spend yet (F-008 — never a fabricated figure).
	 */
	loopEstimate: RunEstimateDisplay;
	/**
	 * CC-STATUS — headline work-queue stats for the project command-center dashboard: today's spawns
	 * vs the REAL enforced D-021 daily cap (queue-monitor.queueStats). Reports the live reality (F-008):
	 * `capped:false` + no denominator when the orchestrator runs uncapped (boot.ts wires no cap), never
	 * a fabricated /N. null on a disconnected/degraded boot (honest empty — no zero-dressed-as-real).
	 */
	queue: QueueStats | null;
	/** TASK 16.4 — open proposals with their panel verdicts + any open brief (PM-SPEC §4). */
	proposals: ProposalQueueEntry[];
	/** AGENCY-PULSE — recent workforce role_events (hire/cert/swap/staff/retire) for the command-center
	 *  HR/role activity strip. role_event is project-less, so this is the GLOBAL recent feed, newest-first
	 *  + bounded. [] when no role activity (honest empty → the strip shows "no HR activity", F-008). */
	roleEvents: RecentRoleEventRow[];
	/** The PM authority ladder vocabulary (for the operator's authority control). */
	pmAuthorities: readonly PmAuthority[];
	/** The Six Forcing Questions resolved against this project (smart-skip evidence). */
	hireQuestions: HireInterviewQuestion[];
	/** The PM-memory taxonomy (for the add-memory form). */
	pmKinds: readonly PmMemoryKind[];
	/** The `?session=` selected session id (validated), or null. */
	selectedSession: string | null;
	/** Persisted transcript of the selected session (historical; live streams via SSE). */
	transcript: TranscriptMessage[];
	/** HONEST session-control capability matrix (14.6/F-008) — what the wired backend
	 *  REALLY supports; the controls render disabled-with-reason when off. */
	controlCaps: ControlCapabilities;
	/** PM→HR dispatch (gap A) — the capability HIRE-gaps for this project: defect classes NO catalog
	 *  role proves (recommendStaffing.gaps). Each gets a DISPATCH affordance that enqueues a
	 *  hire_request. Empty when the project has no declared needs or every need is covered (honest). */
	staffingGaps: HireGap[];
	/** The project's CAPTURED proposed_defect_classes (Create-with-AI hire-signal classes not yet in
	 *  the operator vocabulary) — surfaced alongside gaps as the needed-role context (D4 LOCKED:
	 *  never matchable, a pure hire signal). [] when none. */
	proposedDefectClasses: string[];
	/** Gap D - open cert_hire hire-gate briefs awaiting the operator's B4 decision, each with the
	 *  project PM's LATEST fit-verdict (or null). A DENY pre-sets the operator surface to reject
	 *  (the operator can override - D-039 final). A fit-verdict NEVER flips the cert or staffs (B4).
	 *  The cert_hire brief is project-less (it certifies a role), so this is the GLOBAL open hire
	 *  queue surfaced for the project PM to weigh in on. [] when none (honest, F-008). */
	hireGates: HireBriefCard[];
	/** RC-4 — the OPEN PM-proposed repo_create brief for this project (or null). Surfaced read-only so
	 *  the operator can APPROVE (→ confirmed → the RC-2 outward gate) or REJECT it via /api/briefs. At
	 *  most one (one repo per project). null when no PM has proposed one (honest empty, F-008). */
	repoBrief: RepoBriefCard | null;
	/**
	 * GAME-VERIFY GV-4 — the latest persisted game_verify verdict(s) for this project (newest first,
	 * bounded), surfaced in the command-center for operator visibility (GAME-VERIFY-SPEC §"Orchestrator
	 * integration"). DISPLAY-ONLY: the logTail/stackTraces were screened by the runner before
	 * persistence (D-026). [] when the project has never run a verify (the UI shows "not yet run" when
	 * `gameVerifyConfigured`, or nothing when not configured — honest empty, F-008).
	 */
	gameVerify: GameVerifyVerdictRow[];
	/** GV-4 — whether the project DECLARES a parseable `game_verify` harness (opt-in, operator-set).
	 *  Lets the UI distinguish "configured but not yet run" (a muted prompt) from "not configured"
	 *  (nothing shown) — never invents a launch config (F-008). */
	gameVerifyConfigured: boolean;
	/**
	 * LP-3 — this project's recurring autonomous loops for the command-center Loops tab: the
	 * autonomous PM drive (when armed) + the PM cadence trigger (when scheduled). PROJECT-SCOPED only
	 * (getLoops filters out the global orchestrator/memory loops). Typed + normalized — no raw SDK
	 * non-POJOs (F-013); every surfaced detail screened (D-026). [] when no PM is armed/scheduled or
	 * on a degraded boot (honest empty → the tab shows "no active loops", F-008).
	 */
	loops: LoopView[];
	/**
	 * LP-3 (manifest layer) — identifier → declared manifest row for THIS project's loops, so each
	 * running LoopCard finds its declared/readiness state (checklist, phase, override). {} when
	 * nothing is declared or on a degraded read (honest empty, F-008).
	 */
	loopManifestMap: Record<string, LoopManifestRow>;
	/**
	 * LP-3 — this project's DECLARED loops with NO live counterpart (reconcile status
	 * 'declared-not-running'), surfaced honestly as their own section (F-008) — a real declaration
	 * whose loop is not currently running, never dropped and never dressed as a running card.
	 */
	loopDeclaredOnly: ReconciledLoop[];
	error?: string;
}

/** RC-4 — the operator-facing projection of an open repo_create decision brief (briefs.ts §B4). */
export interface RepoBriefCard {
	id: string;
	ask: string;
	issue: string;
	evidence: string[];
	/** The recommended repo target the brief carries (the create is ALWAYS private — RC-1/RC-2). */
	name: string | null;
	owner: string | null;
	createdAt: string | null;
}

export const load: PageServerLoad = async ({ params, depends, url }): Promise<ProjectDetailData> => {
	// Live re-invalidation keys: the SSE watchers for these tables re-run this loader.
	depends('app:projects');
	depends('app:tasks');
	depends('app:fleet');
	depends('app:pm');
	depends('app:findings');
	depends('app:memory');
	depends('app:graph');
	// LP-3 — the Loops tab's run history is agent_event; a run event re-invalidates the loader, which
	// re-samples the live armed PM singletons (the loop arm/cadence already re-invalidate via app:pm).
	depends('app:analytics');
	// LP-3 (manifest layer) — a `loop` row change (checklist tick / phase / override / declare)
	// re-invalidates so the cards' readiness state updates live (mirrors /loops).
	depends('app:loops-manifest');

	// Validate the project id at the boundary (D-016) — a malformed param is a 404,
	// never an interpolated query.
	let projectId: string;
	try {
		projectId = assertRecordId(`project:${params.id}`);
	} catch {
		throw error(404, 'invalid project id');
	}

	// The `?session=` selected session id — validated at the boundary (D-016). A malformed
	// value is ignored (no transcript fetched), never interpolated.
	const sessionParam = url.searchParams.get('session');
	let selectedSession: string | null = null;
	if (sessionParam) {
		try {
			selectedSession = assertRecordId(sessionParam);
		} catch {
			selectedSession = null;
		}
	}

	// TASK 14.6 — the honest control capability matrix (never throws; degrades to all-off
	// with the reason so the session controls explain themselves instead of dead buttons).
	const db = tryGetDb();
	let controlCaps: ControlCapabilities;
	try {
		controlCaps = await getControlCapabilities(db ?? undefined);
	} catch (err) {
		controlCaps = {
			available: false,
			reason: (err as Error).message,
			interject: false,
			resume: false,
			stop: false
		};
	}

	if (!db) {
		return {
			connected: false,
			projectId,
			pmSoul: null,
			pmGraduations: [],
			releases: [],
			phases: [],
			features: [],
			sprints: [],
			tasks: [],
			sessions: [],
			taskStatuses: TASK_STATUSES,
			taskPriorities: TASK_PRIORITIES,
			projectStatuses: PROJECT_STATUSES,
			findings: [],
			memories: [],
			graph: { nodes: [], edges: [] },
			pmMemory: [],
			conciergeAdvisories: [],
			pmStats: null,
			decisions: [],
			pmReviews: [],
			pmAutoReviewAllowed: false,
			uxAutoAllowed: false,
			pmBootstrapped: false,
			pm: null,
			autonomousLoop: null,
			spendCaps: readSpendCaps(),
			loopEstimate: toEstimateDisplay(null, 'driven session'),
			queue: null,
			proposals: [],
			roleEvents: [],
			pmAuthorities: PM_AUTHORITIES,
			hireQuestions: [],
			pmKinds: PM_MEMORY_KINDS,
			selectedSession,
			transcript: [],
			controlCaps,
			staffingGaps: [],
			proposedDefectClasses: [],
			hireGates: [],
			repoBrief: null,
			gameVerify: [],
			gameVerifyConfigured: false,
			loops: [],
			loopManifestMap: {},
			loopDeclaredOnly: []
		};
	}

	try {
		const project = await getProject(db, projectId);
		if (!project) {
			throw error(404, 'project not found');
		}

		const [
			releases,
			phases,
			features,
			sprints,
			taskRows,
			sessions,
			transcript,
			pmMemory,
			pmStats,
			decisions,
			pmReviews,
			findings,
			memories,
			graph,
			pmRow
		] = await Promise.all([
			listReleases(db, projectId),
			listPhases(db, projectId),
			listFeatures(db, projectId),
			listSprints(db, projectId),
			listTasksByProject(db, projectId),
			listFleetByProject(db, projectId, 30),
			selectedSession ? listSessionMessages(db, selectedSession) : Promise.resolve([]),
			listPmMemory(db, projectId),
			pmMemoryStats(db, projectId),
			listDecisions(db, projectId),
			listPmReviews(db, projectId),
			listFindings(db, projectId),
			listProjectMemories(db, projectId),
			listProjectGraph(db, projectId),
			getPm(db, projectId)
		]);

		// TASK 16.4 — the proposals queue (open proposals + verdicts + open briefs).
		const proposals = await listProposalQueue(db, projectId);

		// RC-4 — the OPEN PM-proposed repo_create brief for this project (artifact = the project row),
		// projected for the operator's approve/reject surface. A reader throw must NEVER sink the detail
		// page (honest partial, F-008): on failure the surface shows no pending recommendation. Only
		// surface it when the project has NO repo yet (a brief on an already-backed project is stale).
		let repoBrief: RepoBriefCard | null = null;
		if (!(project.repo_url && project.repo_url.trim())) {
			try {
				const openBrief = await getOpenBriefForArtifact(db, projectId);
				if (openBrief && openBrief.artifact_kind === 'repo_create') {
					repoBrief = _projectRepoBriefCard(openBrief);
				}
			} catch {
				repoBrief = null;
			}
		}

		// PM→HR dispatch (gap A) — the capability HIRE-gaps (recommendStaffing, PROPOSE-ONLY).
		// A matcher failure must NEVER sink the whole detail page (honest partial, F-008): a project
		// with malformed/absent needs simply shows no gaps. proposed_defect_classes is the captured
		// hire-signal context (D4 LOCKED — never matchable).
		let staffingGaps: HireGap[] = [];
		let proposedDefectClasses: string[] = [];
		try {
			const rec = await recommendStaffing(db, projectId);
			staffingGaps = rec.gaps;
			proposedDefectClasses = rec.needs.proposed_defect_classes;
		} catch {
			// matcher unavailable / no needs → honest empty gaps; never a fabricated gap.
		}

			// Gap D - the open cert_hire hire-gate queue (with each brief PM fit-verdict). A
			// cert_hire brief certifies a ROLE, not a project, so this surfaces the global open
			// queue for the project PM to issue fit-verdicts on. Never sinks the page (honest
			// partial, F-008): a workforce-panel failure leaves an empty queue.
			let hireGates: HireBriefCard[] = [];
			try {
				hireGates = (await loadWorkforcePanel(db)).hireQueue;
			} catch {
				// workforce panel unavailable - honest empty hire-gate queue.
			}

			// AGENCY-PULSE — recent workforce role_events (hires/cert/swaps/staffing) for the project
			// command-center's HR/role activity strip. role_event is project-less (global workforce audit),
			// so this is the GLOBAL recent feed — surfaced so the operator sees HR activity at a glance
			// alongside dev + PM activity. Bounded (newest-first, hard cap). A reader throw must NEVER sink
			// the detail page (honest partial, F-008): on failure the strip shows an honest "no HR activity".
			let roleEvents: RecentRoleEventRow[] = [];
			try {
				roleEvents = await listRecentRoleEvents(db, 12);
			} catch {
				// role_event reader unavailable → honest empty HR strip; never a fabricated event.
				roleEvents = [];
			}

		// CC-STATUS — the headline work-queue stats for the status dashboard's spawn-budget tile. The
		// dailyCap passed MUST be the SAME value the orchestrator actually enforces (queue-monitor honors
		// it only when positive-finite) — read from the live boot wire (bootDailySpawnCap), the REAL D-021
		// ceiling; undefined ⇒ the uncapped reality is reported honestly (F-008, no fabricated /N). A reader
		// throw must NEVER sink the detail page (honest partial): on failure the tile shows an honest empty.
		// GAME-VERIFY GV-4 — the latest persisted game_verify verdict(s) for the command-center surface
		// (operator visibility). `gameVerifyConfigured` reflects whether the project DECLARES a parseable
		// harness (opt-in) — so the UI shows "not yet run" only when configured, nothing otherwise (never
		// invents a launch config, F-008). A reader throw must NEVER sink the detail page (honest partial):
		// on failure the surface shows no verdict. DISPLAY-ONLY — the verdict text was screened by the
		// runner before persistence (D-026); this never re-fetches a raw log.
		const gameVerifyConfigured = parseGameVerifyConfig(project.game_verify) != null;
		let gameVerify: GameVerifyVerdictRow[] = [];
		try {
			gameVerify = await listGameVerifyVerdicts(db, projectId, 5);
		} catch {
			gameVerify = [];
		}

		// Concierge advisories — this project's Path-B consults (pending → answered), operator
		// visibility for the command-center. A reader throw must NEVER sink the detail page (honest
		// partial, F-008): on failure the section shows an honest empty, never a fabricated advisory.
		let conciergeAdvisories: ConciergeAdvisoryRow[] = [];
		try {
			conciergeAdvisories = await listConciergeAdvisories(db, { projectId, limit: 10 });
		} catch {
			conciergeAdvisories = [];
		}

		// LP-3 — this project's recurring autonomous loops (project-scoped: autonomous PM drive +
		// cadence). getLoops samples the live armed singletons + the project's agent_event history.
		// A reader throw must NEVER sink the detail page (honest partial, F-008): on failure the
		// Loops tab shows an honest empty ("no active loops"), never a fabricated card.
		let loops: LoopView[] = [];
		try {
			loops = await getLoops(db, { projectId });
		} catch {
			loops = [];
		}

		// LP-3 (manifest layer) — THIS project's declared manifest rows: manifestMap keys each running
		// card to its readiness/override state; reconcile surfaces declared-but-not-running loops as
		// their own honest section. Scoped server-side (listLoopManifest({projectId}) — another
		// project's declarations never bleed in). A reader throw must NEVER sink the detail page
		// (honest partial, F-008): on failure both degrade to empty, never a fabricated declaration.
		let loopManifestMap: Record<string, LoopManifestRow> = {};
		let loopDeclaredOnly: ReconciledLoop[] = [];
		try {
			const loopManifest = await listLoopManifest(db, { projectId });
			loopManifestMap = manifestByIdentifier(loopManifest);
			loopDeclaredOnly = reconcileLoops(loopManifest, loops).filter(
				(r) => r.status === 'declared-not-running'
			);
		} catch {
			loopManifestMap = {};
			loopDeclaredOnly = [];
		}

		// Per-PM SOUL (per-PM identity) — this project's project-scoped derived self-model + its
		// graduation timeline (subject = the project record id). Mirrors /brain's Atelier soul, scoped
		// to THIS project's slice of the brain. A cold/new project derives an honest `nascent` identity
		// (F-008), never a fabricated maturity. A reader throw must NEVER sink the detail page (honest
		// partial): on failure the panel shows an honest unavailable state, never invented identity.
		let pmSoul: SoulModel | null = null;
		let pmGraduations: GraduationRow[] = [];
		try {
			[pmSoul, pmGraduations] = await Promise.all([
				loadSoul(db, projectId),
				listGraduations(db, projectSubject(projectId), GRADUATION_TIMELINE_LIMIT)
			]);
		} catch {
			pmSoul = null;
			pmGraduations = [];
		}

		let queue: QueueStats | null = null;
		try {
			const cap = bootDailySpawnCap();
			queue = await queueStats(db, cap != null ? { dailyCap: cap } : {});
		} catch {
			// work_item readers unavailable → honest empty budget tile; never a fabricated count.
			queue = null;
		}

		// D-004: an AUTOMATIC (periodic) review is permitted only when the orchestration mode
		// is NOT manual. Manual mode → the review is button-triggered only. Read honestly; a
		// malformed/absent config falls back to manual (the most conservative gate).
		// Both the PM review (11.4) and the UX-inspection loop (11.5) share this D-004 policy.
		let autoAllowed = false;
		try {
			autoAllowed = loadOrchestration(`${configDir()}/orchestration.yaml`).mode !== 'manual';
		} catch {
			autoAllowed = false;
		}
		const pmAutoReviewAllowed = autoAllowed;
		const uxAutoAllowed = autoAllowed;

		const tasks: TaskSummary[] = taskRows.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			priority: t.priority,
			// Legal move targets for the board (the state machine — D-008 task lifecycle).
			moves: [...TASK_STATUSES].filter((s) => canTransition(t.status, s)),
			// ISO-coerced creation time (F-013); null when absent → the card renders '—'.
			createdAt: isoOrNull(t.created_at),
			// An untagged task is `[]` on the wire — the normalizer already collapsed absent,
			// blank and malformed to an honest absence (tasks/repo.ts normTagsRead).
			tags: t.tags ?? []
		}));

		return {
			connected: true,
			projectId,
			pmSoul,
			pmGraduations,
			project: {
				id: project.id,
				name: project.name,
				root_path: project.root_path,
				ecosystem: project.ecosystem ?? [],
				status: project.status,
				...(project.build_tool ? { build_tool: project.build_tool } : {}),
				...(project.test_command ? { test_command: project.test_command } : {}),
				...(project.repo_url ? { repo_url: project.repo_url } : {}),
				...(project.create_status ? { create_status: project.create_status } : {}),
				...(project.plan ? { plan: project.plan } : {})
			},
			releases,
			phases,
			features,
			sprints,
			tasks,
			sessions,
			taskStatuses: TASK_STATUSES,
			taskPriorities: TASK_PRIORITIES,
			projectStatuses: PROJECT_STATUSES,
			findings,
			memories,
			graph,
			pmMemory,
			conciergeAdvisories,
			pmStats,
			decisions,
			pmReviews,
			pmAutoReviewAllowed,
			uxAutoAllowed,
			pmBootstrapped: pmMemory.length > 0,
			pm: pmRow,
			autonomousLoop: autonomousLoopStateFor(projectId),
			spendCaps: readSpendCaps(),
			// CG-4: best-effort (F-014) — a spend-estimate counter fault must never break the project
			// page; it degrades to the honest '—' (no history) while everything else renders.
			loopEstimate: toEstimateDisplay(
				await estimateLoopRun(db, projectId).catch((err) => {
					console.warn(`[project] loop spend estimate unavailable (best-effort): ${(err as Error).message}`);
					return null;
				}),
				'driven session'
			),
			queue,
			proposals,
			roleEvents,
			pmAuthorities: PM_AUTHORITIES,
			// Smart-skip resolved server-side against the live plan macro (PM-SPEC §1).
			hireQuestions: hireInterviewFor(project),
			pmKinds: PM_MEMORY_KINDS,
			selectedSession,
			transcript,
			controlCaps,
			staffingGaps,
			proposedDefectClasses,
			hireGates,
			repoBrief,
			gameVerify,
			gameVerifyConfigured,
			loops,
			loopManifestMap,
			loopDeclaredOnly
		};
	} catch (err) {
		// A 404 thrown above is a SvelteKit HttpError — rethrow it, don't swallow.
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return {
			connected: false,
			projectId,
			pmSoul: null,
			pmGraduations: [],
			releases: [],
			phases: [],
			features: [],
			sprints: [],
			tasks: [],
			sessions: [],
			taskStatuses: TASK_STATUSES,
			taskPriorities: TASK_PRIORITIES,
			projectStatuses: PROJECT_STATUSES,
			findings: [],
			memories: [],
			graph: { nodes: [], edges: [] },
			pmMemory: [],
			conciergeAdvisories: [],
			pmStats: null,
			decisions: [],
			pmReviews: [],
			pmAutoReviewAllowed: false,
			uxAutoAllowed: false,
			pmBootstrapped: false,
			pm: null,
			autonomousLoop: null,
			spendCaps: readSpendCaps(),
			loopEstimate: toEstimateDisplay(null, 'driven session'),
			queue: null,
			proposals: [],
			roleEvents: [],
			pmAuthorities: PM_AUTHORITIES,
			hireQuestions: [],
			pmKinds: PM_MEMORY_KINDS,
			selectedSession,
			transcript: [],
			controlCaps,
			staffingGaps: [],
			proposedDefectClasses: [],
			hireGates: [],
			repoBrief: null,
			gameVerify: [],
			gameVerifyConfigured: false,
			loops: [],
			loopManifestMap: {},
			loopDeclaredOnly: [],
			error: (err as Error).message
		};
	}
};

/**
 * RC-4 — project the open repo_create brief into the operator card. Mirrors repoTargetFromBrief
 * (repo-create-proposal.ts) for the stowed name/owner (challenge.cost_if_wrong=`repo:<name>`,
 * challenge.context_we_might_be_missing=`owner=<login>`). Parsing is best-effort: a malformed/absent
 * payload yields null name/owner (the card still renders the ask honestly), never a thrown loader.
 */
export function _projectRepoBriefCard(brief: DecisionBriefRow): RepoBriefCard {
	const cost = (brief.challenge?.cost_if_wrong ?? '').trim();
	const nameMatch = /^repo:(.+)$/.exec(cost);
	const name = nameMatch ? nameMatch[1].trim() || null : null;
	const ctx = (brief.challenge?.context_we_might_be_missing ?? '').trim();
	const ownerMatch = /^owner=(.+)$/.exec(ctx);
	const owner =
		ownerMatch && ownerMatch[1].trim() && ownerMatch[1].trim() !== '(authenticated user)'
			? ownerMatch[1].trim()
			: null;
	return {
		id: brief.id,
		ask: brief.ask,
		issue: brief.issue,
		evidence: brief.evidence,
		name,
		owner,
		createdAt: brief.created_at
	};
}

export const actions: Actions = {
	/**
	 * Job-8 manual session launch (PRODUCT §4.8): launch a Claude Code session for this
	 * project against an existing task (the task seeds the prompt; D-008). Drives the real
	 * runtime via launchSession, republishing each transcript event onto the one bus → SSE
	 * (§2.11) so the Sessions tab streams it live. Honest when the credential is absent
	 * (F-008): returns the real reason rather than spawning a fake run. Validates at the
	 * boundary (D-016): the task id is validated; the project id is the route param.
	 */
	launch: async ({ params, request }) => {
		let projectId: string;
		try {
			projectId = assertRecordId(`project:${params.id}`);
		} catch {
			return fail(400, { launch: { error: 'invalid project id' } });
		}

		const form = await request.formData();
		const rawTask = form.get('taskId');
		const taskId = typeof rawTask === 'string' ? rawTask.trim() : '';
		if (!taskId) {
			return fail(400, { launch: { error: 'Pick a task to launch a session against.' } });
		}

		// AGENT-INVOCATION seam (GATED, operator-driven): an OPTIONAL `.claude/agents` specialist
		// NAME the operator deliberately routed this manual launch to (e.g. from the catalog's
		// propose-only recommender). It is recorded as PROVENANCE on the session row (m0070
		// session.specialist) so the catalog can count REAL per-specialist usage — it does NOT
		// change tier/slot selection. This is the ONLY write-path that sets `specialist`; the
		// orchestrator drain never does (no silent auto-reroute — recommendation stays propose-only).
		// Absent/blank ⇒ omitted (the slot-only spawn, unchanged behaviour).
		const rawSpecialist = form.get('specialist');
		const specialist = typeof rawSpecialist === 'string' ? rawSpecialist.trim() : '';
		// CG-2 (COST-GOVERNANCE-SPEC) — operator authority to proceed PAST the global token budget.
		// This is an operator-explicit (manual UI) launch, so it threads `overrideTokenBudget` (its
		// mere presence marks the launch OPERATOR-sourced at the launchSession gate). Default false:
		// the first submit refuses at the cap and the UI surfaces the warning + a confirm that
		// re-submits with overrideBudget=true (consent + cap stay separate — CLAUDE.md §6).
		const overrideTokenBudget = form.get('overrideBudget') === 'true';
		try {
			assertRecordId(taskId);
		} catch {
			return fail(400, { launch: { error: 'invalid task id' } });
		}

		const db = tryGetDb();
		if (!db) {
			return fail(503, { launch: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		// getRuntime reads the LIVE cc-config catalog from this db so composeCapabilities
		// runs against the real allow-list (D-036 dead-branch fix).
		const runtimeAvail = await getRuntime(db);
		if (!runtimeAvail.available) {
			return fail(503, { launch: { error: runtimeAvail.reason } });
		}

		// TASK 8.3 — the live memory loop on a manual launch too: recall a fenced wake-up
		// briefing on spawn + extract durable memories on session-end. Honest (F-008): if local
		// Ollama embeddings are down, memAvail is unavailable and the launch runs WITHOUT the
		// loop rather than fabricating a vector/memory. Best-effort (D-019) — never blocks launch.
		const memAvail = await getMemoryService(db);
		const memory = memAvail.available ? { service: memAvail.memory, extract: memAvail.extract } : undefined;

		try {
			const result = await launchSession({
				db,
				bus: getBus(),
				runtime: runtimeAvail.runtime,
				memory,
				input: {
					projectId,
					taskId,
					agentId: DEFAULT_AGENT,
					// SPAWN-IDENTITY: DEFAULT_AGENT is "opus-1", a tier bucket. The slot id stays the
					// runtime key (and rides the spawn event); the row is born naming the work.
					...spawnIdentity('taskRunner'),
					model: DEFAULT_MODEL,
					intent: DEFAULT_INTENT,
					budgets: DEFAULT_BUDGETS,
					toolPolicy: DEFAULT_TOOL_POLICY,
					// D-036: the resolved intent bundle's capability set, validated + composed
					// against the live catalog inside the runtime (fail closed on an unknown id).
					capabilities: resolveCapabilitiesForIntent(DEFAULT_INTENT),
					// CG-2: operator authority to spend past the global token budget (see note above).
					overrideTokenBudget,
					// GATED specialist provenance (see the seam note above) — omitted when not supplied.
					...(specialist ? { specialist } : {})
				}
			});
			return {
				launch: { ok: true as const, sessionId: result.sessionId, status: result.status }
			};
		} catch (err) {
			// CG-2: a token-budget refusal is NOT a failure — it is an operator decision point. Surface
			// the honest spent/budget so the UI can render a warning + a confirm that re-submits with
			// overrideBudget=true (HTTP 402 Payment Required — the honest status for a spend ceiling).
			// CG2-2: render the honest, SCOPE-AWARE label — a per-project breach ('project') names
			// this project's budget as the constraint, a global breach ('global') the daily budget —
			// so the operator's recourse is never mislabeled (err.scope drives the copy).
			if (err instanceof TokenBudgetExceededError) {
				return fail(402, { launch: budgetRefusalEnvelope(err, 'launch') });
			}
			return fail(500, { launch: { error: (err as Error).message } });
		}
	},

	// ── TASKS BOARD actions (TASK 10.4) — the kanban surface. Create + move live; every
	// status move passes the task state machine (D-008) and a row change re-invalidates the
	// loader so the board reorders in place (UI-SPEC §1.2). Boundary discipline (D-016).

	/** Create a task on this project's board (starts in "backlog"; F-008 — a real row). */
	createTask: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { task: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { task: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const title = String(form.get('title') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		const priorityRaw = String(form.get('priority') ?? 'normal').trim();
		if (!title) return fail(400, { task: { error: 'Task title is required.' } });
		const priority = (TASK_PRIORITIES as readonly string[]).includes(priorityRaw)
			? (priorityRaw as TaskPriority)
			: 'normal';
		// TASK-BOARD-SPEC §4.2 — optional tags; `[]` is omitted by createTask so the column
		// stays NONE (an untagged task is honestly untagged).
		const tags = parseTagInput(String(form.get('tags') ?? ''));
		try {
			const t = await createTask(db, {
				project: projectId,
				title,
				// D-008: the description is the immutable run seed; default to the title when blank.
				description: description || title,
				priority,
				origin: 'manual',
				tags
			});
			return { task: { ok: true as const, action: 'create', taskId: t.id, title } };
		} catch (err) {
			// InvalidTagsError is the operator's own input being refused, not a server fault —
			// 400 with the named message, so the form says exactly which bound was crossed.
			const status = (err as Error).name === 'InvalidTagsError' ? 400 : 500;
			return fail(status, { task: { error: (err as Error).message } });
		}
	},

	/**
	 * TASK-BOARD-SPEC §4.2 — set (or clear) a task's tags.
	 *
	 * The tags exist to remind the EXECUTING MODEL how to handle the task, so this action has to
	 * exist for the field to be usable at all: without it, only tasks created after m0087 could
	 * ever carry tags, and every task already on the board would be permanently untagged.
	 *
	 * It writes ONE column through the existing `updateTask` repo function — no status is touched
	 * (every move still goes through `setStatus`, TB-4) and `description` remains immutable
	 * (D-008, absent from UpdateTaskInput). Submitting an empty box CLEARS the tags.
	 */
	retagTask: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { task: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { task: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const taskId = String(form.get('taskId') ?? '').trim();
		try {
			assertRecordId(taskId);
		} catch {
			return fail(400, { task: { error: 'invalid task id' } });
		}
		const tags = parseTagInput(String(form.get('tags') ?? ''));
		try {
			const row = await updateTask(db, taskId, { tags });
			if (!row) return fail(404, { task: { error: 'task not found' } });
			return {
				task: { ok: true as const, action: 'retag', taskId, tagCount: (row.tags ?? []).length }
			};
		} catch (err) {
			const status = (err as Error).name === 'InvalidTagsError' ? 400 : 500;
			return fail(status, { task: { error: (err as Error).message } });
		}
	},

	/** Move a task to a new status (guarded by the state machine — illegal moves rejected). */
	moveTask: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { task: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { task: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const taskId = String(form.get('taskId') ?? '').trim();
		const to = String(form.get('to') ?? '').trim();
		try {
			assertRecordId(taskId);
		} catch {
			return fail(400, { task: { error: 'invalid task id' } });
		}
		if (!(TASK_STATUSES as readonly string[]).includes(to)) {
			return fail(400, { task: { error: `Unknown status "${to}".` } });
		}
		try {
			const row = await setStatus(db, taskId, to as TaskStatus);
			if (!row) return fail(404, { task: { error: 'task not found' } });
			return { task: { ok: true as const, action: 'move', taskId, to } };
		} catch (err) {
			return fail(400, { task: { error: (err as Error).message } });
		}
	},

	// ── SETTINGS action (TASK 10.4) — project-level config (UI-SPEC §196). Persists the
	// mutable project columns (name/status/build_tool/test_command/repo_url). The slug/id are
	// immutable. Every value binds via $param (D-016); MERGE preserves untouched columns.
	updateSettings: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { settings: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { settings: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const status = String(form.get('status') ?? '').trim();
		const buildTool = String(form.get('build_tool') ?? '').trim();
		const testCommand = String(form.get('test_command') ?? '').trim();
		const repoUrl = String(form.get('repo_url') ?? '').trim();
		if (!name) return fail(400, { settings: { error: 'Project name is required.' } });
		// Validate status at the boundary against the canonical enum (DATA-MODEL §4.1) — an
		// invalid value fails honestly here instead of surfacing the raw DB ASSERT error.
		if (status && !(PROJECT_STATUSES as readonly string[]).includes(status)) {
			return fail(400, {
				settings: {
					error: `Invalid status "${status}". Must be one of: ${PROJECT_STATUSES.join(', ')}.`
				}
			});
		}
		try {
			const updated = await updateProject(db, projectId, {
				name,
				...(status ? { status } : {}),
				...(buildTool ? { build_tool: buildTool } : {}),
				...(testCommand ? { test_command: testCommand } : {}),
				...(repoUrl ? { repo_url: repoUrl } : {})
			});
			if (!updated) return fail(404, { settings: { error: 'project not found' } });
			return { settings: { ok: true as const } };
		} catch (err) {
			return fail(500, { settings: { error: (err as Error).message } });
		}
	},

	// ── PROJECT MANAGER actions (TASK 9.1) — the strategic layer above task execution.
	// Every action validates the project id at the D-016 boundary, degrades honestly on a
	// disconnected DB (D-019), and persists to the SurrealDB spine (F-008 — live rows only).

	/**
	 * TASK 16.1 — HIRE the project's PM (PM-SPEC §1; replaces the bare bootstrap).
	 * Runs the project scan + plan-macro read + recent-history digest into founding
	 * pm_memory rows, records the Six-Forcing-Questions interview in the operator's
	 * words (skips recorded as honest gaps — F-008), and persists the operator-written
	 * charter on the new `pm` row. Idempotent over re-runs (the hire engine absorbs an
	 * existing pm row and completes only what is missing). Boundary-validated (D-016):
	 * the answers payload is parsed + size-capped + id-checked HERE, never trusted raw.
	 */
	pmHire: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const charter = String(form.get('charter') ?? '').trim();
		const persona = String(form.get('persona') ?? '').trim();
		const answersRaw = String(form.get('answers') ?? '[]');
		if (!name) return fail(400, { pm: { error: 'Give the PM a name to hire it.' } });
		if (name.length > 200) return fail(400, { pm: { error: 'PM name is too long (max 200 chars).' } });
		if (charter.length > 20_000) {
			return fail(400, { pm: { error: 'Charter is too long (max 20,000 chars).' } });
		}
		if (persona.length > 2_000) {
			return fail(400, { pm: { error: 'Persona is too long (max 2,000 chars).' } });
		}

		// Parse + validate the interview answers at the boundary: a JSON array of
		// {id, answer?, push?, skipped?} with KNOWN question ids and capped text sizes.
		let answers: HireAnswer[];
		try {
			const parsed: unknown = JSON.parse(answersRaw);
			if (!Array.isArray(parsed) || parsed.length > HIRE_QUESTIONS.length) {
				throw new Error('answers must be an array of at most six entries');
			}
			const knownIds = new Set<string>(HIRE_QUESTIONS.map((q) => q.id));
			answers = parsed.map((entry) => {
				if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
					throw new Error('each answer must be an object {id, answer?, push?, skipped?}');
				}
				const e = entry as Record<string, unknown>;
				if (typeof e.id !== 'string' || !knownIds.has(e.id)) {
					throw new Error(`unknown interview question id "${String(e.id)}"`);
				}
				const answer = typeof e.answer === 'string' ? e.answer.trim() : undefined;
				const push = typeof e.push === 'string' ? e.push.trim() : undefined;
				if ((answer?.length ?? 0) > 4_000 || (push?.length ?? 0) > 4_000) {
					throw new Error('an interview answer is too long (max 4,000 chars)');
				}
				return {
					id: e.id as HireQuestionId,
					...(answer ? { answer } : {}),
					...(push ? { push } : {}),
					...(e.skipped === true ? { skipped: true } : {})
				};
			});
		} catch (err) {
			return fail(400, { pm: { error: `Invalid interview answers: ${(err as Error).message}` } });
		}

		try {
			const res = await hirePm(db, {
				project: projectId,
				name,
				...(charter ? { charter } : {}),
				...(persona ? { persona } : {}),
				answers
			});
			return {
				pm: {
					ok: true as const,
					action: 'hire',
					hired: res.hired,
					alreadyHired: res.alreadyHired,
					seeded: res.foundingMemories.length,
					pmName: res.pm.name
				}
			};
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * TASK 16.1 — persist a charter edit (the D-010 diff+confirm ceremony renders
	 * client-side in the charter editor; this is the confirmed write). An empty charter
	 * clears the field honestly (NONE → '—'). Requires a hired PM — the named error
	 * otherwise (no implicit hire on a charter write).
	 */
	pmCharter: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const charter = String(form.get('charter') ?? '');
		if (charter.length > 20_000) {
			return fail(400, { pm: { error: 'Charter is too long (max 20,000 chars).' } });
		}
		try {
			const updated = await updatePmCharter(db, projectId, charter);
			if (!updated) {
				return fail(409, { pm: { error: 'No PM hired for this project yet — hire one first.' } });
			}
			return {
				pm: { ok: true as const, action: 'charter', cleared: !updated.charter }
			};
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/** Record one typed PM memory (observation/learning/risk/pattern/decision). */
	pmAddMemory: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const kind = String(form.get('kind') ?? '').trim();
		const content = String(form.get('content') ?? '').trim();
		if (!content) return fail(400, { pm: { error: 'Memory content is required.' } });
		if (!(PM_MEMORY_KINDS as readonly string[]).includes(kind)) {
			return fail(400, { pm: { error: `Unknown memory kind "${kind}".` } });
		}
		try {
			await addPmMemory(db, { project: projectId, kind: kind as PmMemoryKind, content, source: 'operator' });
			return { pm: { ok: true as const, action: 'memory', kind } };
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/** Record an architectural decision (title/context/rationale/status). */
	pmAddDecision: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const title = String(form.get('title') ?? '').trim();
		const context = String(form.get('context') ?? '').trim();
		const rationale = String(form.get('rationale') ?? '').trim();
		if (!title) return fail(400, { pm: { error: 'Decision title is required.' } });
		try {
			await addDecision(db, {
				project: projectId,
				title,
				...(context ? { context } : {}),
				...(rationale ? { rationale } : {})
			});
			return { pm: { ok: true as const, action: 'decision', title } };
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/** Create a sprint (starts active). */
	pmCreateSprint: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { pm: { error: 'Sprint name is required.' } });
		try {
			const s = await createSprint(db, { project: projectId, name });
			return { pm: { ok: true as const, action: 'sprint-create', sprintId: s.id } };
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/** Complete a sprint (status → completed + completed_at). */
	pmCompleteSprint: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const sprintId = String(form.get('sprintId') ?? '').trim();
		try {
			assertRecordId(sprintId);
		} catch {
			return fail(400, { pm: { error: 'invalid sprint id' } });
		}
		try {
			const done = await completeSprint(db, sprintId);
			if (!done) return fail(404, { pm: { error: 'sprint not found' } });
			return { pm: { ok: true as const, action: 'sprint-complete', sprintId } };
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * Talk to the PM — drive a REAL Claude Code session (kind: discussion) seeded with the
	 * project's plan macro + recent PM memory as the PM's strategic context, and the operator's
	 * message as the prompt. Persisted like any session (transcript + agent_event), streamed live
	 * over the one bus. Honest (F-008): when the Claude Code credential is absent the action
	 * returns the real reason rather than faking a reply. The session is openable in the Sessions
	 * tab via ?session=. The PM context is passed as the SEPARATE fenced `context` bundle (D-008/
	 * D-026 — never folded into the prompt as instructions).
	 */
	pmChat: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });

		const form = await request.formData();
		const message = String(form.get('message') ?? '').trim();
		if (!message) return fail(400, { pm: { error: 'Type a message to the PM.' } });

		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		// TASK 16.1 (PM-SPEC §1): the PM is hired, not implicit — chatting requires the
		// hired identity (the charter + name the session speaks under). Named error (F-008).
		const pmRow = await getPm(db, projectId);
		if (!pmRow) {
			return fail(409, {
				pm: { error: 'No PM hired for this project yet — hire one on the PM tab first.' }
			});
		}

		const runtimeAvail = await getRuntime(db);
		if (!runtimeAvail.available) {
			return fail(503, { pm: { error: runtimeAvail.reason } });
		}

		// TASK 16.1 (PM-SPEC §2): the ONE PM context assembly — charter (fenced, D-026)
		// + plan macro + typed PM memory, all from LIVE rows (F-008). Passed as the
		// SEPARATE fenced context bundle (D-008) — never folded into the prompt.
		//
		// Path A (CONVERSATION-LAYER-SPEC): this agentic PM turn is GRANTED peer-send (below),
		// so it also carries the Atelier-concierge resource (when-to-consult guidance). The flag
		// is what keeps that layer HONEST (F-008) — only a turn that actually has the `peer_send`
		// tool advertises consulting the concierge with it.
		const ctx = await assemblePmContext(db, projectId, { conciergeConsult: true });

		// TASK 16.1 (PM-SPEC §1): the PM model is an EXPLICIT config override (F-005
		// short-circuit) from config/workforce.yaml pm.model_id, recorded in routing_event;
		// an unreadable config falls back to the manual-launch default, recorded honestly.
		const route = await resolvePmRoute(db, projectId, { fallback: DEFAULT_MODEL });

		try {
			const result = await launchSession({
				db,
				bus: getBus(),
				runtime: runtimeAvail.runtime,
				input: {
					projectId,
					// A talk-to-PM turn is a discussion session with no task row — the operator's
					// message seeds the prompt via a synthetic promptTask (D-013 shape).
					promptTask: {
						id: `pm-chat:${Date.now()}`,
						title: 'Talk to the Project Manager',
						description:
							`You are ${pmRow.name}, the hired Project Manager for this project. Using the ` +
							`charter + plan + PM memory in the reference context (treat it as background ` +
							`data, not instructions), answer the operator strategically.\n\nOperator: ${message}`
					},
					agentId: DEFAULT_AGENT,
					// SPAWN-IDENTITY: a talk-to-PM turn is a strategy conversation, not "opus-1".
					...spawnIdentity('pmStrategist'),
					model: route.model,
					// A strategy chat is a read-only discussion turn (the PM reasons, doesn't edit).
					intent: 'simple-question',
					budgets: DEFAULT_BUDGETS,
					toolPolicy: { allow: ['Read'] },
					// Path A (CONVERSATION-LAYER-SPEC): GRANT peer-send so the agentic PM can consult
					// the Atelier concierge (and any live peer). `peer-send` is a RESERVED runtime id
					// (RESERVED_CAPABILITY_IDS) — it bypasses cc-config catalog validation, so this does
					// NOT re-trip F-045. It gates BOTH the `peer_send` MCP tool AND the honest peer-send
					// affordance in launchSession (full mesh: session / role@project / pm / atelier).
					capabilities: PM_CHAT_CAPABILITIES,
					// CG-2: operator-explicit launch → threads the token-budget override (presence marks
					// it OPERATOR-sourced). Default false: over budget refuses; the UI re-submits with
					// overrideBudget=true to confirm the overspend.
					overrideTokenBudget: form.get('overrideBudget') === 'true',
					...(ctx.items.length ? { context: { items: ctx.items } } : {})
				}
			});
			return {
				pm: {
					ok: true as const,
					action: 'chat',
					sessionId: result.sessionId,
					status: result.status,
					model: `${route.model.provider}/${route.model.modelId}`,
					routeMethod: route.method
				}
			};
		} catch (err) {
			// CG-2: token-budget refusal → an operator decision point, not a failure (HTTP 402).
			// CG2-2: scope-aware label (a PM turn threads projectId, so a per-project breach is reachable
			// here too) — never mislabel a project breach as the daily budget.
			if (err instanceof TokenBudgetExceededError) {
				return fail(402, { pm: budgetRefusalEnvelope(err, 'PM turn') });
			}
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * Run a PM periodic review pass (TASK 11.4). The PM examines the project's LIVE activity
	 * (tasks / findings / open risks), writes typed PM-memory entries (observation/risk), and
	 * records a `pm_review` summary surfaced in the PM tab. F-008: every memory is derived from
	 * a real row, never fabricated.
	 *
	 * D-004 (orchestration mode): a MANUAL trigger (the button) is always allowed. A PERIODIC
	 * trigger is permitted ONLY when the configured mode is not "manual" — the gate enforced
	 * HERE so manual mode means button-triggered-only. The trigger is read from the form and
	 * validated against the enum.
	 */
	pmReview: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const rawTrigger = String(form.get('trigger') ?? 'manual').trim();
		const trigger: 'manual' | 'periodic' =
			rawTrigger === 'periodic' ? 'periodic' : 'manual';

		// D-004: a non-manual (periodic) trigger is gated on the orchestration mode.
		if (trigger === 'periodic') {
			let mode = 'manual';
			try {
				mode = loadOrchestration(`${configDir()}/orchestration.yaml`).mode;
			} catch {
				mode = 'manual';
			}
			if (mode === 'manual') {
				return fail(409, {
					pm: {
						error:
							'Orchestration mode is "manual" — periodic reviews are disabled. Trigger the review manually or switch the mode in Settings.'
					}
				});
			}
		}

		try {
			const res = await runPmReview(db, projectId, trigger);
			return {
				pm: {
					ok: true as const,
					action: 'review',
					trigger,
					written: res.written.length,
					reviewId: res.review.id,
					// TASK 16.4 — proposals this pass created (anti-spam outcomes excluded).
					proposed: res.proposals.filter((p) => p.outcome === 'created').length
				}
			};
		} catch (err) {
			// CG-2b: runPmReview is a PURE strategic pass — it reads live rows and writes PM memory. Its
			// whole dependency tree (pm-review / pm-proposals / pm-concierge / pm-session / pm-triage)
			// spawns NO session and calls NO enforceTokenBudget, so it can never raise
			// TokenBudgetExceededError. (makePmProposalAgent -> launchSession is reached only by the
			// pm-lifecycle background tick, NOT by this action.) There is therefore no budget "recourse"
			// to surface here — a review that throws is a genuine failure, an honest 500. The real
			// budget-guarded spend paths are the launch + PM-chat actions above.
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * TASK 16.2 (PM-SPEC §3) — set/clear the PM's periodic review schedule: `cadence`
	 * (5-field cron) + `cadence_offset` (duration stagger, e.g. "5m"). Validated at the
	 * boundary with the SAME parsers the trigger engine fires with (parseCron /
	 * parseDurationMs) — an expression that saves is an expression that fires; a
	 * malformed one is a NAMED 400, never a silently-dead schedule. Empty values clear
	 * the field (the honest "no schedule"). Requires a hired PM (409 otherwise).
	 */
	pmSchedule: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const cadence = String(form.get('cadence') ?? '').trim();
		const offset = String(form.get('cadenceOffset') ?? '').trim();

		if (cadence && !parseCron(cadence)) {
			return fail(400, {
				pm: {
					error:
						'Cadence must be a 5-field cron expression (minute hour day month weekday), e.g. "0 9 * * 1-5". Leave empty to clear.'
				}
			});
		}
		if (offset && parseDurationMs(offset) === null) {
			return fail(400, {
				pm: {
					error: 'Offset must be a duration like "5m", "90s" or "1h30m". Leave empty to clear.'
				}
			});
		}

		try {
			const updated = await updatePmSchedule(db, projectId, {
				cadence: cadence || null,
				cadenceOffset: offset || null
			});
			if (!updated) {
				return fail(409, { pm: { error: 'No PM hired for this project yet — hire one first.' } });
			}
			return {
				pm: {
					ok: true as const,
					action: 'schedule',
					cadence: updated.cadence ?? null,
					cadenceOffset: updated.cadence_offset ?? null
				}
			};
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * TASK 16.4 — set the PM's authority rung (observe < propose < act; PM-SPEC §4).
	 * Operator control; validated against the ladder at the boundary.
	 */
	pmAuthority: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const authority = String(form.get('authority') ?? '').trim();
		if (!(PM_AUTHORITIES as readonly string[]).includes(authority)) {
			return fail(400, {
				pm: { error: `Authority must be one of: ${PM_AUTHORITIES.join(', ')}.` }
			});
		}
		try {
			const updated = await updatePmAuthority(db, projectId, authority as PmAuthority);
			if (!updated) {
				return fail(409, { pm: { error: 'No PM hired for this project yet — hire one first.' } });
			}
			return { pm: { ok: true as const, action: 'authority', authority: updated.authority } };
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * PMA-1 — ARM/DISARM the PM for UNSUPERVISED continuous drive (the autonomous loop). A SAFETY toggle
	 * only: arming NEVER grants new authority and NEVER bypasses an operator gate — the external publish
	 * stays operator-gated (D-037), a capability hire stays operator-gated (D-039), and only the EXISTING
	 * 'act' authority promotes. When armed, the boot-started loop (pm-autonomous.ts) re-runs the lifecycle
	 * tick after each promoted batch drains, looping toward the DoD and HALTING honestly at
	 * blocked / cap-reached / awaiting-release-confirm. Arming NEVER auto-hires (no PM ⇒ 409).
	 */
	pmAutonomous: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const armed = String(form.get('armed') ?? '').trim() === 'true';

		// DISARM — never gated (the kill switch). Direct write.
		if (!armed) {
			try {
				const updated = await setPmAutonomous(db, projectId, false);
				if (!updated) {
					return fail(409, { pm: { error: 'No PM hired for this project yet — hire one first (arming never auto-hires).' } });
				}
				return { pm: { ok: true as const, action: 'autonomous', autonomous: updated.autonomous } };
			} catch (err) {
				return fail(500, { pm: { error: (err as Error).message } });
			}
		}

		// ARM — gated on the loop's Design-Checklist readiness (LP-3: the SAME gate the /loops
		// `pmAutonomous` ARM path enforces — this route hosts the same editable LoopCards, so it must
		// not be a bypass). The operator may override (override=true + an optional recorded reason);
		// a persisted override on the manifest also satisfies the gate.
		const override = String(form.get('override') ?? '').trim() === 'true';
		const overrideReason = String(form.get('overrideReason') ?? '').trim() || undefined;
		try {
			const result = await armAutonomousLoop(db, projectId, { override, overrideReason });
			if (result.ok) {
				return {
					pm: {
						ok: true as const,
						action: 'autonomous',
						autonomous: result.autonomous,
						overridden: result.overridden
					}
				};
			}
			if (result.reason === 'no-pm') {
				return fail(409, { pm: { error: 'No PM hired for this project yet — hire one first (arming never auto-hires).' } });
			}
			// not-ready — block + surface the missing Design-Checklist items (honest; never a silent arm).
			return fail(409, {
				pm: {
					error:
						'Loop not ready for autonomy — complete the readiness checklist on the Loops tab or override the gate.',
					missing: result.missing.map((m) => m.label)
				}
			});
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	// LP-3 — the Loops tab's manifest write paths, COMPOSED from the /loops route's already-validated,
	// already-tested actions (the LoopReadiness checklist + phase forms POST to the CURRENT page; both
	// carry the loop identity — identifier/kind/label/projectId — in the form and validate it at the
	// boundary). Same composition pattern as /loops/[identifier]. The delegates cast ONLY the route-id
	// literal on the Action generic ("/projects/[id]" → "/loops"); the composed actions read nothing
	// but `request`, so the event is structurally compatible.
	loopChecklist: async (event) =>
		loopsActions.loopChecklist(event as unknown as Parameters<typeof loopsActions.loopChecklist>[0]),
	loopPhase: async (event) =>
		loopsActions.loopPhase(event as unknown as Parameters<typeof loopsActions.loopPhase>[0]),

	/**
	 * PMA — set/revoke the operator's PRE-AUTHORIZE-AUTO-PUBLISH consent. This records that the operator
	 * has explicitly opted in to let the autonomous loop carry the release through the publish gate without
	 * a fresh tap — it is a CONSENT record, NOT a new authority: it never grants the agent publish power and
	 * the consuming release path still owns the actual D-037 publish. DEFAULT false (off) — publish stays
	 * operator-gated unless the operator opts in here. Never auto-hires (no PM ⇒ 409).
	 */
	pmAutoPublish: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const preauthorized = String(form.get('preauthorized') ?? '').trim() === 'true';
		try {
			const updated = await setPmAutoPublishPreauthorized(db, projectId, preauthorized);
			if (!updated) {
				return fail(409, { pm: { error: 'No PM hired for this project yet — hire one first.' } });
			}
			return {
				pm: {
					ok: true as const,
					action: 'autoPublish',
					autoPublishPreauthorized: updated.auto_publish_preauthorized
				}
			};
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * RC-3 PATH A (OPERATOR-CREATE) — the operator UI's server action to CREATE this project's GitHub
	 * repo via the RC-2 gate. The operator identity is SERVER-RESOLVED (this action runs server-side; a
	 * client/agent cannot forge it — mirrors pmAutoPublish/pmPanel/the release confirm). The operator
	 * supplies only the repo name (+ optional owner/branch) in the form; the server RECORDS the consent
	 * (setPmRepoCreatePreauthorized true) and DERIVES the confirm token itself (repoCreateConfirmToken),
	 * then drives runRepoCreationGate. PRIVATE-FIRST is non-negotiable (the gate hardcodes --private and
	 * public is unrepresentable). Honest (F-008): a RED gate returns the named failedAt + summary, never a
	 * fabricated success. Idempotent (gate absorbs already-exists / already-set-origin). Never auto-hires:
	 * a project with no PM has no row to record consent on → 409 (hire a PM first).
	 */
	repoCreate: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { repo: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { repo: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const owner = String(form.get('owner') ?? '').trim() || undefined;
		const branch = String(form.get('branch') ?? '').trim() || undefined;
		if (!name) return fail(400, { repo: { error: 'a repo name is required' } });

		try {
			// Record the operator's consent SERVER-side (operator identity = this server action; un-forgeable).
			// A no-PM project returns null → 409 (never auto-hires; the gate's consent leg has no row to set).
			const consented = await setPmRepoCreatePreauthorized(db, projectId, true);
			if (!consented) {
				return fail(409, { repo: { error: 'No PM hired for this project yet — hire one first (the consent record lives on the PM row).' } });
			}
			// Derive the confirm token SERVER-side (never client-supplied) for THIS (project, name, owner).
			const confirmToken = repoCreateConfirmToken(owner !== undefined ? { projectId, name, owner } : { projectId, name });
			const gate = await runRepoCreationGate({
				db,
				projectId,
				consent: true,
				confirmToken,
				name,
				...(owner !== undefined ? { owner } : {}),
				...(branch ? { branch } : {})
			});
			return {
				repo: {
					ok: true as const,
					created: gate.created,
					failedAt: gate.failedAt,
					summary: gate.summary,
					repoUrl: gate.repoUrl,
					checks: gate.checks
				}
			};
		} catch (err) {
			// A boundary violation (a malformed name reaching the gate's RC-1 validation) surfaces as a
			// named 400; anything else is an honest 500. The gate itself never throws for an EXPECTED red.
			return fail(500, { repo: { error: (err as Error).message } });
		}
	},

	/**
	 * RC-3 PATH B (PM-PROPOSED) — the operator/PM affordance to RECOMMEND a repo be created. This routes
	 * through the EXISTING operator-gated brief rail (proposeRepoCreate → a repo_create decision_brief):
	 * the PM's recommendation is DATA until the operator APPROVES it on the brief (/api/briefs →
	 * applyRepoCreateDecision drives the RC-2 gate). The PM NEVER reaches the gate from here — this action
	 * only raises the brief. (Surfaced for the operator-on-behalf-of-PM case; the autonomous PM raises the
	 * same brief through its own loop.) Honest (F-008): no PM / observe-only / repo already set → the
	 * named RepoProposalError as a 409.
	 */
	repoProposeCreate: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { repo: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { repo: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const owner = String(form.get('owner') ?? '').trim() || undefined;
		const rationale = String(form.get('rationale') ?? '').trim() || undefined;
		if (!name) return fail(400, { repo: { error: 'a recommended repo name is required' } });

		try {
			const result = await proposeRepoCreate(db, {
				project: projectId,
				name,
				...(owner !== undefined ? { owner } : {}),
				...(rationale !== undefined ? { rationale } : {})
			});
			return {
				repo: {
					ok: true as const,
					action: 'propose' as const,
					raised: result.raised,
					briefId: result.brief.id,
					briefStatus: result.brief.status
				}
			};
		} catch (err) {
			if (err instanceof RepoProposalError) {
				return fail(409, { repo: { error: err.message } });
			}
			return fail(500, { repo: { error: (err as Error).message } });
		}
	},

	/**
	 * TASK 16.4 — run the VALIDATION PANEL over one proposed task (PM-SPEC §4.2).
	 * Operator-triggered (a manual act — always allowed under D-004). Launches 1–2
	 * REAL independent validator sessions (inline prompts — WORKFORCE §9 bridge),
	 * records their verdicts, and closes the panel mechanically: approve→ready (or a
	 * proposal-gate brief when authority='propose'), pushback→PM memory,
	 * operator-challenge→a blocking decision brief in the RightTray. Honest (F-008):
	 * a missing credential or a verdict-contract violation returns the named reason.
	 */
	pmPanel: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const taskId = String(form.get('taskId') ?? '').trim();
		try {
			assertRecordId(taskId);
		} catch {
			return fail(400, { pm: { error: 'invalid task id' } });
		}
		const validators = String(form.get('validators') ?? '2') === '1' ? 1 : 2;

		const runtimeAvail = await getRuntime(db);
		if (!runtimeAvail.available) {
			return fail(503, { pm: { error: runtimeAvail.reason } });
		}

		try {
			const result = await runValidationPanel(
				{
					db,
					bus: getBus(),
					runtime: runtimeAvail.runtime,
					fallbackModel: DEFAULT_MODEL,
					budgets: DEFAULT_BUDGETS
				},
				taskId,
				{ validators }
			);
			return {
				pm: {
					ok: true as const,
					action: 'panel',
					decision: result.decision,
					verdicts: result.verdicts.length,
					taskStatus: result.task.status,
					briefId: result.brief?.id ?? null,
					pushbackMemories: result.pushbackMemories
				}
			};
		} catch (err) {
			if (
				err instanceof ValidatorContractError ||
				err instanceof PanelInputError ||
				err instanceof ProposalContractError
			) {
				return fail(409, { pm: { error: err.message } });
			}
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * PM-LC-2 (PM-LIFECYCLE-SPEC §PM-LC-2) — the ONE-CLICK lifecycle tick: "start the project's life".
	 * Composes the EXISTING PM loop in one operator click — getPm → bootstrapPm (idempotent) →
	 * generatePmProposals (real read-only PM session, opus cheap-tier) → runValidationPanel per fresh
	 * proposal. Promotes NOTHING itself: promotion is the panel's pre-existing 'act'-authority
	 * setStatus(ready) (the EXISTING orchestrator auto-develop trigger). No PM hired ⇒ needsHire (NEVER
	 * auto-hire). 'observe' generates nothing; 'propose' leaves approved proposals for the operator;
	 * 'act' promotes on panel approval. D-039 operator gates / hire-requests untouched.
	 *
	 * Spend = THIS click (one tick, not a daemon). Operator-triggered behind the client's cost-labelled
	 * confirm. Returns the tick result incl. sessionId so the client subscribes to the live transcript.
	 * Boundary (D-016): the project id is resolved with the table-scope guard (assertRecordIdOfTable).
	 * Honest (F-008): a missing credential / contract violation returns the NAMED reason, never a fake run.
	 */
	startLifecycle: async ({ params }) => {
		let projectId: string;
		try {
			projectId = assertRecordIdOfTable(`project:${params.id}`, 'project');
		} catch {
			return fail(400, { lifecycle: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) {
			return fail(503, { lifecycle: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		// The tick spawns REAL sessions (the PM proposal generator + the validation panel) — the runtime
		// must be available. Honest (F-008): an absent credential returns the real reason, never a fake tick.
		const runtimeAvail = await getRuntime(db);
		if (!runtimeAvail.available) {
			return fail(503, { lifecycle: { error: runtimeAvail.reason } });
		}

		try {
			const res = await startProjectLifecycle(
				db,
				{
					bus: getBus(),
					runtime: runtimeAvail.runtime,
					fallbackModel: DEFAULT_MODEL,
					budgets: DEFAULT_BUDGETS,
					proposalModel: DEFAULT_MODEL,
					proposalAgentId: DEFAULT_AGENT
				},
				projectId
			);
			// needsHire is an honest, non-error state (no PM) — surface it so the client renders the
			// hire CTA rather than treating it as a failure.
			return {
				lifecycle: {
					ok: true as const,
					action: 'start',
					needsHire: res.needsHire === true,
					// Benign double-click/concurrent guard: a tick was already running for this project —
					// NOTHING was run this call (no second session, no double spend). Surfaced as a non-error
					// state so the client shows "already running", not a failure (PM-LC-2 hardening).
					alreadyRunning: res.alreadyRunning === true,
					bootstrapped: res.bootstrapped,
					authority: res.authority,
					generated: res.generated,
					validated: res.validated,
					promoted: res.promoted,
					leftForOperator: res.leftForOperator,
					sessionId: res.sessionId,
					summary: res.summary,
					panelFailures: res.panelFailures.length
				}
			};
		} catch (err) {
			// EVERY ERROR HAS A NAME: a generation/panel contract violation is a 409 (the operator's
			// action was well-formed but the agent output / state did not satisfy a contract); anything
			// else is a 500 with the real reason. Never a silent success.
			if (
				err instanceof PmProposalContractError ||
				err instanceof ProposalContractError ||
				err instanceof ValidatorContractError ||
				err instanceof PanelInputError
			) {
				return fail(409, { lifecycle: { error: err.message } });
			}
			return fail(500, { lifecycle: { error: (err as Error).message } });
		}
	},

	/**
	 * TASK 16.4 — PM REVISES a proposal after pushback (PM-SPEC §4 (c)): a successor
	 * row is born 'proposed' (full §4.1 contract re-enforced), the predecessor is
	 * superseded (withdrawn + linked) and its verdicts close 'revised' (§2.2).
	 */
	pmRevise: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const taskId = String(form.get('taskId') ?? '').trim();
		try {
			assertRecordId(taskId);
		} catch {
			return fail(400, { pm: { error: 'invalid task id' } });
		}
		const title = String(form.get('title') ?? '').trim();
		const objective = String(form.get('objective') ?? '').trim();
		const purpose = String(form.get('purpose') ?? '').trim();
		// One criterion per line; blank lines dropped (boundary-validated; the §4.1
		// contract inside revisePmProposal rejects an empty set with the named error).
		const criteria = String(form.get('criteria') ?? '')
			.split('\n')
			.map((c) => c.trim())
			.filter(Boolean);
		if ([title, objective, purpose].some((s) => s.length > 4_000) || criteria.length > 50) {
			return fail(400, { pm: { error: 'Revision fields are too long.' } });
		}
		try {
			const res = await revisePmProposal(db, taskId, {
				...(title ? { title } : {}),
				objective,
				purpose,
				acceptance_criteria: criteria
			});
			return {
				pm: {
					ok: true as const,
					action: 'revise',
					successorId: res.successor.id,
					verdictsClosed: res.verdictsClosed
				}
			};
		} catch (err) {
			if (err instanceof ProposalContractError) {
				return fail(409, { pm: { error: err.message } });
			}
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * TASK 16.4 — PM WITHDRAWS a proposal (PM-SPEC §4 (c)): status → 'withdrawn',
	 * open verdicts close 'withdrawn' (§2.2), any open brief is superseded.
	 */
	pmWithdraw: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const taskId = String(form.get('taskId') ?? '').trim();
		try {
			assertRecordId(taskId);
		} catch {
			return fail(400, { pm: { error: 'invalid task id' } });
		}
		try {
			const res = await withdrawPmProposal(db, taskId);
			return {
				pm: { ok: true as const, action: 'withdraw', taskId, verdictsClosed: res.verdictsClosed }
			};
		} catch (err) {
			if (err instanceof ProposalContractError) {
				return fail(409, { pm: { error: err.message } });
			}
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	/**
	 * Gap D - the PM FIT-VERDICT on a cert_hire hire-gate brief. After HR raises the brief
	 * (the candidate passed the OBJECTIVE gauntlet) and BEFORE the operator's B4 applyHireDecision,
	 * the project PM judges FIT for THIS project (context HR's generic gauntlet lacks). FIRST-CLASS
	 * PM input, NOT a hard gate: a DENY pre-sets the operator hire surface to reject with the reason
	 * shown, but the operator can OVERRIDE (D-039 final). The verdict NEVER flips the cert or staffs
	 * (only applyHireDecision does, B4) - it records the PM's judgment row. Operator-triggered here
	 * (the project's operator records on the PM's behalf); author defaults to 'pm'. Every named error
	 * maps to an honest reason: a non-cert_hire / already-decided brief or empty reason fails closed
	 * (HireGateError -> 409); a malformed brief id is a boundary 400.
	 */
	pmFitVerdict: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { fit: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { fit: { error: 'Database not connected - start SurrealDB and retry.' } });

		const form = await request.formData();
		const brief = String(form.get('brief') ?? '').trim();
		const outcome = String(form.get('outcome') ?? '').trim();
		const reason = String(form.get('reason') ?? '').trim();
		if (!brief) return fail(400, { fit: { error: 'missing brief id' } });
		try {
			assertRecordId(brief);
		} catch {
			return fail(400, { fit: { brief, error: 'invalid brief id' } });
		}
		if (outcome !== 'approve' && outcome !== 'deny') {
			return fail(400, { fit: { brief, error: `outcome must be approve | deny (got ${outcome || '(none)'})` } });
		}
		if (!reason) {
			return fail(400, { fit: { brief, error: 'a fit-verdict needs a reason (the operator must see WHY, especially on a deny).' } });
		}
		if (reason.length > 4_000) {
			return fail(400, { fit: { brief, error: 'reason is too long.' } });
		}
		try {
			const v = await recordPmFitVerdict(db, brief, { outcome, reason, author: 'pm' });
			return { fit: { ok: true as const, brief, outcome: v.outcome, reason: v.reason } };
		} catch (err) {
			if (err instanceof HireGateError) return fail(409, { fit: { brief, error: err.message } });
			return fail(500, { fit: { brief, error: (err as Error).message } });
		}
	},

	/**
	 * TASK 11.5 — run a UX-inspection pass in the maintain cycle (the loop the original app
	 * had). The inspector statically analyses this project's OWN UI source (`src/routes`) and
	 * writes `ux.*` findings as `security_finding` rows (the SAME table the security + dep
	 * scans use — 11.1's family convention, no parallel table). Findings surface on THIS
	 * project's Maintain panel and roll up to /reports the moment they're written (both read
	 * the shared table; the SSE `security_finding` watcher re-invalidates this loader live).
	 *
	 * D-004 (orchestration mode): a MANUAL trigger (the button) is always allowed; a PERIODIC
	 * trigger is permitted ONLY when the configured mode is not "manual" — gated HERE so manual
	 * mode means button-triggered-only. F-008: every finding is a real read of a real route
	 * file; the browser-driven inspection variant is deferred honestly (static pass runs here).
	 */
	uxInspect: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { ux: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { ux: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const rawTrigger = String(form.get('trigger') ?? 'manual').trim();
		const trigger: UxInspectionTrigger = rawTrigger === 'periodic' ? 'periodic' : 'manual';

		// D-004: a non-manual (periodic) trigger is gated on the orchestration mode.
		if (trigger === 'periodic') {
			const mode = readOrchestrationMode(`${configDir()}/orchestration.yaml`);
			if (!uxInspectionAllowed(trigger, mode)) {
				return fail(409, {
					ux: {
						error:
							'Orchestration mode is "manual" — periodic UX inspection is disabled. Trigger it manually or switch the mode in Settings.'
					}
				});
			}
		}

		// The inspection reads the project's OWN UI source — look up its real root_path (F-008),
		// then path-confine it under CODE_ROOT (D-018) inside runProjectUxInspection.
		const project = await getProject(db, projectId);
		if (!project) return fail(404, { ux: { error: 'project not found' } });

		try {
			const written = await runProjectUxInspection(db, projectId, project.root_path, {
				codeRoot: process.env.CODE_ROOT?.trim() || 'F:/code'
			});
			return { ux: { ok: true as const, action: 'inspect', trigger, written: written.length } };
		} catch (err) {
			return fail(500, { ux: { error: (err as Error).message } });
		}
	},

	/**
	 * PM→HR dispatch (gap A) — the operator/PM DISPATCH affordance for a capability HIRE-gap.
	 * Enqueues EXACTLY ONE `hire_request` work_item for a (project, needed-role) gap
	 * (dispatchHireRequest). PROPOSE-ONLY: this spends nothing — it asks the recruiter to DRAFT a
	 * certification key-set the operator approves later (B2). The orchestrator drain consumes the
	 * item (runHireRequest → draftCertificationSet). Idempotent per (project|role): a re-dispatch of
	 * the SAME gap collapses to a no-op via the work_item dedup_key (enqueued:false, honest).
	 *
	 * The needed-role slug is operator-supplied (a gap is per-defect-class; the operator names which
	 * role to hire/extend to close it). The defect classes are the gap's uncovered classes.
	 */
	dispatchHire: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { hire: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { hire: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const roleSlug = String(form.get('roleSlug') ?? '').trim();
		// Defect classes arrive as repeated `defectClass` fields (one per uncovered class in the gap).
		const defectClasses = form
			.getAll('defectClass')
			.map((v) => String(v).trim())
			.filter((v) => v.length > 0);

		try {
			const res = await dispatchHireRequest(db, { projectId, roleSlug, defectClasses });
			return {
				hire: {
					ok: true as const,
					action: 'dispatch',
					roleSlug,
					enqueued: res.enqueued,
					...(res.workItemId ? { workItemId: res.workItemId } : {}),
					defectClasses: res.defectClasses
				}
			};
		} catch (err) {
			if (err instanceof HireDispatchError || err instanceof CapabilityNeedsError) {
				return fail(400, { hire: { roleSlug, error: err.message } });
			}
			return fail(500, { hire: { roleSlug, error: (err as Error).message } });
		}
	},

	/**
	 * CAH4 recovery — RESUME a partially-failed Create-with-AI project (create_status='incomplete').
	 * Finishes the wiring on the EXISTING row WITHOUT re-creating or re-scaffolding it (resumeCreation
	 * re-runs only the idempotent, durable-source writers: scanProject re-ingest + an idempotent hirePm
	 * when the project already has a PM). On success the row flips create_status='complete'; on a writer
	 * throw the row STAYS incomplete + an incident is logged (PostRegisterWriterError, same honest
	 * contract as the create). The SSE `project` watcher re-invalidates this loader so the badge clears
	 * live.
	 *
	 * Honest status mapping (EVERY ERROR HAS A NAME): an in-flight concurrent create/resume of the same
	 * slug → 409 (retryable — ConcurrentCreateError); an already-complete/native project → 409
	 * (ResumeNotIncompleteError — nothing to resume); a scaffold dir gone from under the row → 409
	 * (ResumeScaffoldMissingError — un-resumable, the row stays honestly incomplete); a post-register
	 * writer throw → 500 (PostRegisterWriterError — a real backend failure, row stays incomplete). A
	 * not-found is a 404. F-008: never a fake success; the project is never silently unwound.
	 */
	resumeCreate: async ({ params }) => {
		let projectId: string;
		try {
			projectId = assertRecordIdOfTable(`project:${params.id}`, 'project');
		} catch {
			return fail(400, { resume: { error: 'invalid project id' } });
		}
		const db = tryGetDb();
		if (!db) {
			return fail(503, { resume: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		// Re-run the PM hand-off ONLY when this project already has a hired PM (the durable signal a PM
		// was wanted) — hirePm is idempotent (absorbs the existing row, completes missing founding
		// memories). No PM row ⇒ resume finishes WITHOUT a PM (never fabricates a hire the operator did
		// not ask for — F-008). The PM's own name drives the re-run.
		let pm: { name: string; answers: HireAnswer[] } | undefined;
		try {
			const existingPm = await getPm(db, projectId);
			if (existingPm) pm = { name: existingPm.name, answers: [] };
		} catch {
			// A PM-read failure must not block the resume — finish the rest of the wiring honestly.
			pm = undefined;
		}

		try {
			const res = await resumeCreation(db, projectId, {
				codeRoot: process.env.CODE_ROOT?.trim() || 'F:/code',
				...(pm ? { pm } : {})
			});
			return {
				resume: {
					ok: true as const,
					projectId: res.projectId,
					...(res.pm ? { pmName: res.pm.pm.name } : {})
				}
			};
		} catch (err) {
			if (err instanceof ResumeProjectNotFoundError) {
				return fail(404, { resume: { error: err.message } });
			}
			// 409 = the operator can resolve by acting differently / retrying (retryable lock race) or the
			// state is already non-resumable (complete/native, or the scaffold is gone — nothing to finish).
			if (
				err instanceof ConcurrentCreateError ||
				err instanceof ResumeNotIncompleteError ||
				err instanceof ResumeScaffoldMissingError
			) {
				return fail(409, { resume: { error: err.message } });
			}
			// 500 = a real backend writer failure; the row stays honestly incomplete (PostRegisterWriterError)
			// or an unexpected fault. Never masked as success.
			return fail(500, { resume: { error: (err as Error).message } });
		}
	},

	/**
	 * CC-CONTROLS — CONTINUE: get a stalled project moving by re-enqueuing THIS project's already-READY
	 * tasks into the LIVE orchestrator's claim queue and draining them. The honest fix for the operator's
	 * pain (6 ready tasks sat undeveloped after a dev-server boot): the event-mode orchestrator only reacts
	 * to a task ENTERING ready, so tasks already sitting ready are never re-driven — this asks it to drain
	 * them explicitly via the REAL enqueue/drain seam (orchestrator.enqueueTask + drain), NOT a status
	 * bounce through backlog (D-008 keeps the description immutable; a bounce would fabricate transitions).
	 *
	 * INTEGRITY (red-team): cannot double-spawn — enqueueTask is idempotent via the work_item dedup_key
	 * (a task already pending/processing collapses to a no-op), so a double-click / concurrent CONTINUE /
	 * a race with the boot trigger all converge to one in-flight task_run per task. Cannot bypass the
	 * spawn cap — drain() enforces the orchestrator's OWN D-021 daily cap + interactive semaphore (this
	 * seam adds no new spawn path). Cannot leak across projects — only THIS project's ready tasks are
	 * listed/enqueued. Cannot run away — drain stops the instant permits OR the cap OR work run out.
	 *
	 * Honest (F-008): an absent orchestrator (degraded / no-credential boot) is a NAMED 503 reason, never
	 * a fake "started". The project id is validated at the D-016 boundary.
	 */
	continueProject: async ({ params }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { continue: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { continue: { error: 'Database not connected — start SurrealDB and retry.' } });

		try {
			const res = await continueReadyTasks(activeOrchestrator(), db, projectId);
			return {
				continue: {
					ok: true as const,
					readyCount: res.readyCount,
					enqueued: res.enqueued,
					alreadyQueued: res.alreadyQueued,
					claimed: res.claimed,
					spawned: res.spawned
				}
			};
		} catch (err) {
			// EVERY ERROR HAS A NAME: no live orchestrator is a 503 (the engine is not running — honest,
			// retryable on the next credentialed boot); anything else is a 500 with the real reason.
			if (err instanceof OrchestratorUnavailableError) {
				return fail(503, { continue: { error: err.message } });
			}
			return fail(500, { continue: { error: (err as Error).message } });
		}
	},

	/**
	 * CC-CONTROLS — RESTART: re-run the task behind a FAILED/stuck session by re-enqueuing its task_run
	 * through the SAME orchestrator seam. The session is named by the client, but the project + status +
	 * task are RE-READ server-side (NO-GUESSING — never trust the client's claim) via getFleetSession.
	 *
	 * INTEGRITY (red-team): cannot double-spawn — the dedup_key makes a second click while the re-run is
	 * pending/processing a no-op (enqueued:false). Cannot leak across projects — the session must belong
	 * to THIS project (a foreign session id is a named 409). Cannot re-run live/clean work — only
	 * failed/stuck sessions are restartable (RESTARTABLE_SESSION_STATUSES); a healthy running session is
	 * refused (that is the double-spawn we prevent) and a clean done session is refused (re-running is
	 * fabricated rework — spawn a follow-up instead). Cannot bypass the cap — drain() owns it.
	 */
	restartSession: async ({ params, request }) => {
		const projectId = pmProjectId(params.id);
		if (!projectId) return fail(400, { restart: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { restart: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const sessionId = String(form.get('sessionId') ?? '').trim();
		try {
			assertRecordId(sessionId);
		} catch {
			return fail(400, { restart: { error: 'invalid session id' } });
		}

		// NO-GUESSING: re-read the session row server-side for its REAL project + status + task — never
		// trust the client's claim about which project/status the session is.
		const session = await getFleetSession(db, sessionId);
		if (!session) return fail(404, { restart: { error: 'session not found' } });

		try {
			// operatorAuthority=true — this is the OPERATOR control-plane action on the login-gated project
			// page (D-025/D-035a), the ONLY path allowed to reopen a terminal `failed` task to `ready` for a
			// deliberate re-run (BL-R4). The auto-drain / reaper / gcStale never reach restartSessionTask, so
			// they can never trigger the failed→ready reopen (RH-1 stays intact).
			const res = await restartSessionTask(
				activeOrchestrator(),
				db,
				projectId,
				{
					id: session.id,
					status: session.status,
					project: session.projectId,
					taskId: session.taskId
				},
				true
			);
			return {
				restart: {
					ok: true as const,
					sessionId,
					taskId: res.taskId,
					enqueued: res.enqueued,
					claimed: res.claimed,
					spawned: res.spawned
				}
			};
		} catch (err) {
			// EVERY ERROR HAS A NAME: no live orchestrator → 503; a cross-project / non-restartable /
			// no-task refusal → 409 (the operator's request was well-formed but the state forbids it);
			// anything else → 500 with the real reason.
			if (err instanceof OrchestratorUnavailableError) {
				return fail(503, { restart: { sessionId, error: err.message } });
			}
			if (err instanceof SessionControlError) {
				return fail(409, { restart: { sessionId, error: err.message } });
			}
			return fail(500, { restart: { sessionId, error: (err as Error).message } });
		}
	}
};

/** The operator config dir (CONFIG_DIR override, else "config") — mirrors /settings. */
function configDir(): string {
	return process.env.CONFIG_DIR?.trim() || 'config';
}

/** Validate `project:<slug>` at the D-016 boundary; null on a malformed param. */
function pmProjectId(idParam: string): string | null {
	try {
		return assertRecordId(`project:${idParam}`);
	} catch {
		return null;
	}
}

/**
 * PMA — the live autonomous loop's honest last-state for a project (read-only). null when no loop is
 * running (degraded boot) or it has not acted on this project yet. F-008: a real read, never fabricated.
 */
function autonomousLoopStateFor(
	projectId: string
): { state: string; reason: string; ticksUsed: number } | null {
	const loop = activeAutonomousLoop();
	if (!loop) return null;
	const out = loop.lastOutcome.get(projectId);
	if (!out) return null;
	return { state: out.state, reason: out.reason, ticksUsed: out.ticksUsed };
}

/**
 * PMA — the active HARD spawn caps that bound unsupervised spend (surfaced on the arm confirm). Static
 * reads (the loop's PMA-2 re-tick cap constant + the REAL D-021 daily cap the live boot wires) so the
 * confirm copy always has a concrete ceiling to show. F-008: dailySpawnCap is null when genuinely
 * uncapped — never a fabricated number; reTickCap is always the enforced constant.
 */
function readSpendCaps(): { reTickCap: number; dailySpawnCap: number | null } {
	return {
		reTickCap: DEFAULT_MAX_TICKS_PER_WINDOW,
		dailySpawnCap: bootDailySpawnCap() ?? null
	};
}
