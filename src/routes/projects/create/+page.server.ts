// CA-3 — /projects/create server actions (CREATE-SPEC §2, §5.1-5.2).
//
// The UI surface for Create-with-AI. Two POST actions, both confirm-gated (D-010):
//
//   ?/propose — run the CA-1 generator (makeProposalAgent → generateCreationProposal) for the
//     brief + optional hints. NOTHING touches disk or the DB here (CA-1 is ephemeral — the only DB
//     read is the defect-class vocab for enum validation). Returns the validated proposal envelope
//     (brief + proposal + confirmToken) the review step renders + re-submits at confirm.
//
//   ?/create — on the operator-confirmed envelope, run CA-2 (executeCreation): re-validate the
//     confirmToken (StaleProposalError if the brief/proposal changed), scaffold under CODE_ROOT,
//     scan-ingest the REAL on-disk project (F-008 — the row derives from disk, not the proposal
//     text), write the plan/tasks/targets/needs, and (fork 3, default ON) hire the PM. Lands the
//     operator on the new project workspace via { redirectTo }.
//
// Honest (F-008 / D-019): no live DB → 503 with the reason, never a fabricated proposal. No live
// runtime credential → 503 with getRuntime's honest reason, never a fake proposal. The proposal
// agent runs READ-ONLY (agent.ts allow-list) under an existing HOST project (any registered one —
// CA-1 has no project yet, launchSession needs a cwd); honest error when the portfolio is empty.

import { fail } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import { listProjects } from '$lib/server/projects/repo';
import { getRuntime, getBus, DEFAULT_AGENT, DEFAULT_MODEL } from '$lib/server/harness';
import { listSessionMessages, type TranscriptMessage } from '$lib/server/sessions';
import {
	makeProposalAgent,
	executeCreation,
	executeTemplateCreation,
	getTemplate,
	createProposalRun,
	attachSession,
	runProposalInBackground,
	getProposalRun,
	StaleProposalError,
	ProjectExistsError,
	UnstableSlugError,
	ConcurrentCreateError,
	PostRegisterWriterError,
	type CreateBrief,
	type CreationProposalEnvelope
} from '$lib/server/create';
import {
	templateChoices,
	readTemplateParams,
	createErrorReason,
	templateScaffoldErrorReason
} from '$lib/server/create/template-form';
import type { Actions, PageServerLoad } from './$types';

/** Confinement root (CODE_ROOT) the scaffold lives under (D-018). Mirrors /projects ?/scan. */
function codeRoot(): string {
	return process.env.CODE_ROOT?.trim() || 'F:/code';
}

/** Bound the operator-supplied free text at the boundary before it reaches the agent prompt. */
const MAX_NAME = 200;
const MAX_DESC = 8000;
const MAX_HINT = 1000;

/**
 * The page loads only the runtime/portfolio availability flags so the brief form can render an
 * honest "credential not configured" / "no host project" notice up front (F-008) instead of a
 * button that fails on submit. The actual project list is NOT rendered here (this is the create
 * surface, not the list) — we only need the COUNT to know a host project exists.
 */
export const load: PageServerLoad = async ({ url, depends }) => {
	// Create-with-AI ASYNC propose: the page re-reads the in-flight run on its OWN scoped dep so a
	// `create_proposal_run` row change (the detached generation resolving) live-flips the page to the
	// proposal review / honest failure WITHOUT re-pulling availability flags (no invalidate storm).
	depends('app:create-run');
	// The generation session's PERSISTED transcript re-reads on its OWN scoped dep so a new `message`
	// row (a turn the read-only agent produced) live-appends to the transcript WITHOUT re-pulling the
	// run row or the availability flags (no invalidate storm — the /claude-code?session= precedent).
	depends('app:create-transcript');

	// The template registry is pure + static (no DB/credential needed) — the picker is available even
	// when the DB is down (the scaffold action then honestly 503s, but the form still renders).
	const templates = templateChoices();

	// `?run=<id>` — the in-flight (or resolved) generation run the client is watching. Validated at
	// the boundary (D-016): a malformed value is ignored (no run hydrated), never interpolated. The
	// run row carries the honest state (generating/done/failed) + the session id (live transcript key)
	// + the validated envelope on done. SHADOW PATHS: nil → no run; non-record-id → caught → no run.
	const runParam = url.searchParams.get('run');

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			runtimeAvailable: false,
			runtimeReason: null,
			hostProjectCount: 0,
			templates,
			run: null,
			transcript: [] as TranscriptMessage[]
		};
	}
	try {
		const [projects, runtime] = await Promise.all([listProjects(db), getRuntime(db)]);
		// Read the watched run (honest empty when the param is absent/unknown — never fabricated).
		let run = null;
		if (runParam) {
			try {
				run = await getProposalRun(db, runParam);
			} catch {
				run = null; // a read failure (incl. a malformed id) → no run hydrated, page still usable.
			}
		}
		// The generation session's PERSISTED transcript (the LT-1 `message` rows the read-only agent
		// produced) — the DURABLE live-transcript source, the /claude-code?session= precedent. Loaded
		// only when the watched run carries a session id; a new turn live-appends via the `message`
		// onDbChange → invalidate('app:create-transcript') re-read. SHADOW PATHS: no run / no session →
		// []; an unknown/never-launched session → listSessionMessages returns [] (honest "starting…",
		// never fabricated); a transcript-read failure is isolated so it never blanks the run row.
		let transcript: TranscriptMessage[] = [];
		if (run?.session) {
			try {
				transcript = await listSessionMessages(db, run.session);
			} catch {
				transcript = [];
			}
		}
		return {
			connected: true,
			runtimeAvailable: runtime.available,
			runtimeReason: runtime.available ? null : runtime.reason,
			hostProjectCount: projects.length,
			templates,
			run,
			transcript
		};
	} catch (err) {
		const reason = classifyDbError(err) === 'disconnected' ? null : (err as Error).message;
		return {
			connected: false,
			runtimeAvailable: false,
			runtimeReason: reason,
			hostProjectCount: 0,
			templates,
			run: null,
			transcript: [] as TranscriptMessage[]
		};
	}
};

/** Read + trim a bounded string field from the form (empty string when absent). */
function field(form: FormData, key: string, max: number): string {
	const raw = form.get(key);
	const v = typeof raw === 'string' ? raw.trim() : '';
	return v.length > max ? v.slice(0, max) : v;
}

/** Build the brief from the form, or a fail() reason naming the missing required field. */
function readBrief(form: FormData): { brief: CreateBrief } | { error: string } {
	const name = field(form, 'name', MAX_NAME);
	const description = field(form, 'description', MAX_DESC);
	if (!name) return { error: 'Give the project a name.' };
	if (!description) return { error: 'Describe what you want to create.' };

	const ecosystem = field(form, 'ecosystem', MAX_HINT);
	const refRepoUrl = field(form, 'refRepoUrl', MAX_HINT);
	const targetPlatform = field(form, 'targetPlatform', MAX_HINT);
	const hints: NonNullable<CreateBrief['hints']> = {};
	if (ecosystem) hints.ecosystem = ecosystem;
	if (refRepoUrl) hints.refRepoUrl = refRepoUrl;
	if (targetPlatform) hints.targetPlatform = targetPlatform;

	return {
		brief: {
			name,
			description,
			...(Object.keys(hints).length ? { hints } : {})
		}
	};
}

/** The detail-route slug is the bare id after `project:` (the [id] loader re-prefixes it). */
function workspaceHref(projectId: string): string {
	const i = projectId.indexOf(':');
	return `/projects/${i >= 0 ? projectId.slice(i + 1) : projectId}`;
}

export const actions: Actions = {
	/**
	 * CA-1 — LAUNCH the confirm-gated proposal generation ASYNC. The up-front gates are UNCHANGED
	 * (readBrief, DB, runtime credential, host-project — honest 503 each), then instead of awaiting
	 * the ~2-min read-only agent session, it: (1) CREATEs a create_proposal_run row {generating},
	 * (2) fires the generation as a DETACHED background job (runProposalInBackground) that resolves
	 * the row {done, envelope} | {failed, error_reason}, and (3) returns { runId, sessionId } the
	 * INSTANT the session id is surfaced (the generator's onSessionCreated fires at the session-row
	 * CREATE, long before generation finishes). The client then watches the run row live (the
	 * `create_proposal_run` SSE watcher) + the session's live transcript (the `message` stream).
	 *
	 * D-010 PRESERVED: still propose-only — NOTHING touches disk; the resolved envelope carries the
	 * same confirmToken ?/create re-validates (assertProposalFresh). F-008: no fake proposal — the
	 * row is honest 'generating' until the real agent resolves it; an agent failure → 'failed' + reason.
	 *
	 * Shadow paths: nil/empty name|description → 400 (named field); DB down → 503; no credential →
	 * 503; empty portfolio → 503; the agent returns garbage / leg errors → the BACKGROUND job marks
	 * the run 'failed' with the named reason (the client sees it via the live row), never a phantom ok.
	 */
	propose: async ({ request }) => {
		const form = await request.formData();
		const read = readBrief(form);
		if ('error' in read) return fail(400, { propose: { error: read.error } });

		const db = tryGetDb();
		if (!db) {
			return fail(503, { propose: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		const runtime = await getRuntime(db);
		if (!runtime.available) {
			// HONEST (F-008): no live credential → no fake proposal.
			return fail(503, { propose: { error: `Cannot generate — ${runtime.reason}` } });
		}

		// CA-1 runs the read-only session under an existing HOST project (any registered one — the
		// agent writes nothing under it). The portfolio must have at least one project to launch from.
		let hostProjectId: string;
		try {
			const projects = await listProjects(db);
			if (projects.length === 0) {
				return fail(503, {
					propose: {
						error:
							'No host project to run the proposal agent under — register one project first (the read-only ' +
							'create session needs an existing project as its working directory).'
					}
				});
			}
			hostProjectId = String(projects[0].id);
		} catch (err) {
			return fail(500, { propose: { error: `Could not load the portfolio: ${(err as Error).message}` } });
		}

		// CREATE the run row in the honest 'generating' state BEFORE launching (so a session-id surface
		// or an instant failure always has a row to land on — the interrupt contract: a re-run/refresh
		// re-reads this row via ?run=, never a half-state). The brief is screened for the row's display
		// column inside createProposalRun (D-026); the envelope keeps the verbatim token-bound brief.
		let runId: string;
		try {
			runId = await createProposalRun(db, { project: hostProjectId, brief: read.brief });
		} catch (err) {
			return fail(500, { propose: { error: `Could not start the proposal run: ${(err as Error).message}` } });
		}

		// CT-2 template grounding (optional): when the operator picked a template, thread its id + the
		// resolved param values so the prompt carries the template's stack + layout as PRIOR ART. An
		// unknown/blank templateId is a no-op (the prompt is byte-identical to the pure-AI path).
		const templateId = field(form, 'templateId', MAX_HINT);
		const tplParams = templateId ? readTemplateParams(form, templateId) : undefined;

		// The session id is surfaced synchronously the INSTANT launchSession CREATEs the session row
		// (onSessionCreated, before the stream is consumed). We both stamp it on the run row AND
		// resolve `sessionReady` so we can return it to the client without awaiting the generation.
		let resolveSession: (id: string) => void;
		const sessionReady = new Promise<string>((res) => {
			resolveSession = res;
		});
		const generate = makeProposalAgent({
			db,
			bus: getBus(),
			runtime: runtime.runtime,
			hostProjectId,
			agentId: DEFAULT_AGENT,
			model: DEFAULT_MODEL,
			onSessionCreated: (sessionId) => {
				resolveSession(sessionId);
				// Best-effort stamp on the run row (D-016) — fail-open: a stamp failure never breaks
				// generation (the client still watches the row; only the live-transcript link is delayed).
				void attachSession(db, runId, sessionId).catch((e) =>
					console.warn(`[create] attachSession failed for run ${runId}: ${(e as Error).message}`)
				);
			},
			...(templateId && getTemplate(templateId) ? { templateId, params: tplParams } : {})
		});

		// Fire the generation DETACHED — we do NOT await it. It resolves the run row on its own
		// (done|failed). The catch is defensive; runProposalInBackground already swallows + records
		// every failure on the row, so this only guards an unexpected throw before that runs.
		void runProposalInBackground(db, runId, read.brief, generate).catch((e) =>
			console.warn(`[create] background proposal run ${runId} threw unexpectedly: ${(e as Error).message}`)
		);

		// Return the run id immediately, with the session id if it surfaced fast enough (bounded — we
		// never block the action on the ~2-min generation). If the session row is slow to CREATE, the
		// client falls back to the run row's `session` field (stamped by attachSession) via the live
		// watcher. F-014 discipline: a bounded wall-clock wait, no spin.
		const sessionId = await Promise.race([
			sessionReady,
			new Promise<null>((res) => setTimeout(() => res(null), 8000))
		]);
		return { propose: { launched: true as const, runId, sessionId: sessionId ?? null } };
	},

	/**
	 * CA-2 — execute the operator-confirmed proposal. Re-validates the confirmToken (D-010) inside
	 * executeCreation, scaffolds + ingests the REAL project (F-008), writes plan/tasks/targets/needs,
	 * and optionally hires the PM (fork 3, default ON). Returns { redirectTo } so the page lands the
	 * operator on the new workspace; surfaces the PM-hire result.
	 *
	 * Shadow paths: missing/garbled envelope → 400 (parse failure, named); stale token →
	 * StaleProposalError; existing slug → ProjectExistsError; mid-scaffold death → ScaffoldFailedError
	 * (an incident is logged + NO phantom row registered).
	 */
	create: async ({ request }) => {
		const form = await request.formData();
		const raw = form.get('envelope');
		if (typeof raw !== 'string' || !raw.trim()) {
			return fail(400, { create: { error: 'Missing the confirmed proposal — regenerate it.' } });
		}
		let envelope: CreationProposalEnvelope;
		try {
			envelope = JSON.parse(raw) as CreationProposalEnvelope;
		} catch {
			return fail(400, { create: { error: 'The confirmed proposal was malformed — regenerate it.' } });
		}
		if (!envelope?.brief || !envelope?.proposal || typeof envelope?.confirmToken !== 'string') {
			return fail(400, { create: { error: 'The confirmed proposal is incomplete — regenerate it.' } });
		}

		const db = tryGetDb();
		if (!db) {
			return fail(503, { create: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		// PM hand-off (fork 3, default ON). The operator opts out by unticking the box; the PM name
		// defaults to the brief name + " PM" when left blank.
		const wantPm = form.get('hirePm') === 'on';
		const pmNameRaw = field(form, 'pmName', MAX_NAME);
		const pm = wantPm
			? { name: pmNameRaw || `${envelope.brief.name} PM`, answers: [] }
			: undefined;

		// EXP-1 — the operator's explicit "Autonomously build and publish to v1" choice (default OFF).
		// When ON, executeCreation arms the just-hired PM (autonomous + auto_publish_preauthorized) so the
		// project drives hands-off to v1. It REQUIRES a PM: option ON without a PM is an honest failure
		// (AutonomousArmWithoutPmError → surfaced as PostRegisterWriterError), never a silent arm.
		const autonomousToV1 = form.get('autonomousToV1') === 'on';

		try {
			const res = await executeCreation(db, envelope, {
				codeRoot: codeRoot(),
				autonomousToV1,
				...(pm ? { pm } : {})
			});
			return {
				create: {
					ok: true as const,
					projectId: res.projectId,
					redirectTo: workspaceHref(res.projectId),
					taskCount: res.taskIds.length,
					taskStatus: res.taskStatus,
					targetCount: res.targetIds.length,
					...(res.commitSha ? { commitSha: res.commitSha } : {}),
					...(res.armedAutonomous ? { armedAutonomous: true as const } : {}),
					...(res.pm
						? { pm: { name: res.pm.pm.name, hired: res.pm.hired, alreadyHired: res.pm.alreadyHired } }
						: {})
				}
			};
		} catch (err) {
			// 409 = client can resolve by acting differently / retrying:
			//   • StaleProposalError / ProjectExistsError / UnstableSlugError — regenerate / open existing / fix name;
			//   • ConcurrentCreateError (CAH4-1) — a concurrent same-slug create won the create-lock race; RETRYABLE
			//     (the operator retries once the winner lands). It carried a generic 500 before this fix.
			// 500 = a real server-side failure the operator cannot fix by re-submitting:
			//   • PostRegisterWriterError (CAH4-1) — the project IS registered (honestly marked create_status=
			//     'incomplete', F-008); createErrorReason carries the recovery HINT (open the project page to
			//     resume — CAH4-2). NOT masked as success, NOT a bare 500 with a raw cause.
			const retryableOrClientFixable =
				err instanceof StaleProposalError ||
				err instanceof ProjectExistsError ||
				err instanceof UnstableSlugError ||
				err instanceof ConcurrentCreateError;
			// PostRegisterWriterError stays 500 explicitly (real backend failure; row honestly marked
			// incomplete) — pinned here so a later edit to the fallthrough can't silently demote it.
			const status = retryableOrClientFixable && !(err instanceof PostRegisterWriterError) ? 409 : 500;
			return fail(status, { create: { error: createErrorReason(err) } });
		}
	},

	/**
	 * CT-3 — DIRECT template scaffold (NO AI spend). Confirm-gated (D-010: the operator clicks
	 * 'Scaffold from template' on the picker, having seen the params it will use). Renders the chosen
	 * template's REAL files via executeTemplateCreation (same scaffold/register/ingest pipeline as the
	 * AI path — D-018 confine, D-026 screen, F-040 lock, git init, scanProject ingest), then lands the
	 * operator on the new workspace via { create: { redirectTo } } (reuses STAGE 3 DONE rendering).
	 *
	 * Honest (F-008): no live DB → 503 with the reason, never a fabricated project. NO runtime
	 * credential needed (the template path is deterministic — no agent leg, no spend).
	 *
	 * Shadow paths: nil/empty name → 400 (named field); blank/unknown templateId → 400 / honest
	 * TemplateNotFoundError; DB down → 503; existing slug → ProjectExistsError (409); a param injecting
	 * `../` → ScaffoldPathError; a param producing a literal secret → ScaffoldSecretError (HARD);
	 * mid-scaffold death → ScaffoldFailedError (incident logged, NO phantom row); post-register writer
	 * failure → PostRegisterWriterError (row marked incomplete, never a silent half-state).
	 */
	scaffoldTemplate: async ({ request }) => {
		const form = await request.formData();
		const templateId = field(form, 'templateId', MAX_HINT);
		if (!templateId) {
			return fail(400, { create: { error: 'Pick a template before scaffolding.' } });
		}
		if (!getTemplate(templateId)) {
			return fail(400, { create: { error: `Unknown template '${templateId}' — pick one from the list.` } });
		}

		const read = readBrief(form);
		if ('error' in read) return fail(400, { create: { error: read.error } });

		const db = tryGetDb();
		if (!db) {
			return fail(503, { create: { error: 'Database not connected — start SurrealDB and retry.' } });
		}

		const params = readTemplateParams(form, templateId);

		// PM hand-off (fork 3, default ON) — same opt-out + default-name contract as ?/create.
		const wantPm = form.get('hirePm') === 'on';
		const pmNameRaw = field(form, 'pmName', MAX_NAME);
		const pm = wantPm ? { name: pmNameRaw || `${read.brief.name} PM`, answers: [] } : undefined;

		// EXP-1 — parity with ?/create: the operator's "Autonomously build and publish to v1" choice
		// (default OFF) arms the hired PM for the hands-off 0→v1 drive. ON without a PM is an honest
		// failure (AutonomousArmWithoutPmError → PostRegisterWriterError), never a silent arm.
		const autonomousToV1 = form.get('autonomousToV1') === 'on';

		try {
			const res = await executeTemplateCreation(db, {
				templateId,
				name: read.brief.name,
				description: read.brief.description,
				params,
				codeRoot: codeRoot(),
				autonomousToV1,
				...(pm ? { pm } : {})
			});
			return {
				create: {
					ok: true as const,
					projectId: res.projectId,
					redirectTo: workspaceHref(res.projectId),
					taskCount: res.taskIds.length,
					taskStatus: res.taskStatus,
					targetCount: res.targetIds.length,
					...(res.commitSha ? { commitSha: res.commitSha } : {}),
					...(res.armedAutonomous ? { armedAutonomous: true as const } : {}),
					...(res.pm
						? { pm: { name: res.pm.pm.name, hired: res.pm.hired, alreadyHired: res.pm.alreadyHired } }
						: {})
				}
			};
		} catch (err) {
			const status =
				err instanceof ProjectExistsError ||
				err instanceof UnstableSlugError ||
				err instanceof ConcurrentCreateError
					? 409
					: 500;
			return fail(status, { create: { error: templateScaffoldErrorReason(err) } });
		}
	}
};
