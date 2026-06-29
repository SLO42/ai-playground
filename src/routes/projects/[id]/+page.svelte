<script lang="ts">
  /**
   * /projects/[id] — the project workspace detail (UI-SPEC §51, §187–193 v0.1).
   *
   * Renders ONE project LIVE from the DB (F-008 — no fabricated rows): its plan macro
   * (purpose/vision/role/DoD), its plan hierarchy (releases→phases→features→sprints),
   * its tasks, and its Claude Code sessions. Three tabs per UI-SPEC §51 (plan / sessions
   * / release); the Release tab links to the existing /projects/[id]/release child (3.4).
   * The four honest states (loading / empty / error / live, UI-SPEC §1.3/§8). Live by
   * default (§1.2): a `project` / `task` / `session` row change on the one SSE stream
   * re-invalidates the loader so the detail updates in place. Svelte 5 RUNES only.
   */
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { invalidate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { stream } from '$lib/client/stream.svelte';
  import { confirm } from '$lib/client/confirm.svelte';
  import { lineDiff } from '$lib/client/confirm-core';
  import SessionTranscript from '$lib/components/shell/SessionTranscript.svelte';
  import SessionFailureReason from '$lib/components/shell/SessionFailureReason.svelte';
  import FileSnapshotViewer from '$lib/components/shell/FileSnapshotViewer.svelte';
  import ProjectStatus from '$lib/components/project/ProjectStatus.svelte';
  import ProjectActivity from '$lib/components/project/ProjectActivity.svelte';
  import ProjectControls from '$lib/components/project/ProjectControls.svelte';
  // GAME-VERIFY GV-4 — the live game_verify verdict surface (operator visibility).
  import GameVerifyVerdict from './GameVerifyVerdict.svelte';
  // LP-3 — the reusable Loops surface (LP-2): grouped LoopCards for this project's loops.
  import LoopList from '$lib/components/loops/LoopList.svelte';
  import {
    rowToTurn,
    liveEventToTurn,
    interjectEventToTurn,
    type Turn
  } from '$lib/client/transcript-core';
  import { relativeTime, elapsed, absoluteTime } from '$lib/client/time-format';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // ── FS-3 (FILE-SNAPSHOT-SPEC §4) — the in-app "view file" surface. Opening a referenced file
  // (a finding's file:line) loads its DB-stored point-in-time snapshot, labelled as-of/may-be-stale.
  let snapshotViewer = $state<{ open: boolean; path?: string }>({ open: false });
  function viewFileSnapshot(path: string | null | undefined): void {
    if (!path) return;
    snapshotViewer = { open: true, path };
  }

  const connected = $derived(data.connected);
  const project = $derived(data.project);
  const releases = $derived(data.releases ?? []);
  const phases = $derived(data.phases ?? []);
  const features = $derived(data.features ?? []);
  const sprints = $derived(data.sprints ?? []);
  const tasks = $derived(data.tasks ?? []);
  const sessions = $derived(data.sessions ?? []);
  // GAME-VERIFY GV-4 — the latest persisted game_verify verdict(s) + whether the project declares a
  // harness (drives the honest "not yet run" vs "not configured" empty states; F-008).
  const gameVerify = $derived(data.gameVerify ?? []);
  const gameVerifyConfigured = $derived(data.gameVerifyConfigured ?? false);
  // LP-3 — this project's recurring autonomous loops (project-scoped: autonomous PM drive + cadence).
  // Honest empty (F-008): an unarmed/unscheduled PM ⇒ [] ⇒ the tab shows "no active loops".
  const loops = $derived(data.loops ?? []);
  // ── TASK 10.4 — the missing workspace surfaces (board / memory / settings / maintain).
  const taskStatuses = $derived(data.taskStatuses ?? []);
  const taskPriorities = $derived(data.taskPriorities ?? []);
  const projectStatuses = $derived(data.projectStatuses ?? []);
  const findings = $derived(data.findings ?? []);
  const memories = $derived(data.memories ?? []);
  const graph = $derived(data.graph ?? { nodes: [], edges: [] });
  // ── PM (TASK 9.1) — the strategic layer above task execution.
  const pmMemory = $derived(data.pmMemory ?? []);
  const pmStats = $derived(data.pmStats);
  const decisions = $derived(data.decisions ?? []);
  const pmBootstrapped = $derived(data.pmBootstrapped ?? false);
  const pmKinds = $derived(data.pmKinds ?? []);
  // TASK 11.4 — PM periodic review surface.
  const pmReviews = $derived(data.pmReviews ?? []);
  const pmAutoReviewAllowed = $derived(data.pmAutoReviewAllowed ?? false);
  // TASK 11.5 — UX-inspection loop (the maintain-cycle UX inspector). Shares the D-004 gate.
  const uxAutoAllowed = $derived(data.uxAutoAllowed ?? false);
  const selectedSession = $derived(data.selectedSession);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // ── CAH4 recovery — a Create-with-AI project whose setup did NOT finish (m0049
  // create_status='incomplete'). The honest badge + a resume affordance surface here; the SSE
  // `project` watcher clears it live the moment resumeCreate flips the row to 'complete' (F-008).
  const createIncomplete = $derived(project?.create_status === 'incomplete');
  let resumeBusy = $state(false);

  // The slug segment for child routes (the [id] param is the bare slug, not `project:slug`).
  const slug = $derived(page.params.id);
  const releaseHref = $derived(`/projects/${slug}/release`);
  const syncHref = $derived(`/projects/${slug}/sync`);
  const targetsHref = $derived(`/projects/${slug}/targets`);
  // LG-3 — the live animated lifecycle node-graph (Continue → sessions → PM → tasks).
  const graphHref = $derived(`/projects/${slug}/graph`);
  const projectName = $derived(project?.name ?? slug);
  // LP-3 — title the LoopList group with THIS project's display name (LoopList groups project-scoped
  // loops by projectId). Always present once connected; a slug/id fallback keeps it honest if the
  // name is absent (final data.projectId fallback guarantees a string — Record<string,string>).
  const loopProjectNames = $derived<Record<string, string>>({
    [data.projectId]: projectName ?? slug ?? data.projectId
  });

  type Tab =
    | 'overview'
    | 'tasks'
    | 'roadmap'
    | 'pm'
    | 'sessions'
    | 'memory'
    | 'loops'
    | 'release'
    | 'sync'
    | 'targets'
    | 'settings';
  // Deep-link default: when the page LOADS with a `?session=` (a transcript link from elsewhere),
  // land on the Sessions tab so the linked transcript is visible. Computed ONCE at component init
  // (not in an $effect) — a subsequent in-page selection (e.g. expanding a row in the Overview
  // Activity panel) must NOT yank the operator to another tab; the Activity panel streams the
  // transcript inline on Overview itself. Using an $effect here would read+write its own guard
  // state and loop (effect_update_depth_exceeded); a plain init read of the initial selection is
  // the correct one-shot.
  // `untrack` makes the one-shot intent explicit to the compiler: we read the INITIAL selection
  // exactly once at init (not a reactive dependency) — re-running on later `data` changes is wrong
  // (it would re-yank tabs). Without untrack, svelte-check warns `state_referenced_locally`.
  let tab = $state<Tab>(untrack(() => (data.selectedSession ? 'sessions' : 'overview')));

  // ── Tasks board (TASK 10.4) — group the live task rows into kanban columns by status.
  // The columns follow the canonical status vocab; honest empty columns render "—".
  const tasksByStatus = $derived.by(() => {
    const m = new Map<string, typeof tasks>();
    for (const s of taskStatuses) m.set(s, []);
    for (const t of tasks) {
      const col = m.get(t.status) ?? [];
      col.push(t);
      m.set(t.status, col);
    }
    return m;
  });
  let newTaskTitle = $state('');
  let newTaskPriority = $state('normal');
  let taskBusy = $state(false);
  const taskFeedback = $derived(
    form && 'task' in form ? (form.task as Record<string, unknown>) : undefined
  );

  // ── Roadmap hierarchy (TASK 10.4) — release → phases → features, plus orphan rows that
  // link to no release and the project's sprints. Pure client projection over live rows.
  const roadmap = $derived.by(() => {
    const phasesByRelease = new Map<string, typeof phases>();
    const featuresByRelease = new Map<string, typeof features>();
    const orphanPhases: typeof phases = [];
    const orphanFeatures: typeof features = [];
    for (const ph of phases) {
      if (ph.release) {
        const arr = phasesByRelease.get(ph.release) ?? [];
        arr.push(ph);
        phasesByRelease.set(ph.release, arr);
      } else orphanPhases.push(ph);
    }
    for (const f of features) {
      if (f.release) {
        const arr = featuresByRelease.get(f.release) ?? [];
        arr.push(f);
        featuresByRelease.set(f.release, arr);
      } else orphanFeatures.push(f);
    }
    const tree = releases.map((r) => ({
      release: r,
      phases: (phasesByRelease.get(r.id) ?? []).slice().sort((a, b) => a.order - b.order),
      features: featuresByRelease.get(r.id) ?? []
    }));
    return { tree, orphanPhases, orphanFeatures };
  });

  // ── Maintain rollup (TASK 10.4) — project-scoped findings by severity (UI-SPEC §189).
  const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
  const severityCounts = $derived(
    SEVERITIES.map((sev) => ({ sev, n: findings.filter((f) => f.severity === sev).length }))
  );

  function findingFamily(rule: string): string {
    if (rule.startsWith('dependency.')) return 'dependency';
    if (rule.startsWith('ux.')) return 'ux';
    return 'security';
  }

  // ── TASK 11.5 — UX-inspection trigger state (the maintain-cycle UX inspector loop).
  let uxBusy = $state(false);
  const uxFeedback = $derived(
    form && 'ux' in form ? (form.ux as Record<string, unknown>) : undefined
  );
  const uxFindingCount = $derived(findings.filter((f) => f.rule.startsWith('ux.')).length);

  // ── PM-LC-3 (PM-LIFECYCLE-SPEC §PM-LC-3) — the one-click "Start the project's life" control.
  // Reuses the EXISTING ?/startLifecycle action (PM-LC-2). The click is REAL model spend, so it is
  // gated behind the canonical D-010 blocking confirm (confirm.confirm) carrying the cost label —
  // mirroring the create-flow / ceremony spend-confirm convention. On a returned sessionId we
  // navigate to ?session=<id> so the EXISTING live transcript pipeline (SessionTranscript + the
  // transcript/token_usage/session_status SSE topics) streams the PM thinking in real time; the
  // tick result (generated / promoted / leftForOperator) renders honestly below the button.
  let lifecycleBusy = $state(false);
  // The action result the operator last triggered (named, F-008). Read off `form.lifecycle`.
  const lifecycleFeedback = $derived(
    form && 'lifecycle' in form ? (form.lifecycle as Record<string, unknown>) : undefined
  );
  // The honest tick state for the Overview region: idle → running → (done | empty | error).
  // `done` vs `empty` is decided by whether the tick generated anything; `error` is the named
  // failure reason. Never a fabricated count or a spinner-as-done.
  const lifecycleState = $derived.by(
    (): 'idle' | 'running' | 'done' | 'empty' | 'error' | 'busy-elsewhere' => {
      if (lifecycleBusy) return 'running';
      const fb = lifecycleFeedback;
      if (!fb) return 'idle';
      if (fb.error) return 'error';
      // Benign concurrent-guard: a tick was already running for this project — nothing was run this
      // click (no second session, no double spend). An honest non-error state (PM-LC-2 hardening).
      if (fb.alreadyRunning === true) return 'busy-elsewhere';
      if (fb.needsHire === true) return 'idle'; // the hire CTA renders; nothing was run.
      if (typeof fb.generated === 'number' && fb.generated === 0) return 'empty';
      return 'done';
    }
  );
  const lifecycleAuthority = $derived(
    typeof lifecycleFeedback?.authority === 'string' ? lifecycleFeedback.authority : null
  );

  // PMA — the ARMED flag (is the PM driving UNSUPERVISED?) + the loop's honest last-state. `armed`
  // reflects the optimistic action result first, then the loaded pm row. The loop-state is read-only
  // (the boot-started loop owns it) — F-008: never a fabricated 'done', only the real honest state.
  const autonomousFeedback = $derived(
    form && 'pm' in form ? (form.pm as Record<string, unknown>) : undefined
  );
  const pmArmed = $derived(
    autonomousFeedback?.action === 'autonomous' && typeof autonomousFeedback.autonomous === 'boolean'
      ? (autonomousFeedback.autonomous as boolean)
      : (data.pm?.autonomous ?? false)
  );
  // PMA — the operator's auto-publish CONSENT opt-in (default OFF). Reflects the optimistic action result
  // first, then the loaded pm row. RECORDED ONLY: this flag is not yet wired into the release/loop consumer,
  // so the loop ALWAYS halts at the publish gate today regardless of it (the real external publish stays
  // operator-gated — D-037). It records operator consent for a future wire-up; it is not agent authority.
  const pmAutoPublish = $derived(
    autonomousFeedback?.action === 'autoPublish' &&
      typeof autonomousFeedback.autoPublishPreauthorized === 'boolean'
      ? (autonomousFeedback.autoPublishPreauthorized as boolean)
      : (data.pm?.auto_publish_preauthorized ?? false)
  );
  // PMA — the active HARD spawn caps that bound unsupervised spend (surfaced on the arm confirm + inline).
  const spendCaps = $derived(data.spendCaps ?? { reTickCap: 24, dailySpawnCap: null });
  const capLabel = $derived(
    spendCaps.dailySpawnCap != null
      ? `${spendCaps.reTickCap} re-ticks/day per project, and the orchestrator's ${spendCaps.dailySpawnCap} session-spawns/day ceiling`
      : `${spendCaps.reTickCap} re-ticks/day per project`
  );
  // The hidden arm form is submitted only AFTER the real-spend + unsupervised confirm accepts (D-010).
  let armForm = $state<HTMLFormElement | null>(null);
  let armBusy = $state(false);

  /**
   * ARM autonomous drive behind the REAL-SPEND + UNSUPERVISED confirm (D-010). The confirm carries the
   * cost reality AND the active hard spawn cap so the operator sees the ceiling BEFORE any unsupervised
   * spend. Disarm is direct (no confirm — stopping is always safe). On accept we submit the hidden
   * ?/pmAutonomous form (its use:enhance flips the row live).
   */
  async function armAutonomous(): Promise<void> {
    if (armBusy) return;
    const ok = await confirm.confirm({
      title: 'Run autonomously to release?',
      message:
        'The PM will propose and develop work continuously toward the definition of done WITHOUT asking — ' +
        'this is real, unsupervised model spend, bounded by ' + capLabel + '. It stops honestly at a ' +
        'blocker, at the spend cap, or at the release gate; the final publish still needs your confirm ' +
        '(it never auto-publishes or hires).',
      confirmLabel: 'Arm — unsupervised spend',
      cancelLabel: 'Cancel'
    });
    if (!ok) return;
    armForm?.requestSubmit();
  }
  // The live loop's honest stop/continue state for this project (null when the loop has not acted yet).
  const loopState = $derived(data.autonomousLoop ?? null);
  // CC-STATUS — the headline work-queue stats for the status dashboard's spawn-budget tile (null on a
  // degraded boot — the tile shows an honest empty, never a fabricated count).
  const queue = $derived(data.queue ?? null);
  // CC-CONTROLS — the last CONTINUE / RESTART action results (read off the named form keys; F-008 —
  // a faithful read of the server result, never a fabricated success). Undefined until the operator acts.
  const continueFeedback = $derived(
    form && 'continue' in form ? (form.continue as Record<string, unknown>) : undefined
  );
  const restartFeedback = $derived(
    form && 'restart' in form ? (form.restart as Record<string, unknown>) : undefined
  );
  const loopStateLabel = $derived.by((): string => {
    switch (loopState?.state) {
      case 'running': return 'Driving — working the next batch';
      case 'blocked': return 'Stopped — blocked';
      case 'cap-reached': return 'Stopped — re-tick cap reached';
      case 'dod-reached': return 'Stopped — definition of done reached';
      case 'awaiting-release-confirm': return 'Awaiting your release confirmation';
      case 'published': return 'v1 shipped — autonomous mode complete (further versions on-demand)';
      default: return 'Idle';
    }
  });
  const loopStopped = $derived(
    loopState != null &&
      ['blocked', 'cap-reached', 'dod-reached', 'awaiting-release-confirm', 'published'].includes(loopState.state)
  );
  const lifecycleLeftForOperator = $derived(
    typeof lifecycleFeedback?.leftForOperator === 'number' ? lifecycleFeedback.leftForOperator : 0
  );
  // The live session id the tick spawned (the PM proposal-generation session). When present we both
  // navigate to ?session=<id> (so the Sessions tab streams it) and render the live transcript inline.
  const lifecycleSessionId = $derived(
    typeof lifecycleFeedback?.sessionId === 'string' ? lifecycleFeedback.sessionId : null
  );

  // When the tick returns a session id, open it so the EXISTING ?session= transcript pipeline
  // subscribes + streams it live (idempotent: openSession no-ops if we are already on it).
  $effect(() => {
    const sid = lifecycleSessionId;
    if (sid && selectedSession !== sid) openSession(sid);
  });

  /**
   * Run ONE lifecycle tick behind the real-spend confirm (PM-LC-3). The confirm carries the explicit
   * cost label (spec wording) so the operator sees what the click costs BEFORE any spend. On accept
   * we submit the hidden ?/startLifecycle form programmatically (its use:enhance drives busy + result).
   */
  let lifecycleForm = $state<HTMLFormElement | null>(null);
  async function startLifecycleTick(): Promise<void> {
    if (lifecycleBusy) return;
    const ok = await confirm.confirm({
      title: 'Start the project’s life?',
      message:
        'This spawns the PM agent to review the project, propose the next work, and start approved ' +
        'tasks — real model spend. It runs ONE tick (not a daemon); approved work starts only if the ' +
        'PM’s authority is “act”.',
      confirmLabel: 'Start — spend',
      cancelLabel: 'Cancel'
    });
    if (!ok) return;
    lifecycleForm?.requestSubmit();
  }

  // ── Memory tab (TASK 10.4) — client-side recall filter + node focus (mirrors /memory).
  let memQuery = $state('');
  const memFiltered = $derived(
    memQuery.trim()
      ? memories.filter((m) => m.content.toLowerCase().includes(memQuery.trim().toLowerCase()))
      : memories
  );
  let focusId = $state<string | null>(null);
  const focusedEdges = $derived(
    focusId ? graph.edges.filter((e) => e.from === focusId || e.to === focusId) : []
  );
  const neighbours = $derived(
    focusId
      ? new Set(focusedEdges.map((e) => (e.from === focusId ? e.to : e.from)))
      : new Set<string>()
  );

  // ── Settings tab (TASK 10.4) — project-level config form.
  let settingsBusy = $state(false);
  const settingsFeedback = $derived(
    form && 'settings' in form ? (form.settings as Record<string, unknown>) : undefined
  );

  // ── RC-4 — GitHub repo creation surface (Settings tab). The RC-3 server action `repoCreate`
  // (already wired in +page.server.ts) is the SOLE authority; this UI only drives it. The create is
  // ALWAYS private (RC-1/RC-2 hardcode --private; public is unrepresentable). Honest states (F-008):
  // no-repo / creating / created (real repo_url) / each NAMED failure (the gate's honest summary —
  // unauthed / permission-denied / already-exists). The confirm is a two-step UI gate (mirrors the
  // release confirm-token UX); the token itself is DERIVED server-side, never client-built.
  const repoBrief = $derived(data.repoBrief ?? null);
  let repoName = $state('');
  let repoOwner = $state('');
  let repoConfirming = $state(false); // step 2 of the two-step confirm gate (operator armed the create)
  let repoBusy = $state(false);
  let repoBriefBusy = $state(false);
  let repoBriefError = $state<string | null>(null);
  // The action result envelope (form.repo). On success: { created, failedAt, summary, repoUrl }.
  // On a boundary fail(): { error }. Honest — never dressed as success.
  const repoFeedback = $derived(
    form && 'repo' in form ? (form.repo as Record<string, unknown>) : undefined
  );
  // Default the repo-name field to the project slug once (operator can override before confirming).
  $effect(() => {
    if (!repoName && project && !project.repo_url) repoName = untrack(() => slug) ?? '';
  });

  // RC-4 — approve/reject the OPEN PM repo_create brief via /api/briefs (applyRepoCreateDecision).
  // Approve REQUIRES operatorConfirmed:true (the B4 integrity wall — a PM/agent can never set it).
  async function decideRepoBrief(id: string, action: 'approve' | 'reject'): Promise<void> {
    repoBriefBusy = true;
    repoBriefError = null;
    try {
      const res = await fetch('/api/briefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // approve carries the explicit operator confirm; reject does not drive the gate.
        body: JSON.stringify(
          action === 'approve' ? { id, action, operatorConfirmed: true } : { id, action }
        )
      });
      if (!res.ok) {
        const msg = await res.text();
        repoBriefError = msg || `the decision failed (HTTP ${res.status})`;
        return;
      }
      // The decision_brief / project SSE watchers re-invalidate the loader; pull the fresh state in.
      await invalidate('app:projects');
      await invalidate('app:pm');
    } catch (err) {
      repoBriefError = (err as Error).message;
    } finally {
      repoBriefBusy = false;
    }
  }

  // PM form state.
  let pmBusy = $state(false);
  let newMemoryKind = $state('observation');
  let newMemoryContent = $state('');
  let newDecisionTitle = $state('');
  let newDecisionContext = $state('');
  let newDecisionRationale = $state('');
  let newSprintName = $state('');
  let pmChatMessage = $state('');

  // ── TASK 16.1 — PM identity: the hired PM row + the hire-interview wizard. ──────
  const pm = $derived(data.pm ?? null);
  // ── TASK 16.4 — the proposals queue (PM-SPEC §4 Act with Purpose). ──────────────
  const proposals = $derived(data.proposals ?? []);
  const pmAuthorities = $derived(data.pmAuthorities ?? []);
  // ── PM→HR dispatch (gap A) — capability HIRE-gaps + the operator's needed-role slug entry. ──
  const staffingGaps = $derived(data.staffingGaps ?? []);
  const proposedDefectClasses = $derived(data.proposedDefectClasses ?? []);
  // The operator names the role to hire per gap (a gap is per-defect-class; the role is the
  // operator's choice). Keyed by the gap's defectClass so each gap row has its own input.
  let hireRoleSlug = $state<Record<string, string>>({});
  let hireBusy = $state(false);
  const hireForm = $derived(
    form && 'hire' in form ? (form.hire as Record<string, unknown>) : undefined
  );
  // ── Gap D — PM FIT-VERDICT on open cert_hire hire-gate briefs. The project PM judges fit for
  // THIS project before the operator's B4 decision (a DENY pre-sets the operator surface to reject;
  // the operator can override — D-039 final). Recording a fit-verdict NEVER flips the cert/staffs. ──
  const hireGates = $derived(data.hireGates ?? []);
  let fitReason = $state<Record<string, string>>({});
  let fitBusy = $state<Record<string, boolean>>({});
  const fitForm = $derived(
    form && 'fit' in form ? (form.fit as Record<string, unknown>) : undefined
  );
  function refTail(id: string): string {
    const s = String(id);
    const c = s.indexOf(':');
    return c >= 0 ? s.slice(c + 1) : s;
  }
  let reviseOpenFor = $state<string | null>(null);
  let reviseTitle = $state('');
  let reviseObjective = $state('');
  let revisePurpose = $state('');
  let reviseCriteria = $state('');

  function startRevise(entry: (typeof proposals)[number]): void {
    reviseOpenFor = entry.task.id;
    reviseTitle = entry.task.title;
    reviseObjective = entry.task.objective ?? '';
    revisePurpose = entry.task.purpose ?? '';
    reviseCriteria = (entry.task.acceptance_criteria ?? []).join('\n');
  }
  const hireQuestions = $derived(data.hireQuestions ?? []);
  // Smart-skip (PM-SPEC §1): questions the project scan already answers are shown as
  // pre-answered evidence, never asked; the rest are asked ONE AT A TIME.
  const hireAskable = $derived(hireQuestions.filter((q) => !q.preAnswered));
  const hirePreAnswered = $derived(hireQuestions.filter((q) => q.preAnswered));

  type HireDraft = { id: string; answer: string; push: string; skipped: boolean };
  let hireOpen = $state(false);
  let hirePhase = $state<'questions' | 'charter'>('questions');
  let hireStep = $state(0);
  let hireDrafts = $state<HireDraft[]>([]);
  let hireAnswerDraft = $state('');
  let hirePushDraft = $state('');
  // Push-once (PM-SPEC §1): after the first polished answer we push exactly once.
  let hirePushOpen = $state(false);
  let hireName = $state('');
  let hirePersona = $state('');
  let hireCharter = $state('');

  const hireCurrent = $derived(hireAskable[hireStep] ?? null);
  const hireAnswered = $derived(hireDrafts.filter((d) => !d.skipped).length);
  const hireSkipped = $derived(hireDrafts.filter((d) => d.skipped).length);
  const hireAnswersJson = $derived(
    JSON.stringify(
      hireDrafts.map((d) => ({
        id: d.id,
        ...(d.answer ? { answer: d.answer } : {}),
        ...(d.push ? { push: d.push } : {}),
        ...(d.skipped ? { skipped: true } : {})
      }))
    )
  );

  function startHire(): void {
    hireOpen = true;
    hirePhase = hireAskable.length > 0 ? 'questions' : 'charter';
    hireStep = 0;
    hireDrafts = [];
    hireAnswerDraft = '';
    hirePushDraft = '';
    hirePushOpen = false;
    hireName = '';
    hirePersona = '';
    hireCharter = '';
  }

  function hireAdvance(): void {
    hireStep += 1;
    hireAnswerDraft = '';
    hirePushDraft = '';
    hirePushOpen = false;
    if (hireStep >= hireAskable.length) hirePhase = 'charter';
  }

  /** Commit the current answer. First commit of a non-empty answer opens the
   *  push-once follow-up; the second commit (with or without it) advances. */
  function hireContinue(): void {
    if (!hireCurrent) return;
    const answer = hireAnswerDraft.trim();
    if (!answer) {
      hireSkipCurrent();
      return;
    }
    if (!hirePushOpen) {
      hirePushOpen = true; // push once past the first polished answer
      return;
    }
    hireDrafts = [
      ...hireDrafts,
      { id: hireCurrent.id, answer, push: hirePushDraft.trim(), skipped: false }
    ];
    hireAdvance();
  }

  /** Operator escape hatch — respected immediately, recorded as an honest gap. */
  function hireSkipCurrent(): void {
    if (!hireCurrent) return;
    hireDrafts = [...hireDrafts, { id: hireCurrent.id, answer: '', push: '', skipped: true }];
    hireAdvance();
  }

  /** Skip ALL remaining questions (the operator may skip any or all — PM-SPEC §1). */
  function hireSkipRest(): void {
    const rest = hireAskable.slice(hireStep).map((q) => ({
      id: q.id,
      answer: '',
      push: '',
      skipped: true
    }));
    hireDrafts = [...hireDrafts, ...rest];
    hireStep = hireAskable.length;
    hirePhase = 'charter';
    hireAnswerDraft = '';
    hirePushDraft = '';
    hirePushOpen = false;
  }

  // ── Charter editor (D-010 diff+confirm — WORKFORCE-SPEC §8) ─────────────────────
  let charterEditing = $state(false);
  let charterDraft = $state('');
  let charterFormEl = $state<HTMLFormElement | null>(null);

  function startCharterEdit(): void {
    charterDraft = pm?.charter ?? '';
    charterEditing = true;
  }

  /** D-010: show the unified diff of the charter change and require an explicit
   *  confirm BEFORE the write is submitted. No change → just close the editor. */
  async function reviewAndSaveCharter(): Promise<void> {
    const before = pm?.charter ?? '';
    const next = charterDraft.trim();
    const diff = lineDiff(before, next);
    if (diff.length === 0) {
      charterEditing = false;
      return;
    }
    const ok = await confirm.confirm({
      title: 'Update PM charter',
      message: next
        ? 'The charter is injected into every PM session and review — review the change before it persists.'
        : 'This CLEARS the charter — PM sessions and reviews will run without operator directives.',
      confirmLabel: next ? 'Save charter' : 'Clear charter',
      danger: !next,
      diff
    });
    if (ok) charterFormEl?.requestSubmit();
  }

  // The PM action feedback (shared `form?.pm` envelope for every PM sub-action).
  const pmFeedback = $derived(
    form && 'pm' in form ? (form.pm as Record<string, unknown>) : undefined
  );

  function memoryKindLabel(k: string): string {
    return k.charAt(0).toUpperCase() + k.slice(1);
  }

  // Live updates: a project/task/session row change re-runs the server loader. SSR-safe —
  // $effect runs only in the browser, and the handlers are torn down on unmount.
  $effect(() => {
    const offP = stream.onDbChange('project', () => void invalidate('app:projects'));
    const offT = stream.onDbChange('task', () => void invalidate('app:tasks'));
    const offS = stream.onDbChange('session', () => void invalidate('app:fleet'));
    // PM rows (typed memory + decisions) re-run the loader so the PM tab updates live.
    const offM = stream.onDbChange('pm_memory', () => void invalidate('app:pm'));
    const offD = stream.onDbChange('decision', () => void invalidate('app:pm'));
    const offSp = stream.onDbChange('sprint', () => void invalidate('app:pm'));
    const offRv = stream.onDbChange('pm_review', () => void invalidate('app:pm'));
    // TASK 16.1 — the hired PM identity (charter edits, hire) updates live.
    const offPm = stream.onDbChange('pm', () => void invalidate('app:pm'));
    // TASK 16.4 — proposals queue: panel verdicts + decision briefs update live.
    const offPv = stream.onDbChange('panel_verdict', () => void invalidate('app:pm'));
    const offDb = stream.onDbChange('decision_brief', () => void invalidate('app:pm'));
    // AGENCY-PULSE — HR/role activity (hires/cert/swaps) lands in the activity strip live.
    const offRe = stream.onDbChange('role_event', () => void invalidate('app:pm'));
    // TASK 10.4 — the Maintain panel + Memory tab update live too.
    const offF = stream.onDbChange('security_finding', () => void invalidate('app:findings'));
    const offMem = stream.onDbChange('memory', () => void invalidate('app:memory'));
    const offE = stream.onDbChange('entity', () => void invalidate('app:graph'));
    // LP-3 — the Loops tab's per-loop run history is agent_event; a run event re-invalidates the
    // loader so the loop cards' last-run / recent-runs re-derive live (the arm/cadence state already
    // re-invalidates via the pm watcher above).
    const offAe = stream.onDbChange('agent_event', () => void invalidate('app:analytics'));
    return () => {
      offP();
      offT();
      offS();
      offM();
      offD();
      offSp();
      offRv();
      offPm();
      offPv();
      offDb();
      offRe();
      offF();
      offMem();
      offE();
      offAe();
    };
  });

  // ── Live transcript (PRODUCT §4.8): stream the selected session's transcript over the one
  // SSE bus (`transcript`/`token_usage`/`session_status` events, §2.11). We seed from the
  // persisted historical transcript (data.transcript) and append each streamed event live.
  // Both the seed and each live event are normalized to the SHARED `Turn` shape (transcript-
  // core) so this view is KIND-AWARE — thinking/tool turns render distinctly, identical to
  // the /claude-code replay (the <SessionTranscript> component renders the framing). The old
  // by-role model dropped the `thinking` event entirely and showed thinking as assistant prose.
  let liveTurns = $state<Turn[]>([]);
  let liveTokens = $state<{ tokensIn: number; tokensOut: number } | null>(null);
  let liveStatus = $state<string | null>(null);

  $effect(() => {
    // Reset the live buffer to the historical transcript whenever the selection changes.
    const sid = selectedSession;
    // Build the seed from the loader rows into a LOCAL first, then assign. We must NOT read back
    // `liveTurns` (the $state we just wrote) inside this same effect — doing so makes the effect
    // depend on its own write and re-run forever (effect_update_depth_exceeded). The seq counter
    // below seeds from the local `seed.length`, never from the reactive `liveTurns`.
    const seed = (data.transcript ?? []).map((m, i) => rowToTurn(m, i));
    liveTurns = seed;
    liveTokens = null;
    liveStatus = null;
    if (!sid) return;

    // Monotonic key for live-appended turns (stable {#each} keys, never colliding with the
    // historical rows' own ids). Starts past the seeded rows.
    let liveSeq = seed.length;

    const offT = stream.subscribeTopic<{ kind: string; event: unknown }>(
      'transcript',
      sid,
      (d) => {
        const ev = d.event as Record<string, unknown> | undefined;
        const turn = liveEventToTurn(ev, liveSeq);
        if (!turn) return; // lifecycle (token_usage/done/error) or shapeless event — not a turn
        liveSeq += 1;
        // TASK 8.3 — the wake-up briefing (recalled fenced memory) LEADS the transcript so the
        // operator sees the past context the agent woke up with; every other turn appends.
        liveTurns = turn.kind === 'briefing' ? [turn, ...liveTurns] : [...liveTurns, turn];
      }
    );
    // GA2 — a LIVE operator interject (a channel push into this running session) is republished
    // on the one bus as an `interject` event (`{ origin, steer, messageId, content }`, D-035 /
    // §2.11). Append it IMMEDIATELY as a COMMUNICATION turn (shared `interjectEventToTurn` — the
    // live twin of the persisted row's `rowToTurn` path) so a pushed message appears the instant it
    // streams, not only on reload (the gap: the live transcript subscribed to `transcript` only).
    // HONEST: the rendered origin is the server stamp (D-035a) — the client only LABELS it; content
    // is the verbatim delivered body. Idempotent (re-fire-safe): a messageId already shown is not
    // appended twice (the persisted reload-merge on selection change uses the same row id).
    const offI = stream.subscribeTopic<{
      origin?: string;
      steer?: boolean;
      messageId?: string;
      content?: string;
    }>('interject', sid, (d) => {
      const turn = interjectEventToTurn(d as Record<string, unknown>, liveSeq);
      if (!turn) return;
      if (liveTurns.some((t) => t.id === turn.id)) return; // already appended (idempotent)
      liveSeq += 1;
      liveTurns = [...liveTurns, turn];
    });
    const offU = stream.subscribeTopic<{ tokensIn: number; tokensOut: number }>(
      'token_usage',
      sid,
      (d) => (liveTokens = d)
    );
    const offS = stream.subscribeTopic<{ status: string }>(
      'session_status',
      sid,
      (d) => (liveStatus = d.status)
    );
    return () => {
      offT();
      offI();
      offU();
      offS();
    };
  });

  // Selected task for the launch form.
  let launchTaskId = $state('');
  let launching = $state(false);

  // ── Session control (interject / stop / resume) via the loopback control endpoint ──────
  let interjectMsg = $state('');
  let controlBusy = $state(false);
  let controlError = $state<string | null>(null);

  // ── CC-3 OVERVIEW IA — progressive disclosure (operator: the overview "floods" at a glance).
  // The at-a-glance summary (ProjectStatus MC-1) + the live controls/activity stay always-visible;
  // the secondary detail panels (Plan, Maintain findings) collapse by default behind a real
  // <button aria-expanded> disclosure (the same a11y pattern as ProjectActivity's session toggles).
  // No surface is removed — only relocated/collapsed; expanding reveals the full original panel.
  // Default-collapsed so the page reads cleanly; nothing here is reactive to live data, so a plain
  // $state record is correct (not derived).
  let ovOpen = $state<{ plan: boolean; maintain: boolean }>({ plan: false, maintain: false });

  // TASK 14.6 — the HONEST backend capability matrix (F-008): a control the wired backend
  // cannot really perform renders DISABLED with its reason, never a dead/deceptive button.
  const caps = $derived(
    data.controlCaps ?? { available: false, interject: false, resume: false, stop: false }
  );
  const capsNote = $derived.by((): string | null => {
    if (!caps.available) return caps.reason ?? 'session controls unavailable — no runtime';
    const off: string[] = [];
    if (!caps.interject) off.push('interject');
    if (!caps.resume) off.push('resume');
    if (!caps.stop) off.push('stop');
    return off.length ? `${off.join(' + ')} not supported by this backend` : null;
  });

  async function sendControl(action: 'interject' | 'stop' | 'resume'): Promise<void> {
    if (!selectedSession) return;
    controlBusy = true;
    controlError = null;
    try {
      const sid = shortId(selectedSession);
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          action === 'interject' ? { action, message: interjectMsg } : { action }
        )
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        controlError = j.message ?? `control failed (${res.status})`;
      } else if (action === 'interject') {
        interjectMsg = '';
      }
    } catch (e) {
      controlError = (e as Error).message;
    } finally {
      controlBusy = false;
    }
  }

  function openSession(id: string): void {
    void goto(`/projects/${slug}?session=${encodeURIComponent(id)}`, { keepFocus: true, noScroll: true });
  }

  /** Expand the session (open its inline transcript) or, if already open, collapse it by clearing
   *  the `?session=` selection. Drives the SAME selection the parent's live transcript pipeline
   *  subscribes to, so the inline Activity transcript streams via the existing SSE wiring. */
  function toggleSession(id: string): void {
    if (selectedSession === id) {
      void goto(`/projects/${slug}`, { keepFocus: true, noScroll: true });
    } else {
      openSession(id);
    }
  }

  function shortId(id: string): string {
    const i = id.indexOf(':');
    return i >= 0 ? id.slice(i + 1) : id;
  }

  function fmtTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // ONE shared clock for every time-relative surface on this page (session list elapsed, task card
  // ages) — a single 1s interval, never per-row timers (keeps a running session's elapsed ticking
  // without hammering). Torn down on unmount.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });

  /** Strip the `table:` prefix from a record id for compact display. */
  function bareId(id: string): string {
    return id.replace(/^\w+:/, '');
  }
  function focusNode(id: string): void {
    focusId = focusId === id ? null : id;
  }

  const selectedRow = $derived(sessions.find((s) => s.id === selectedSession));
  const selectedIsRunning = $derived((liveStatus ?? selectedRow?.status) === 'running');
</script>

<svelte:head>
  <title>{projectName} — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">project</span>
    <h1 class="title">{projectName}</h1>
    {#if project}
      <p class="path mono" title={project.root_path}>{project.root_path}</p>
      <div class="meta">
        <span class="status" data-status={project.status}>{project.status}</span>
        {#if createIncomplete}
          <span class="setup-badge" title="Create-with-AI setup did not finish — resume below">
            setup incomplete
          </span>
        {/if}
        {#each project.ecosystem as e (e)}
          <span class="tag mono">{e}</span>
        {/each}
      </div>
    {/if}
  </header>

  {#if project && createIncomplete}
    <!-- CAH4 recovery — the honest incomplete-create banner + resume affordance (F-008). The
         scaffold + registration succeeded but a post-register writer threw, so the project is
         REAL but only partially wired. Resume re-runs the recoverable, idempotent writers
         (re-scan from disk + an idempotent PM completion) on the EXISTING row — it NEVER
         re-scaffolds and NEVER deletes the project. The SSE `project` watcher clears this live. -->
    <div class="card setup-card" role="region" aria-label="incomplete project setup">
      <div class="setup-head">
        <span class="eyebrow">setup incomplete</span>
      </div>
      <p class="state-body">
        This project was created with Create-with-AI, but its setup did not finish — the project
        files and repository are real on disk, but some of the wiring (plan, capability needs,
        founding tasks, targets, or the PM) was not completed. Resuming re-runs the recoverable
        steps on the existing project. It never re-creates or deletes anything.
      </p>

      <form
        method="POST"
        action="?/resumeCreate"
        use:enhance={() => {
          resumeBusy = true;
          return async ({ update }) => {
            await update({ reset: false });
            resumeBusy = false;
          };
        }}
      >
        <button
          class="btn primary"
          type="submit"
          aria-busy={resumeBusy}
          disabled={resumeBusy}
        >
          {resumeBusy ? 'Resuming setup…' : 'Resume setup'}
        </button>
      </form>

      <!-- Honest result (F-008): the action returns { resume } — never a fake spinner-as-done. -->
      {#if form && 'resume' in form && form.resume}
        {#if 'ok' in form.resume && form.resume.ok}
          <p class="form-ok" role="status" aria-live="polite">
            Setup resumed — the project is now complete{#if 'pmName' in form.resume && form.resume.pmName}, PM {form.resume.pmName} confirmed{/if}.
          </p>
        {:else if 'error' in form.resume && form.resume.error}
          <p class="form-error" role="alert">{form.resume.error}</p>
        {/if}
      {/if}
    </div>
  {/if}

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing nothing rather than fabricated detail.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else if !project}
    <div class="card state">
      <span class="eyebrow">not found</span>
      <p class="state-body">No project matches this id.</p>
    </div>
  {:else}
    <nav class="tabs" aria-label="project sections">
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'overview'}
        data-active={tab === 'overview'}
        onclick={() => (tab = 'overview')}>Overview</button
      >
      <!-- 14.3: the count badge would concatenate into the accessible name
           ("Tasks2") — give the button an explicit name and hide the badge
           from the accessibility tree. -->
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'tasks'}
        aria-label={tasks.length > 0 ? `Tasks, ${tasks.length} ${tasks.length === 1 ? 'item' : 'items'}` : 'Tasks'}
        data-active={tab === 'tasks'}
        onclick={() => (tab = 'tasks')}
        >Tasks{#if tasks.length > 0}<span class="count mono" aria-hidden="true">{tasks.length}</span>{/if}</button
      >
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'roadmap'}
        data-active={tab === 'roadmap'}
        onclick={() => (tab = 'roadmap')}>Roadmap</button
      >
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'pm'}
        aria-label={pmStats && pmStats.total > 0 ? `PM, ${pmStats.total} ${pmStats.total === 1 ? 'item' : 'items'}` : 'PM'}
        data-active={tab === 'pm'}
        onclick={() => (tab = 'pm')}
        >PM{#if pmStats && pmStats.total > 0}<span class="count mono" aria-hidden="true">{pmStats.total}</span>{/if}</button
      >
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'sessions'}
        data-active={tab === 'sessions'}
        onclick={() => (tab = 'sessions')}>Sessions</button
      >
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'memory'}
        aria-label={memories.length > 0 ? `Memory, ${memories.length} ${memories.length === 1 ? 'item' : 'items'}` : 'Memory'}
        data-active={tab === 'memory'}
        onclick={() => (tab = 'memory')}
        >Memory{#if memories.length > 0}<span class="count mono" aria-hidden="true">{memories.length}</span>{/if}</button
      >
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'loops'}
        aria-label={loops.length > 0 ? `Loops, ${loops.length} ${loops.length === 1 ? 'loop' : 'loops'}` : 'Loops'}
        data-active={tab === 'loops'}
        onclick={() => (tab = 'loops')}
        >Loops{#if loops.length > 0}<span class="count mono" aria-hidden="true">{loops.length}</span>{/if}</button
      >
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'release'}
        data-active={tab === 'release'}
        onclick={() => (tab = 'release')}>Release</button
      >
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'sync'}
        data-active={tab === 'sync'}
        onclick={() => (tab = 'sync')}>Sync</button
      >
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'targets'}
        data-active={tab === 'targets'}
        onclick={() => (tab = 'targets')}>Targets</button
      >
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'settings'}
        data-active={tab === 'settings'}
        onclick={() => (tab = 'settings')}>Settings</button
      >
    </nav>

    {#if tab === 'overview'}
      <div class="tab-body">
        <!-- CC-STATUS — the at-a-glance command-center status dashboard (extracted sub-component). All
             counts/badges derive LIVE from the rows the loader already fetched (F-008). -->
        <ProjectStatus
          name={projectName ?? project.name}
          status={project.status}
          definitionOfDone={project.plan?.definition_of_done}
          {tasks}
          {sessions}
          loop={loopState}
          {queue}
          {pm}
        />

        <!-- CC-CONTROLS — the operator command-center CONTROLS: CONTINUE (re-drive this project's ready
             tasks through the live orchestrator) + RESTART a failed/stuck session's task. Guarded against
             double-spawn (the work_item dedup_key) + bounded by the spawn cap (the orchestrator's own
             cap inside drain). The RE-RUN PM / ARM / DISARM / STOP controls live in the Project lifecycle
             card below. -->
        <ProjectControls {tasks} {sessions} {continueFeedback} {restartFeedback} />

        <!-- ACTIVITY — the live "what's happening now?" panel: this project's running + recent
             sessions, kind-labelled (PM lifecycle / validation panel / dev task / HR), each
             expandable inline to its FULL live transcript (the shared <SessionTranscript> fed by
             the same `?session=` SSE pipeline). Consolidates the per-session watching that used to
             require /claude-code into the project view. Honest idle/failed states (F-008). -->
        <ProjectActivity
          {sessions}
          {proposals}
          loop={loopState}
          roleEvents={data.roleEvents ?? []}
          {selectedSession}
          turns={liveTurns}
          {liveStatus}
          {liveTokens}
          onToggle={toggleSession}
          onViewFile={viewFileSnapshot}
        />

        <!-- At-a-glance counts → the dedicated surfaces. Relocated up under the live activity (CC-3
             IA) as the compact drill-in row, so the operator sees the headline figures + can jump
             to detail tabs without scrolling past the lifecycle/maintain panels. Counts are LIVE
             from the loader rows (F-008). -->
        <ul class="overview-stats" aria-label="project at a glance">
          <li class="card stat">
            <span class="stat-val">{tasks.length}</span>
            <button class="stat-label link-inline" type="button" onclick={() => (tab = 'tasks')}>open tasks →</button>
          </li>
          <li class="card stat">
            <span class="stat-val">{releases.length}</span>
            <button class="stat-label link-inline" type="button" onclick={() => (tab = 'roadmap')}>releases →</button>
          </li>
          <li class="card stat">
            <span class="stat-val">{sessions.length}</span>
            <button class="stat-label link-inline" type="button" onclick={() => (tab = 'sessions')}>sessions →</button>
          </li>
          <li class="card stat">
            <span class="stat-val" data-tone={findings.length > 0 ? 'warn' : ''}>{findings.length}</span>
            <button class="stat-label link-inline" type="button" onclick={() => (ovOpen.maintain = true)}>open findings →</button>
          </li>
        </ul>

        <!-- CC-3 IA — the Plan macro is reference detail, not at-a-glance: collapsed by default
             behind a keyboard-accessible disclosure (aria-expanded). The whole panel is preserved —
             expanding reveals the original Plan card verbatim. -->
        <section class="card disclosure" aria-label="Plan">
          <button
            type="button"
            class="disclosure-head"
            aria-expanded={ovOpen.plan}
            aria-controls="ov-plan-body"
            onclick={() => (ovOpen.plan = !ovOpen.plan)}
          >
            <span class="section-title">Plan</span>
            <span class="disclosure-hint">
              {#if project.plan && (project.plan.purpose || project.plan.long_term_vision || project.plan.role || project.plan.definition_of_done)}
                <span class="disclosure-sub">purpose · vision · role · DoD</span>
              {:else}
                <span class="disclosure-sub muted">not set</span>
              {/if}
              <span class="chevron" data-open={ovOpen.plan} aria-hidden="true">›</span>
            </span>
          </button>
          {#if ovOpen.plan}
            <div id="ov-plan-body" class="disclosure-body">
              {#if project.plan && (project.plan.purpose || project.plan.long_term_vision || project.plan.role || project.plan.definition_of_done)}
                <dl class="plan">
                  {#if project.plan.purpose}
                    <dt>Purpose</dt>
                    <dd>{project.plan.purpose}</dd>
                  {/if}
                  {#if project.plan.long_term_vision}
                    <dt>Vision</dt>
                    <dd>{project.plan.long_term_vision}</dd>
                  {/if}
                  {#if project.plan.role}
                    <dt>Role</dt>
                    <dd>{project.plan.role}</dd>
                  {/if}
                  {#if project.plan.definition_of_done}
                    <dt>Definition of done</dt>
                    <dd>{project.plan.definition_of_done}</dd>
                  {/if}
                </dl>
              {:else}
                <p class="state-body">No plan macro set yet for this project.</p>
              {/if}
            </div>
          {/if}
        </section>

        <!-- PM-LC-3 (PM-LIFECYCLE-SPEC §PM-LC-3) — the one-click "start the project's life" control.
             No PM hired → a "Hire a PM first" CTA to the EXISTING hire flow (never auto-hires). PM
             hired → a prominent "Start the project's life" button behind a real-spend confirm. On a
             returned sessionId the PM session's transcript streams LIVE (reuses the SSE pipeline);
             the tick result renders honestly (idle / running / done / empty / error). -->
        <div class="card lifecycle-card">
          <div class="lifecycle-head">
            <h2 class="section-title">Project lifecycle</h2>
            {#if pm}
              <span class="count mono" title="the PM's current authority">authority: {pm.authority}</span>
            {/if}
          </div>

          {#if !pm}
            <!-- No PM hired: the honest empty state + the hire CTA. NEVER auto-hires (LOCKED). -->
            <p class="state-body">
              This project has no Project Manager yet. Hire a PM to let it review the project, propose
              the next work, and start approved tasks.
            </p>
            <button class="btn primary" type="button" onclick={() => { tab = 'pm'; startHire(); }}>
              Hire a PM first
            </button>
          {:else}
            <p class="state-body">
              One click runs a single PM lifecycle tick: the PM reviews the project, proposes the next
              work, and an independent panel validates each proposal. With authority
              <span class="mono">act</span> approved proposals start automatically; with
              <span class="mono">propose</span> they wait for your approval below.
            </p>

            <!-- The real-spend trigger. The hidden form posts ?/startLifecycle; the button opens the
                 cost-labelled confirm first (D-010). use:enhance drives busy + the named result. -->
            <form
              bind:this={lifecycleForm}
              method="POST"
              action="?/startLifecycle"
              use:enhance={() => {
                lifecycleBusy = true;
                return async ({ update }) => {
                  await update({ reset: false });
                  lifecycleBusy = false;
                };
              }}
            >
              <button
                class="btn primary lifecycle-start"
                type="button"
                aria-label="Start the project's life — runs one PM lifecycle tick (real model spend)"
                aria-busy={lifecycleBusy}
                disabled={lifecycleBusy}
                onclick={() => void startLifecycleTick()}
              >
                {lifecycleBusy ? 'Starting the project’s life…' : 'Start the project’s life'}
              </button>
            </form>

            <!-- PMA — "Run autonomously to release". ARM ⇒ the boot-started loop re-runs the lifecycle
                 tick after each promoted batch drains, looping toward the DoD and HALTING honestly at
                 blocked / cap-reached / awaiting-release-confirm. It NEVER bypasses an operator gate (no
                 publish — D-037; no hire — D-039) and bounds spend (the re-tick cap + the D-021 daily cap).
                 ARM is behind a real-spend + unsupervised confirm (D-010) carrying the cost + the active
                 cap; DISARM is a prominent STOP always available while armed (stopping is always safe). -->
            <div class="autonomous-control" data-armed={pmArmed}>
              <div class="autonomous-row">
                <div class="autonomous-label">
                  <span class="auto-title">Run autonomously to release</span>
                  <span class="auto-sub">
                    {pmArmed
                      ? `Armed — the PM drives unsupervised toward the first release, bounded by ${capLabel}. It stops on a blocker, at the spend cap, and at the publish gate (never auto-publishes or hires).`
                      : `Off — the PM runs only when you click “Start the project’s life”. When armed, unsupervised spend is bounded by ${capLabel}.`}
                  </span>
                </div>

                <!-- DISARM (the prominent STOP) is a direct submit — stopping is always safe, no confirm.
                     ARM opens the cost + cap confirm first, then submits this same hidden form. -->
                <form
                  bind:this={armForm}
                  method="POST"
                  action="?/pmAutonomous"
                  use:enhance={() => {
                    armBusy = true;
                    return async ({ update }) => {
                      await update({ reset: false });
                      armBusy = false;
                    };
                  }}
                >
                  <input type="hidden" name="armed" value={pmArmed ? 'false' : 'true'} />
                  {#if pmArmed}
                    <!-- STOP / disarm — always available while armed; submits directly (no confirm). -->
                    <button
                      class="btn warn autonomous-stop"
                      type="submit"
                      aria-pressed="true"
                      aria-busy={armBusy}
                      disabled={armBusy}
                      aria-label="Stop autonomous drive (disarm)"
                    >
                      {armBusy ? 'Stopping…' : 'Stop autonomous drive'}
                    </button>
                  {:else}
                    <!-- ARM — opens the real-spend + unsupervised confirm (cost + active cap) first. -->
                    <button
                      class="btn primary"
                      type="button"
                      aria-pressed="false"
                      aria-busy={armBusy}
                      disabled={armBusy}
                      aria-label="Arm autonomous drive — runs unsupervised toward release (real model spend)"
                      onclick={() => void armAutonomous()}
                    >
                      {armBusy ? 'Arming…' : 'Run autonomously to release'}
                    </button>
                  {/if}
                </form>
              </div>

              <!-- The auto-publish CONSENT toggle (default OFF). A CLEARLY-LABELLED operator switch that
                   RECORDS consent only — it is NOT yet wired into the release/loop consumer, so the loop
                   ALWAYS halts at the publish gate for your one tap regardless of this flag (the real
                   external publish stays operator-gated — D-037). It captures operator consent for a future
                   wire-up; it is not agent authority and never bypasses the gate today. Surfaced only while
                   armed (it only matters once the loop is driving). -->
              {#if pmArmed}
                <form
                  method="POST"
                  action="?/pmAutoPublish"
                  use:enhance={() => async ({ update }) => { await update({ reset: false }); }}
                >
                  <input type="hidden" name="preauthorized" value={pmAutoPublish ? 'false' : 'true'} />
                  <label class="autopublish-opt">
                    <button
                      class="toggle"
                      type="submit"
                      role="switch"
                      aria-checked={pmAutoPublish}
                      data-on={pmAutoPublish}
                      aria-label={pmAutoPublish
                        ? 'Turn OFF recorded auto-publish consent (clears your recorded consent)'
                        : 'Record auto-publish consent (recorded only — the loop still always halts at the publish gate for your tap)'}
                    >
                      <span class="toggle-knob" aria-hidden="true"></span>
                    </button>
                    <span class="autopublish-copy">
                      <span class="autopublish-title">
                        Record auto-publish consent
                        <span class="autopublish-state mono" data-on={pmAutoPublish}>{pmAutoPublish ? 'RECORDED' : 'OFF'}</span>
                      </span>
                      <span class="autopublish-sub">
                        {pmAutoPublish
                          ? 'Recorded — your consent is saved, but it is not yet acted on: the loop still always halts at the publish gate and waits for your one tap (the real external publish stays operator-gated, D-037). Turn off to clear it.'
                          : 'Off — the loop halts at the release gate and waits for your one tap. It never auto-publishes.'}
                      </span>
                    </span>
                  </label>
                </form>
              {/if}

              <!-- The live loop's honest state for this project (F-008 — a real read, never a fake done). -->
              {#if loopState}
                <div
                  class="autonomous-state"
                  data-stopped={loopStopped}
                  data-state={loopState.state}
                  role="status"
                  aria-live="polite"
                >
                  <span class="auto-state-label">{loopStateLabel}</span>
                  <span class="auto-state-reason">{loopState.reason}</span>
                  {#if loopState.state === 'awaiting-release-confirm'}
                    <a class="link-inline" href={releaseHref}>
                      Review and confirm the release →
                    </a>
                  {/if}
                </div>
              {/if}
              <!-- LG-3 — the live causal node-graph of this project's lifecycle. -->
              <a class="link-inline" href={graphHref}>See the lifecycle graph →</a>
            </div>

            <!-- Honest tick state (F-008): never a fake spinner-as-done. -->
            {#if lifecycleState === 'running'}
              <p class="state-body" role="status" aria-live="polite">
                The PM is reviewing the project and proposing work — watch it think below.
              </p>
            {:else if lifecycleState === 'error'}
              <p class="form-error" role="alert">{String(lifecycleFeedback?.error)}</p>
            {:else if lifecycleState === 'busy-elsewhere'}
              <p class="form-ok" role="status" aria-live="polite">
                {lifecycleFeedback?.summary
                  ? String(lifecycleFeedback.summary)
                  : 'A lifecycle tick is already running for this project — let it finish before starting another.'}
              </p>
            {:else if lifecycleState === 'empty'}
              <p class="form-ok" role="status">
                {lifecycleFeedback?.summary
                  ? String(lifecycleFeedback.summary)
                  : 'PM lifecycle tick complete — no actionable gaps found. Nothing was proposed.'}
              </p>
            {:else if lifecycleState === 'done'}
              <div class="lifecycle-result" role="status" aria-live="polite">
                <p class="form-ok">{String(lifecycleFeedback?.summary ?? 'PM lifecycle tick complete.')}</p>
                <ul class="lifecycle-counts" aria-label="tick result">
                  <li><span class="lc-n">{Number(lifecycleFeedback?.generated ?? 0)}</span> generated</li>
                  <li><span class="lc-n">{Number(lifecycleFeedback?.validated ?? 0)}</span> validated</li>
                  <li><span class="lc-n">{Number(lifecycleFeedback?.promoted ?? 0)}</span> promoted to ready</li>
                  <li><span class="lc-n">{lifecycleLeftForOperator}</span> awaiting your approval</li>
                  {#if Number(lifecycleFeedback?.panelFailures ?? 0) > 0}
                    <li class="lc-warn">
                      <span class="lc-n">{Number(lifecycleFeedback?.panelFailures)}</span> panel run(s) failed
                    </li>
                  {/if}
                </ul>
                <!-- authority='propose' → link the EXISTING proposals panel (PM tab). -->
                {#if lifecycleAuthority === 'propose' && lifecycleLeftForOperator > 0}
                  <button
                    class="link-inline"
                    type="button"
                    onclick={() => {
                      tab = 'pm';
                      document.getElementById('proposals-queue')?.scrollIntoView({ block: 'start' });
                    }}
                  >
                    {lifecycleLeftForOperator} proposal{lifecycleLeftForOperator === 1 ? '' : 's'} awaiting your approval →
                  </button>
                {/if}
              </div>
            {/if}

            <!-- LIVE: when the tick spawned a session, the EXISTING ?session= transcript pipeline is
                 already streaming it (we navigated to it). Render that live transcript inline here so
                 the operator watches the PM think without leaving Overview. -->
            {#if lifecycleSessionId && selectedSession === lifecycleSessionId}
              <div class="lifecycle-live">
                <div class="transcript-head">
                  <h3 class="section-subtitle">
                    PM session <span class="mono sid">{shortId(lifecycleSessionId)}</span>
                  </h3>
                  <div class="transcript-meta">
                    {#if liveStatus ?? selectedRow?.status}
                      <span class="status" data-status={liveStatus ?? selectedRow?.status}>
                        {liveStatus ?? selectedRow?.status}
                      </span>
                    {/if}
                    {#if liveTokens}
                      <span class="tokens mono">↓{liveTokens.tokensIn} ↑{liveTokens.tokensOut} tok</span>
                    {/if}
                  </div>
                </div>
                <div class="transcript" role="log" aria-live="polite" aria-label="PM lifecycle session transcript">
                  {#if liveTurns.length === 0}
                    <p class="state-body">No transcript yet — the PM’s reasoning appears here as it runs.</p>
                  {:else}
                    <SessionTranscript turns={liveTurns} onViewFile={viewFileSnapshot} />
                  {/if}
                </div>
              </div>
            {/if}
          {/if}
        </div>

        <!-- Maintain panel (UI-SPEC §189) — the per-project security/dep-health/UX rollup.
             Reuses the SAME live security_finding rows the global /reports rollup reads.
             CC-3 IA — collapsed by default behind a keyboard-accessible disclosure
             (aria-expanded); the OPEN-finding count stays in the always-visible head so the
             at-a-glance signal is preserved. Nothing is removed — expanding reveals the full
             original Maintain panel (UX-inspector trigger + severity + finding rows). -->
        <section class="card maintain-card disclosure" aria-label="Maintain">
          <button
            type="button"
            class="disclosure-head maintain-head"
            aria-expanded={ovOpen.maintain}
            aria-controls="ov-maintain-body"
            aria-label={`Maintain — ${findings.length} findings open`}
            onclick={() => (ovOpen.maintain = !ovOpen.maintain)}
          >
            <span class="section-title">Maintain</span>
            <span class="disclosure-hint">
              <span class="count mono" aria-hidden="true" data-tone={findings.length > 0 ? 'warn' : ''}>{findings.length} open</span>
              <span class="chevron" data-open={ovOpen.maintain} aria-hidden="true">›</span>
            </span>
          </button>
          {#if ovOpen.maintain}
          <div id="ov-maintain-body" class="disclosure-body">
          <p class="state-body">
            Security, dependency-health and UX-inspection findings for this project — the
            per-project view of the Maintain surface. Findings appear the moment a scan writes
            them; nothing here is fabricated.
          </p>

          <!-- TASK 11.5 — the UX-inspector loop in the maintain cycle. A manual trigger
               statically inspects this project's own UI source and writes ux.* findings that
               surface here and roll up to /reports. Manual mode → button-only (D-004). -->
          <div class="maintain-actions">
            <form
              method="POST"
              action="?/uxInspect"
              use:enhance={() => {
                uxBusy = true;
                return async ({ update }) => {
                  await update({ reset: false });
                  uxBusy = false;
                };
              }}
            >
              <input type="hidden" name="trigger" value="manual" />
              <button class="btn" type="submit" disabled={uxBusy}>
                {uxBusy ? 'Inspecting UX…' : 'Run UX inspection'}
              </button>
            </form>
            <span class="ux-count mono">{uxFindingCount} UX finding{uxFindingCount === 1 ? '' : 's'}</span>
            {#if uxAutoAllowed}
              <span class="review-mode-hint">Periodic UX inspection is enabled in the current mode.</span>
            {:else}
              <span class="review-mode-hint">
                Orchestration mode is <span class="mono">manual</span> — periodic UX inspection is off.
              </span>
            {/if}
          </div>
          {#if uxFeedback}
            {#if uxFeedback.error}
              <p class="form-error" role="alert">{String(uxFeedback.error)}</p>
            {:else if uxFeedback.ok}
              <p class="form-ok">
                {String(uxFeedback.trigger)} UX inspection complete — wrote {String(uxFeedback.written)}
                finding(s).
              </p>
            {/if}
          {/if}

          {#if findings.length}
            <ul class="sev-summary" aria-label="findings by severity">
              {#each severityCounts as s (s.sev)}
                <li class="sev-chip" data-sev={s.sev} data-empty={s.n === 0}>
                  <span class="sev-n">{s.n}</span><span class="sev-label">{s.sev}</span>
                </li>
              {/each}
            </ul>
            <ul class="rows finding-list" aria-label="findings">
              {#each findings as f (f.id)}
                <li class="finding-row">
                  <span class="sev-tag" data-sev={f.severity}>{f.severity}</span>
                  <span class="family-tag mono" data-family={findingFamily(f.rule)}>{findingFamily(f.rule)}</span>
                  <span class="finding-rule mono">{f.rule}</span>
                  {#if f.file}
                    <!-- FS-3: view the cited file's DB-stored snapshot (as-of/may-be-stale). -->
                    <button
                      type="button"
                      class="finding-loc mono view-file"
                      onclick={() => viewFileSnapshot(f.file)}
                      title="View the captured snapshot of {f.file}"
                    >{f.file}{#if f.line}:{f.line}{/if}</button>
                  {:else}
                    <span class="finding-loc mono">—</span>
                  {/if}
                  {#if f.detail}<span class="finding-detail">{f.detail}</span>{/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="state-body">
              No open findings — this project is clean, or it has not been scanned yet.
            </p>
          {/if}
          </div>
          {/if}
        </section>
      </div>
    {:else if tab === 'tasks'}
      <!-- TASK 10.4 — the Tasks BOARD: kanban by status; create + move live (UI-SPEC §190). -->
      <div class="tab-body">
        <div class="card">
          <h2 class="section-title">New task</h2>
          <form
            method="POST"
            action="?/createTask"
            class="task-create-form"
            use:enhance={() => {
              taskBusy = true;
              return async ({ update }) => {
                await update({ reset: false });
                taskBusy = false;
                newTaskTitle = '';
              };
            }}
          >
            <label class="field task-title-field">
              <span class="field-label">Title</span>
              <input
                class="pm-input"
                type="text"
                name="title"
                bind:value={newTaskTitle}
                placeholder="What needs doing…"
                required
              />
            </label>
            <label class="field task-prio-field">
              <span class="field-label">Priority</span>
              <select name="priority" bind:value={newTaskPriority}>
                {#each taskPriorities as p (p)}
                  <option value={p}>{p}</option>
                {/each}
              </select>
            </label>
            <button class="btn primary" type="submit" disabled={taskBusy || !newTaskTitle.trim()}>
              {taskBusy ? 'Adding…' : 'Add task'}
            </button>
          </form>
          {#if taskFeedback}
            {#if 'error' in taskFeedback}
              <p class="form-error" role="alert">{taskFeedback.error}</p>
            {:else if taskFeedback.action === 'create'}
              <p class="form-ok">Task created: {String(taskFeedback.title)}.</p>
            {:else if taskFeedback.action === 'move'}
              <p class="form-ok">Moved task to {String(taskFeedback.to)}.</p>
            {/if}
          {/if}
        </div>

        {#if tasks.length === 0}
          <div class="card">
            <p class="state-body">No tasks yet — add the first task above and it appears on the board, live.</p>
          </div>
        {:else}
          <div class="board" aria-label="task board">
            {#each taskStatuses as col (col)}
              {@const colTasks = tasksByStatus.get(col) ?? []}
              <section class="board-col" aria-label={`${col} column`}>
                <header class="board-col-head">
                  <span class="status" data-status={col}>{col}</span>
                  <span class="count mono">{colTasks.length}</span>
                </header>
                {#if colTasks.length === 0}
                  <p class="board-empty">—</p>
                {:else}
                  <ul class="board-cards">
                    {#each colTasks as t (t.id)}
                      <li class="board-card">
                        <span class="board-card-title">{t.title}</span>
                        <div class="board-card-foot">
                          <span class="prio mono" data-prio={t.priority}>{t.priority}</span>
                          <!-- Creation age (relative; precise on hover). Honest '—' when absent (F-013). -->
                          <span class="card-when mono" title={absoluteTime(t.createdAt)}>{relativeTime(t.createdAt, now)}</span>
                          {#if t.moves.length}
                            <form
                              method="POST"
                              action="?/moveTask"
                              class="move-form"
                              use:enhance={() => {
                                taskBusy = true;
                                return async ({ update }) => {
                                  await update({ reset: false });
                                  taskBusy = false;
                                };
                              }}
                            >
                              <input type="hidden" name="taskId" value={t.id} />
                              <label class="move-label">
                                <span class="vh">Move task to…</span>
                                <select
                                  class="move-select"
                                  name="to"
                                  disabled={taskBusy}
                                  onchange={(e) => {
                                    const t2 = e.currentTarget;
                                    if (t2.value) t2.form?.requestSubmit();
                                  }}
                                >
                                  <option value="" selected>move →</option>
                                  {#each t.moves as m (m)}
                                    <option value={m}>{m}</option>
                                  {/each}
                                </select>
                              </label>
                            </form>
                          {:else}
                            <span class="terminal-tag mono">terminal</span>
                          {/if}
                        </div>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>
            {/each}
          </div>
        {/if}
      </div>
    {:else if tab === 'roadmap'}
      <!-- TASK 10.4 — hierarchical Roadmap: release → phases → features (+ sprints, orphans). -->
      <div class="tab-body">
        <div class="card">
          <h2 class="section-title">Roadmap</h2>
          {#if releases.length === 0 && phases.length === 0 && features.length === 0 && sprints.length === 0}
            <p class="state-body">No plan hierarchy yet — releases, phases and features will appear here.</p>
          {:else}
            <div class="roadmap">
              {#each roadmap.tree as node (node.release.id)}
                <details class="release-node" open>
                  <summary class="release-summary">
                    <span class="mono release-ver">{node.release.version}</span>
                    {#if node.release.title}<span class="release-title">{node.release.title}</span>{/if}
                    <span class="status" data-status={node.release.status}>{node.release.status}</span>
                    <span class="count mono">{node.phases.length}p · {node.features.length}f</span>
                  </summary>
                  <div class="release-body">
                    {#if node.phases.length}
                      <h3 class="sub">Phases</h3>
                      <ul class="tree-list">
                        {#each node.phases as ph (ph.id)}
                          <li class="tree-row">
                            <span class="tree-bullet" aria-hidden="true">▸</span>
                            <span class="row-title">{ph.name}</span>
                            <span class="status" data-status={ph.status}>{ph.status}</span>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    {#if node.features.length}
                      <h3 class="sub">Features</h3>
                      <ul class="tree-list">
                        {#each node.features as f (f.id)}
                          <li class="tree-row">
                            <span class="tree-bullet" aria-hidden="true">◦</span>
                            <span class="row-title">{f.title}</span>
                            <span class="status" data-status={f.status}>{f.status}</span>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    {#if node.phases.length === 0 && node.features.length === 0}
                      <p class="state-body">No phases or features under this release yet.</p>
                    {/if}
                  </div>
                </details>
              {/each}

              {#if roadmap.orphanPhases.length || roadmap.orphanFeatures.length}
                <details class="release-node" open>
                  <summary class="release-summary">
                    <span class="release-title">Unscheduled</span>
                    <span class="count mono"
                      >{roadmap.orphanPhases.length}p · {roadmap.orphanFeatures.length}f</span
                    >
                  </summary>
                  <div class="release-body">
                    {#if roadmap.orphanPhases.length}
                      <h3 class="sub">Phases</h3>
                      <ul class="tree-list">
                        {#each roadmap.orphanPhases as ph (ph.id)}
                          <li class="tree-row">
                            <span class="tree-bullet" aria-hidden="true">▸</span>
                            <span class="row-title">{ph.name}</span>
                            <span class="status" data-status={ph.status}>{ph.status}</span>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    {#if roadmap.orphanFeatures.length}
                      <h3 class="sub">Features</h3>
                      <ul class="tree-list">
                        {#each roadmap.orphanFeatures as f (f.id)}
                          <li class="tree-row">
                            <span class="tree-bullet" aria-hidden="true">◦</span>
                            <span class="row-title">{f.title}</span>
                            <span class="status" data-status={f.status}>{f.status}</span>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>
                </details>
              {/if}
            </div>
          {/if}
        </div>

        <div class="card">
          <h2 class="section-title">Sprints <span class="count mono">{sprints.length}</span></h2>
          {#if sprints.length === 0}
            <p class="state-body">No sprints yet — create one from the PM tab.</p>
          {:else}
            <ul class="rows" aria-label="sprints">
              {#each sprints as s (s.id)}
                <li class="row">
                  <span class="row-title">{s.name}</span>
                  <span class="status" data-status={s.status === 'completed' ? 'done' : 'active'}>
                    {s.status ?? 'active'}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    {:else if tab === 'pm'}
      <!-- TASK 9.1/16.1 — Project Manager: hired identity + the strategic layer. -->
      <div class="tab-body">
        <div class="card">
          <div class="pm-head">
            <h2 class="section-title">Project Manager</h2>
            {#if pm}
              <span class="pm-badge mono" data-on="true">hired · {pm.name}</span>
            {:else}
              <span class="pm-badge mono">not hired</span>
            {/if}
          </div>
          {#if pm}
            <p class="state-body">
              <strong>{pm.name}</strong> manages this project
              {#if pm.persona}— persona: {pm.persona}{/if}. Authority:
              <span class="mono">{pm.authority}</span> · hired {fmtTime(pm.created_at)}. The PM
              accumulates typed memory, records decisions, runs sprints, and can be consulted
              directly — every session runs under the charter below.
            </p>
            <!-- TASK 16.4 — the authority ladder (PM-SPEC §4): observe = never proposes;
                 propose = panel-approved proposals still need your gate brief; act =
                 panel approval promotes straight to ready. -->
            <form
              method="POST"
              action="?/pmAuthority"
              class="authority-form"
              use:enhance={() => {
                pmBusy = true;
                return async ({ update }) => {
                  await update({ reset: false });
                  pmBusy = false;
                };
              }}
            >
              <label class="authority-label">
                <span>Authority</span>
                <select
                  class="move-select"
                  name="authority"
                  disabled={pmBusy}
                  onchange={(e) => e.currentTarget.form?.requestSubmit()}
                >
                  {#each pmAuthorities as a (a)}
                    <option value={a} selected={a === pm.authority}>{a}</option>
                  {/each}
                </select>
              </label>
              <span class="hint">
                {pm.authority === 'act'
                  ? 'panel approval promotes proposals straight to ready'
                  : pm.authority === 'propose'
                    ? 'panel-approved proposals wait for your decision brief'
                    : 'the PM observes and records — it does not propose'}
              </span>
            </form>
          {:else}
            <p class="state-body">
              No PM has been hired for this project yet. Hiring builds the PM's founding context:
              a live project scan, a recent-history digest, and a short interview — the Six
              Forcing Questions — whose answers become founding PM memory. You write the charter
              in the same flow.
            </p>
            {#if pmBootstrapped}
              <p class="hint">
                This project carries PM memory from the earlier bootstrap flow — hiring keeps it
                and adds the identity, interview, and charter on top.
              </p>
            {/if}
            {#if !hireOpen}
              <button class="btn primary" type="button" onclick={startHire}>Hire PM</button>
            {/if}
          {/if}

          {#if !pm && hireOpen}
            <!-- TASK 16.1 — the hire interview (Six Forcing Questions, one at a time). -->
            <div class="hire-wizard" role="group" aria-label="Hire PM interview">
              {#if hirePreAnswered.length > 0}
                <div class="hire-preanswered">
                  <p class="hint">
                    Pre-answered by the project scan (smart-skip — evidence quoted, not asked):
                  </p>
                  <ul class="rows">
                    {#each hirePreAnswered as q (q.id)}
                      <li class="hire-pre-row">
                        <span class="pm-kind-tag mono">{q.label}</span>
                        <span class="hire-pre-evidence">
                          <span class="mono">{q.preAnswered?.source}</span>: “{q.preAnswered?.evidence}”
                        </span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              {#if hirePhase === 'questions' && hireCurrent}
                <div class="hire-question">
                  <p class="hire-progress mono" aria-live="polite">
                    Question {hireStep + 1} of {hireAskable.length} · {hireCurrent.label}
                  </p>
                  <p class="hire-question-text">{hireCurrent.question}</p>
                  <label class="field">
                    <span class="field-label">Your answer (recorded in your words)</span>
                    <textarea
                      class="pm-input"
                      rows="3"
                      bind:value={hireAnswerDraft}
                      placeholder="Answer, or leave empty and skip — a skip is recorded as an honest gap."
                    ></textarea>
                  </label>
                  {#if hirePushOpen}
                    <p class="hire-push-text">{hireCurrent.push}</p>
                    <label class="field">
                      <span class="field-label">Follow-up (optional)</span>
                      <textarea
                        class="pm-input"
                        rows="2"
                        bind:value={hirePushDraft}
                        placeholder="Sharpen the answer — or continue without."
                      ></textarea>
                    </label>
                  {/if}
                  <div class="hire-actions">
                    <button
                      class="btn primary"
                      type="button"
                      onclick={hireContinue}
                      disabled={!hirePushOpen && !hireAnswerDraft.trim()}
                    >
                      {hirePushOpen ? 'Record answer & continue' : 'Continue'}
                    </button>
                    {#if !hirePushOpen}
                      <button class="btn" type="button" onclick={hireSkipCurrent}>Skip question</button>
                    {/if}
                    <button class="btn" type="button" onclick={hireSkipRest}>
                      Skip the rest → charter
                    </button>
                  </div>
                </div>
              {:else if hirePhase === 'charter'}
                <div class="hire-charter">
                  <p class="hire-progress mono">
                    Interview done — {hireAnswered} answered, {hireSkipped} skipped
                    {hireSkipped > 0 ? '(recorded as honest gaps)' : ''}.
                  </p>
                  <form
                    method="POST"
                    action="?/pmHire"
                    use:enhance={() => {
                      pmBusy = true;
                      return async ({ update }) => {
                        await update({ reset: false });
                        pmBusy = false;
                        hireOpen = false;
                      };
                    }}
                  >
                    <input type="hidden" name="answers" value={hireAnswersJson} />
                    <label class="field">
                      <span class="field-label">PM name</span>
                      <input
                        class="pm-input"
                        type="text"
                        name="name"
                        bind:value={hireName}
                        placeholder="e.g. Vesper"
                        required
                      />
                    </label>
                    <label class="field">
                      <span class="field-label">Persona (optional)</span>
                      <input
                        class="pm-input"
                        type="text"
                        name="persona"
                        bind:value={hirePersona}
                        placeholder="e.g. blunt, evidence-first, allergic to scope creep"
                      />
                    </label>
                    <label class="field">
                      <span class="field-label">Charter — your directives (priorities, tone, escalation rules)</span>
                      <textarea
                        class="pm-input"
                        rows="5"
                        name="charter"
                        bind:value={hireCharter}
                        placeholder="Injected into every PM session and review as fenced context. Editable any time."
                      ></textarea>
                    </label>
                    <div class="hire-actions">
                      <button class="btn primary" type="submit" disabled={pmBusy || !hireName.trim()}>
                        {pmBusy ? 'Hiring…' : 'Hire PM'}
                      </button>
                      <button class="btn" type="button" onclick={() => (hireOpen = false)}>Cancel</button>
                    </div>
                  </form>
                </div>
              {/if}
            </div>
          {/if}

          {#if pmFeedback}
            {#if 'error' in pmFeedback}
              <p class="form-error" role="alert">{pmFeedback.error}</p>
            {:else if pmFeedback.action === 'hire'}
              <p class="form-ok">
                {pmFeedback.alreadyHired
                  ? `PM already hired — absorbed; wrote ${pmFeedback.seeded} missing founding memory(ies).`
                  : `${String(pmFeedback.pmName)} hired — ${pmFeedback.seeded} founding memory(ies) from the live scan + interview.`}
              </p>
            {:else if pmFeedback.action === 'charter'}
              <p class="form-ok">
                {pmFeedback.cleared ? 'Charter cleared.' : 'Charter saved — it now rides every PM session and review.'}
              </p>
            {:else if pmFeedback.action === 'memory'}
              <p class="form-ok">Recorded a {String(pmFeedback.kind)} memory.</p>
            {:else if pmFeedback.action === 'decision'}
              <p class="form-ok">Recorded decision: {String(pmFeedback.title)}.</p>
            {:else if pmFeedback.action === 'sprint-create'}
              <p class="form-ok">Sprint created.</p>
            {:else if pmFeedback.action === 'sprint-complete'}
              <p class="form-ok">Sprint completed.</p>
            {:else if pmFeedback.action === 'chat'}
              <p class="form-ok">
                PM session {shortId(String(pmFeedback.sessionId))} started · {String(pmFeedback.status)}
                · {String(pmFeedback.model)} ({String(pmFeedback.routeMethod)} route).
                <button class="link-inline" type="button" onclick={() => openSession(String(pmFeedback.sessionId))}
                  >open transcript →</button
                >
              </p>
            {:else if pmFeedback.action === 'review'}
              <p class="form-ok">
                {String(pmFeedback.trigger)} review complete — wrote {String(pmFeedback.written)}
                memory entry(ies){#if typeof pmFeedback.proposed === 'number' && pmFeedback.proposed > 0},
                  proposed {String(pmFeedback.proposed)} task(s) (see Proposals below){/if}.
              </p>
            {:else if pmFeedback.action === 'authority'}
              <p class="form-ok">PM authority set to {String(pmFeedback.authority)}.</p>
            {:else if pmFeedback.action === 'panel'}
              <p class="form-ok">
                Panel done — {String(pmFeedback.verdicts)} verdict(s), decision:
                {String(pmFeedback.decision)}; task is {String(pmFeedback.taskStatus)}{#if pmFeedback.briefId}{' '}—
                  a decision brief is waiting in the notifications tray{/if}.
              </p>
            {:else if pmFeedback.action === 'revise'}
              <p class="form-ok">
                Revision submitted as a new proposal ({String(pmFeedback.successorId)});
                {String(pmFeedback.verdictsClosed)} verdict(s) closed as revised.
              </p>
            {:else if pmFeedback.action === 'withdraw'}
              <p class="form-ok">
                Proposal withdrawn; {String(pmFeedback.verdictsClosed)} verdict(s) closed.
              </p>
            {/if}
          {/if}
        </div>

        {#if pm}
          <!-- Charter (TASK 16.1) — operator directives; D-010 diff+confirm on edit. -->
          <div class="card">
            <div class="pm-head">
              <h2 class="section-title">Charter</h2>
              {#if !charterEditing}
                <button class="btn" type="button" onclick={startCharterEdit}>Edit charter</button>
              {/if}
            </div>
            <p class="state-body">
              Your durable directives — priorities, tone, escalation rules. Injected into every
              PM session and review as fenced reference context (never instructions).
            </p>
            {#if charterEditing}
              <label class="field">
                <span class="field-label">Charter</span>
                <textarea class="pm-input" rows="6" bind:value={charterDraft}></textarea>
              </label>
              <div class="hire-actions">
                <button class="btn primary" type="button" disabled={pmBusy} onclick={() => void reviewAndSaveCharter()}>
                  Review changes & save
                </button>
                <button class="btn" type="button" onclick={() => (charterEditing = false)}>Cancel</button>
              </div>
              <form
                method="POST"
                action="?/pmCharter"
                bind:this={charterFormEl}
                class="charter-form-hidden"
                use:enhance={() => {
                  pmBusy = true;
                  return async ({ update }) => {
                    await update({ reset: false });
                    pmBusy = false;
                    charterEditing = false;
                  };
                }}
              >
                <input type="hidden" name="charter" value={charterDraft.trim()} />
              </form>
            {:else if pm.charter}
              <pre class="charter-text">{pm.charter}</pre>
            {:else}
              <p class="state-body">— no charter written yet. The PM runs without operator directives until you write one.</p>
            {/if}
          </div>
        {/if}

        {#if pm}
          <!-- TASK 16.4 — proposals queue (PM-SPEC §4 "Act with Purpose"): tasks the PM
               proposed, each carrying the schema-enforced objective / purpose / spec /
               provenance, traversing the 1–2 validator panel before becoming ready. -->
          <div class="card" id="proposals-queue">
            <div class="pm-head">
              <h2 class="section-title">
                Proposals
                {#if proposals.length > 0}<span class="count mono">{proposals.length}</span>{/if}
              </h2>
            </div>
            <p class="state-body">
              PM-created tasks are born <span class="mono">proposed</span> — nothing is actionable
              until an independent validation panel approves it (purpose · spec · duplication ·
              feasibility, judged against plan + charter).
            </p>
            {#if proposals.length === 0}
              <p class="state-body">
                No open proposals — the PM proposes from real review signals (blocked work,
                failed releases, severe findings).
              </p>
            {:else}
              <ul class="rows proposal-list" aria-label="open proposals">
                {#each proposals as entry (entry.task.id)}
                  <li class="proposal">
                    <div class="proposal-head">
                      <span class="row-title">{entry.task.title}</span>
                      <span class="status" data-status={entry.task.status}>{entry.task.status}</span>
                    </div>
                    <dl class="proposal-fields">
                      <dt>objective</dt>
                      <dd>{entry.task.objective ?? '—'}</dd>
                      <dt>purpose</dt>
                      <dd>{entry.task.purpose ?? '—'}</dd>
                      <dt>acceptance criteria</dt>
                      <dd>
                        {#if entry.task.acceptance_criteria?.length}
                          <ol class="criteria-list">
                            {#each entry.task.acceptance_criteria as c, i (i)}
                              <li>{c}</li>
                            {/each}
                          </ol>
                        {:else}
                          —
                        {/if}
                      </dd>
                      <dt>provenance</dt>
                      <dd>
                        {#if entry.task.provenance}
                          <span class="mono">{entry.task.provenance.kind}</span>
                          — {entry.task.provenance.evidence.join(', ')}
                        {:else}
                          —
                        {/if}
                      </dd>
                    </dl>

                    {#if entry.verdicts.length > 0}
                      <div class="verdicts" aria-label="panel verdicts">
                        {#each entry.verdicts as v (v.id)}
                          <details class="verdict">
                            <summary class="verdict-summary">
                              <span class="status" data-status={v.verdict === 'approve' ? 'done' : 'blocked'}>
                                {v.verdict}
                              </span>
                              <span class="mono verdict-meta">
                                {v.validator_kind}
                                {#if v.classification}· {v.classification}{/if}
                                {#if v.confidence}· {v.confidence}{/if}
                                {#if v.outcome}· closed: {v.outcome}{/if}
                              </span>
                            </summary>
                            <ul class="verdict-reasons">
                              {#each v.reasons as r, i (i)}
                                <li>{r}</li>
                              {/each}
                            </ul>
                            <!-- TASK 16.7b — panel-composition rationale (WORKFORCE-SPEC §8):
                                 inline validators are the honest degraded mode — no certified
                                 catalog role fit this artifact yet, so the panel was composed
                                 by role fit alone (track records are empty). A catalog_role
                                 verdict instead names the certified role that sat. -->
                            <p class="verdict-rationale">
                              {#if v.validator_kind === 'inline'}
                                composed by role fit alone — no certified role yet, track records empty
                              {:else if v.validator_kind === 'catalog_role'}
                                validated by a certified catalog role{#if v.role}
                                  <span class="mono">({bareId(v.role)})</span>{/if}
                              {/if}
                            </p>
                          </details>
                        {/each}
                      </div>
                    {:else}
                      <p class="hint">No panel verdicts yet — run the validation panel.</p>
                    {/if}

                    {#if entry.openBrief}
                      <p class="hint brief-open-hint">
                        A decision brief is open on this proposal — answer it in the
                        notifications tray (the matter does not proceed while it is open).
                      </p>
                    {/if}

                    <div class="proposal-actions">
                      <form
                        method="POST"
                        action="?/pmPanel"
                        use:enhance={() => {
                          pmBusy = true;
                          return async ({ update }) => {
                            await update({ reset: false });
                            pmBusy = false;
                          };
                        }}
                      >
                        <input type="hidden" name="taskId" value={entry.task.id} />
                        <input type="hidden" name="validators" value="1" />
                        <button class="btn primary" type="submit" disabled={pmBusy || !!entry.openBrief}>
                          {pmBusy ? 'Panel running…' : 'Run validation panel'}
                        </button>
                      </form>
                      <button class="btn" type="button" onclick={() => startRevise(entry)}>
                        Revise
                      </button>
                      <form
                        method="POST"
                        action="?/pmWithdraw"
                        use:enhance={() => {
                          pmBusy = true;
                          return async ({ update }) => {
                            await update({ reset: false });
                            pmBusy = false;
                          };
                        }}
                      >
                        <input type="hidden" name="taskId" value={entry.task.id} />
                        <button class="btn" type="submit" disabled={pmBusy}>Withdraw</button>
                      </form>
                    </div>

                    {#if reviseOpenFor === entry.task.id}
                      <form
                        method="POST"
                        action="?/pmRevise"
                        class="revise-form"
                        use:enhance={() => {
                          pmBusy = true;
                          return async ({ update }) => {
                            await update({ reset: false });
                            pmBusy = false;
                            reviseOpenFor = null;
                          };
                        }}
                      >
                        <input type="hidden" name="taskId" value={entry.task.id} />
                        <label class="field">
                          <span class="field-label">Title</span>
                          <input class="pm-input" type="text" name="title" bind:value={reviseTitle} />
                        </label>
                        <label class="field">
                          <span class="field-label">Objective</span>
                          <textarea class="pm-input" rows="2" name="objective" bind:value={reviseObjective}
                          ></textarea>
                        </label>
                        <label class="field">
                          <span class="field-label">Purpose</span>
                          <textarea class="pm-input" rows="2" name="purpose" bind:value={revisePurpose}
                          ></textarea>
                        </label>
                        <label class="field">
                          <span class="field-label">Acceptance criteria (one per line)</span>
                          <textarea class="pm-input" rows="4" name="criteria" bind:value={reviseCriteria}
                          ></textarea>
                        </label>
                        <div class="hire-actions">
                          <button class="btn primary" type="submit" disabled={pmBusy}>
                            Submit revision (new proposal)
                          </button>
                          <button class="btn" type="button" onclick={() => (reviseOpenFor = null)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}

        <!-- PM→HR dispatch (gap A) — capability HIRE-gaps: defect classes NO catalog role proves.
             Each gets a DISPATCH affordance that enqueues a hire_request (PROPOSE-ONLY: the recruiter
             DRAFTS a cert key-set; the operator approves it later — nothing is spent here, B2). -->
        <div class="card">
          <div class="pm-head">
            <h2 class="section-title">
              Hiring gaps
              {#if staffingGaps.length > 0}<span class="count mono">{staffingGaps.length}</span>{/if}
            </h2>
          </div>
          {#if staffingGaps.length === 0}
            <p class="state-body">
              No hiring gaps — every declared capability need is proven by an existing role (or the
              project has declared no defect-class needs yet). Gaps appear when a needed defect class
              has no role that has passed a gauntlet keying it.
            </p>
          {:else}
            <p class="state-body">
              These defect classes have <strong>no catalog role</strong> that proves them. Dispatching
              a gap asks the recruiter to <strong>draft</strong> a certification key-set for the role
              you name — <span class="mono">propose-only</span>: nothing runs and no spend happens
              until you approve the key-set (the recruiter never self-certifies, never auto-runs the
              gauntlet, never confirms a key).
            </p>
            {#if proposedDefectClasses.length > 0}
              <p class="hint">
                Captured hire signals (not yet matchable):
                {#each proposedDefectClasses as pc (pc)}<span class="mono chip">{pc}</span>{/each}
              </p>
            {/if}
            <ul class="rows gap-list" aria-label="capability hiring gaps">
              {#each staffingGaps as gap (gap.defectClass)}
                <li class="gap">
                  <div class="gap-head">
                    <span class="row-title mono">{gap.defectClass}</span>
                    <span class="status" data-status="hire">hire</span>
                  </div>
                  <p class="gap-evidence">{gap.evidence}</p>
                  <form
                    method="POST"
                    action="?/dispatchHire"
                    class="gap-form"
                    use:enhance={() => {
                      hireBusy = true;
                      return async ({ update }) => {
                        await update({ reset: false });
                        hireBusy = false;
                      };
                    }}
                  >
                    <input type="hidden" name="defectClass" value={gap.defectClass} />
                    <label class="field gap-role">
                      <span class="field-label">Role to hire (slug)</span>
                      <input
                        class="pm-input"
                        type="text"
                        name="roleSlug"
                        placeholder="e.g. security-reviewer"
                        bind:value={hireRoleSlug[gap.defectClass]}
                        disabled={hireBusy}
                      />
                    </label>
                    <button
                      class="btn primary"
                      type="submit"
                      disabled={hireBusy || !(hireRoleSlug[gap.defectClass] ?? '').trim()}
                    >
                      {hireBusy ? 'Dispatching…' : 'Dispatch hire request'}
                    </button>
                  </form>
                  {#if hireForm && hireForm.roleSlug === (hireRoleSlug[gap.defectClass] ?? '').trim()}
                    {#if hireForm.ok}
                      <p class="gap-result ok" role="status">
                        {hireForm.enqueued
                          ? `Dispatched — the recruiter will draft a cert key-set for '${hireForm.roleSlug}' (awaiting your key-set approval).`
                          : `Already dispatched — an open hire request for '${hireForm.roleSlug}' exists (no double-enqueue).`}
                      </p>
                    {:else if hireForm.error}
                      <p class="gap-result err" role="alert">{hireForm.error}</p>
                    {/if}
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <!-- Gap D - PM FIT-VERDICT on open cert_hire hire gates. After HR raises a hire brief
             (the candidate passed the OBJECTIVE gauntlet) and BEFORE the operator's B4 decision,
             the project PM judges FIT for THIS project. FIRST-CLASS PM input, not a hard gate: a
             DENY pre-sets the operator surface to reject with the reason shown, but the operator
             can OVERRIDE (D-039 final). Recording a fit-verdict NEVER flips the cert or staffs. -->
        <div class="card">
          <div class="pm-head">
            <h2 class="section-title">
              Hire gates - PM fit-verdict
              {#if hireGates.length > 0}<span class="count mono">{hireGates.length}</span>{/if}
            </h2>
          </div>
          {#if hireGates.length === 0}
            <p class="state-body">
              No open hire gates. When the recruiter finishes a candidate's certification gauntlet,
              its hire brief appears here for the PM to judge <strong>fit for this project</strong>
              before the operator's final hire decision on the <a class="inline-link" href="/agents">workforce board</a>.
            </p>
          {:else}
            <p class="state-body">
              The recruiter certified these candidates against an <strong>objective</strong> gauntlet.
              The PM judges <strong>fit for this project</strong> (context the gauntlet lacks - e.g. a
              generic cert vs the project's specific stack). A <span class="mono">deny</span> pre-sets
              the operator's hire decision to reject with your reason shown; the operator can still
              override (D-039 final). Your verdict records a judgment - it never certifies or staffs.
            </p>
            <ul class="rows fit-list" aria-label="open hire gates">
              {#each hireGates as h (h.brief)}
                <li class="fit-gate" data-rec={h.recommendation}>
                  <div class="fit-head">
                    <span class="status" data-status={h.recommendation === 'hire' ? 'pass' : 'fail'}>
                      recruiter recommends {h.recommendation === 'hire' ? 'HIRE' : 'NO HIRE'}
                    </span>
                    <span class="ref mono" title={h.run}>run {refTail(h.run)}</span>
                  </div>
                  <p class="fit-ask">{h.ask}</p>
                  <p class="fit-falsifier"><span class="brief-k">falsifier</span> {h.falsifier}</p>
                  {#if h.fitVerdict}
                    <p class="fit-current" data-outcome={h.fitVerdict.outcome} role="status">
                      <span class="fit-badge" data-outcome={h.fitVerdict.outcome}>
                        PM fit: {h.fitVerdict.outcome === 'approve' ? 'APPROVE' : 'DENY'}
                      </span>
                      <span class="fit-reason">{h.fitVerdict.reason}</span>
                    </p>
                  {:else}
                    <p class="hint">No PM fit-verdict yet - record one below.</p>
                  {/if}
                  <form
                    method="POST"
                    action="?/pmFitVerdict"
                    class="fit-form"
                    use:enhance={() => {
                      fitBusy = { ...fitBusy, [h.brief]: true };
                      return async ({ update }) => {
                        await update({ reset: false });
                        fitBusy = { ...fitBusy, [h.brief]: false };
                      };
                    }}
                  >
                    <input type="hidden" name="brief" value={h.brief} />
                    <label class="field">
                      <span class="field-label">Fit reason (the operator sees this)</span>
                      <textarea
                        class="pm-input"
                        name="reason"
                        rows="2"
                        placeholder="e.g. generic C# cert, but this project needs BepInEx/Unity specifics the gauntlet did not test"
                        bind:value={fitReason[h.brief]}
                        disabled={fitBusy[h.brief]}
                      ></textarea>
                    </label>
                    <div class="fit-actions">
                      <button
                        class="btn primary"
                        type="submit"
                        name="outcome"
                        value="approve"
                        disabled={fitBusy[h.brief] || !(fitReason[h.brief] ?? '').trim()}
                      >
                        {fitBusy[h.brief] ? 'Recording...' : 'Fit - approve'}
                      </button>
                      <button
                        class="btn"
                        type="submit"
                        name="outcome"
                        value="deny"
                        disabled={fitBusy[h.brief] || !(fitReason[h.brief] ?? '').trim()}
                      >
                        {fitBusy[h.brief] ? 'Recording...' : 'Not a fit - deny'}
                      </button>
                    </div>
                  </form>
                  {#if fitForm && fitForm.brief === h.brief}
                    {#if fitForm.ok}
                      <p class="fit-result ok" role="status">
                        Fit-verdict recorded - {String(fitForm.outcome) === 'approve' ? 'APPROVE' : 'DENY'}. The operator's hire surface now shows it{String(fitForm.outcome) === 'deny' ? ' and defaults to reject' : ''}.
                      </p>
                    {:else if fitForm.error}
                      <p class="fit-result err" role="alert">{String(fitForm.error)}</p>
                    {/if}
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <!-- PM periodic review (TASK 11.4) -------------------------------------- -->
        <div class="card">
          <div class="pm-head">
            <h2 class="section-title">
              Periodic review
              {#if pmReviews.length > 0}<span class="count mono">{pmReviews.length}</span>{/if}
            </h2>
          </div>
          <p class="state-body">
            A review pass examines this project's live activity (tasks, findings, open risks) and
            writes typed PM memory + a summary. Manual mode → button-triggered only (D-004);
            periodic mode lets the orchestrator run it on schedule.
          </p>
          <div class="review-actions">
            <form
              method="POST"
              action="?/pmReview"
              use:enhance={() => {
                pmBusy = true;
                return async ({ update }) => {
                  await update({ reset: false });
                  pmBusy = false;
                };
              }}
            >
              <input type="hidden" name="trigger" value="manual" />
              <button class="btn primary" type="submit" disabled={pmBusy || !pmBootstrapped}>
                {pmBusy ? 'Reviewing…' : 'Run review now'}
              </button>
            </form>
            {#if !pmAutoReviewAllowed}
              <span class="review-mode-hint">
                Orchestration mode is <span class="mono">manual</span> — periodic reviews are off.
              </span>
            {:else}
              <span class="review-mode-hint">Periodic reviews are enabled in the current mode.</span>
            {/if}
          </div>
          {#if !pmBootstrapped}
            <p class="hint">Hire the PM first to enable reviews.</p>
          {/if}

          <!-- TASK 16.2 (PM-SPEC §3): the periodic schedule — per-project cron cadence +
               stagger offset on the pm row; the trigger engine fires reviews from these.
               Reachable only with a hired PM (no PM → no schedule to edit). -->
          {#if pm}
            <form
              method="POST"
              action="?/pmSchedule"
              class="schedule-form"
              use:enhance={() => {
                pmBusy = true;
                return async ({ update }) => {
                  await update({ reset: false });
                  pmBusy = false;
                };
              }}
            >
              <label class="schedule-field">
                <span>Cadence (cron)</span>
                <input
                  class="pm-input mono"
                  type="text"
                  name="cadence"
                  value={pm.cadence ?? ''}
                  placeholder="0 9 * * 1-5"
                  aria-describedby="schedule-hint"
                />
              </label>
              <label class="schedule-field">
                <span>Offset (stagger)</span>
                <input
                  class="pm-input mono"
                  type="text"
                  name="cadenceOffset"
                  value={pm.cadence_offset ?? ''}
                  placeholder="5m"
                  aria-describedby="schedule-hint"
                />
              </label>
              <button class="btn" type="submit" disabled={pmBusy}>Save schedule</button>
            </form>
            <p class="hint" id="schedule-hint">
              {#if pm.cadence}
                Periodic cadence <span class="mono">{pm.cadence}</span>
                {#if pm.cadence_offset}&nbsp;staggered by <span class="mono">{pm.cadence_offset}</span>{/if}
                — fires only when the orchestration mode permits automatic reviews (D-004).
              {:else}
                No cadence set — periodic reviews are off for this project. Empty fields clear.
              {/if}
            </p>
          {/if}

          {#if pmReviews.length === 0}
            <p class="state-body">No review passes yet — run one to capture the first snapshot.</p>
          {:else}
            <ul class="rows review-list" aria-label="PM review history">
              {#each pmReviews as r (r.id)}
                <li class="review-row">
                  <div class="review-row-head">
                    <span class="review-trigger mono" data-trigger={r.trigger}>{r.trigger}</span>
                    <span class="review-when mono">{fmtTime(r.created_at)}</span>
                  </div>
                  <p class="review-summary">{r.summary}</p>
                  <div class="review-counts mono">
                    <span>{r.tasks_examined} tasks</span>
                    <span>{r.findings_examined} findings</span>
                    <span>{r.risks_open} risks</span>
                    <span>{r.memories_written} written</span>
                  </div>
                  <!-- TASK 16.2: trigger provenance — what woke the PM + the real evidence
                       (PM-SPEC §3). Absent on manual/pre-16.2 rows (honest absence). -->
                  {#if r.provenance}
                    <div class="review-prov mono" data-kind={r.provenance.kind}>
                      <span class="review-prov-kind">woke on {r.provenance.kind}</span>
                      <span>
                        {r.provenance.evidence.length} evidence
                        {r.provenance.evidence.length === 1 ? 'row' : 'rows'}
                        · authority {r.provenance.authority ?? '—'}
                      </span>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <!-- Typed PM memory ------------------------------------------------------ -->
        <div class="card">
          <h2 class="section-title">
            PM memory
            {#if pmStats}<span class="count mono">{pmStats.total}</span>{/if}
          </h2>
          {#if pmStats && pmStats.total > 0}
            <div class="pm-kind-stats" aria-label="memory by kind">
              {#each pmKinds as k (k)}
                <span class="pm-kind-stat" data-kind={k}>
                  <span class="pm-kind-name">{memoryKindLabel(k)}</span>
                  <span class="pm-kind-count mono">{pmStats[k] ?? 0}</span>
                </span>
              {/each}
            </div>
          {/if}

          <form
            method="POST"
            action="?/pmAddMemory"
            class="pm-form"
            use:enhance={() => {
              pmBusy = true;
              return async ({ update }) => {
                await update({ reset: false });
                pmBusy = false;
                newMemoryContent = '';
              };
            }}
          >
            <div class="pm-form-row">
              <label class="field pm-kind-field">
                <span class="field-label">Kind</span>
                <select name="kind" bind:value={newMemoryKind}>
                  {#each pmKinds as k (k)}
                    <option value={k}>{memoryKindLabel(k)}</option>
                  {/each}
                </select>
              </label>
              <label class="field pm-content-field">
                <span class="field-label">Memory</span>
                <input
                  class="pm-input mono"
                  type="text"
                  name="content"
                  bind:value={newMemoryContent}
                  placeholder="An observation, learning, risk, pattern or decision…"
                  required
                />
              </label>
              <button class="btn" type="submit" disabled={pmBusy || !newMemoryContent.trim()}>Record</button>
            </div>
          </form>

          {#if pmMemory.length === 0}
            <p class="state-body">
              No PM memory yet — bootstrap the PM or record the first observation above.
            </p>
          {:else}
            <ul class="rows pm-memory" aria-label="pm memory">
              {#each pmMemory as m (m.id)}
                <li class="row pm-memory-row">
                  <span class="pm-kind-tag mono" data-kind={m.kind}>{m.kind}</span>
                  <span class="row-title pm-memory-content">{m.content}</span>
                  <span class="pm-source mono">{m.source}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <!-- Decisions ------------------------------------------------------------ -->
        <div class="card">
          <h2 class="section-title">Decisions <span class="count mono">{decisions.length}</span></h2>
          <form
            method="POST"
            action="?/pmAddDecision"
            class="pm-form"
            use:enhance={() => {
              pmBusy = true;
              return async ({ update }) => {
                await update({ reset: false });
                pmBusy = false;
                newDecisionTitle = '';
                newDecisionContext = '';
                newDecisionRationale = '';
              };
            }}
          >
            <label class="field">
              <span class="field-label">Decision</span>
              <input
                class="pm-input"
                type="text"
                name="title"
                bind:value={newDecisionTitle}
                placeholder="The decision (e.g. Use SurrealDB for PM memory)"
                required
              />
            </label>
            <div class="pm-form-row">
              <label class="field pm-content-field">
                <span class="field-label">Context</span>
                <input
                  class="pm-input"
                  type="text"
                  name="context"
                  bind:value={newDecisionContext}
                  placeholder="Why this came up (optional)"
                />
              </label>
              <label class="field pm-content-field">
                <span class="field-label">Rationale</span>
                <input
                  class="pm-input"
                  type="text"
                  name="rationale"
                  bind:value={newDecisionRationale}
                  placeholder="Why this choice (optional)"
                />
              </label>
              <button class="btn" type="submit" disabled={pmBusy || !newDecisionTitle.trim()}>Record</button>
            </div>
          </form>

          {#if decisions.length === 0}
            <p class="state-body">No decisions recorded yet.</p>
          {:else}
            <ul class="rows pm-decisions" aria-label="decisions">
              {#each decisions as d (d.id)}
                <li class="pm-decision">
                  <div class="pm-decision-head">
                    <span class="row-title pm-decision-title">{d.title}</span>
                    <span class="status" data-status={d.status}>{d.status}</span>
                  </div>
                  {#if d.context}<p class="pm-decision-line"><span class="pm-decision-lbl">Context</span> {d.context}</p>{/if}
                  {#if d.rationale}<p class="pm-decision-line"><span class="pm-decision-lbl">Rationale</span> {d.rationale}</p>{/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <!-- Sprints -------------------------------------------------------------- -->
        <div class="card">
          <h2 class="section-title">Sprints <span class="count mono">{sprints.length}</span></h2>
          <form
            method="POST"
            action="?/pmCreateSprint"
            class="pm-form"
            use:enhance={() => {
              pmBusy = true;
              return async ({ update }) => {
                await update({ reset: false });
                pmBusy = false;
                newSprintName = '';
              };
            }}
          >
            <div class="pm-form-row">
              <label class="field pm-content-field">
                <span class="field-label">New sprint</span>
                <input
                  class="pm-input"
                  type="text"
                  name="name"
                  bind:value={newSprintName}
                  placeholder="Sprint name (e.g. v0.2 — PM core)"
                  required
                />
              </label>
              <button class="btn" type="submit" disabled={pmBusy || !newSprintName.trim()}>Create sprint</button>
            </div>
          </form>

          {#if sprints.length === 0}
            <p class="state-body">No sprints yet.</p>
          {:else}
            <ul class="rows" aria-label="sprints">
              {#each sprints as s (s.id)}
                <li class="row pm-sprint-row">
                  <span class="row-title">{s.name}</span>
                  <span class="status" data-status={s.status === 'completed' ? 'done' : 'active'}>
                    {s.status ?? 'active'}
                  </span>
                  {#if s.status !== 'completed'}
                    <form
                      method="POST"
                      action="?/pmCompleteSprint"
                      use:enhance={() => {
                        pmBusy = true;
                        return async ({ update }) => {
                          await update({ reset: false });
                          pmBusy = false;
                        };
                      }}
                    >
                      <input type="hidden" name="sprintId" value={s.id} />
                      <button class="open-btn" type="submit" disabled={pmBusy}>complete</button>
                    </form>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <!-- Talk to the PM ------------------------------------------------------- -->
        <div class="card">
          <h2 class="section-title">Talk to the PM</h2>
          <p class="state-body">
            Drive a real Claude Code PM session seeded with this project's charter + plan + PM
            memory, on the configured PM model (config/workforce.yaml). The reply streams in the
            Sessions tab.
          </p>
          {#if !pm}
            <p class="hint">Hire the PM first — the chat speaks as your hired PM, under its charter.</p>
          {/if}
          <form
            method="POST"
            action="?/pmChat"
            class="pm-chat-form"
            use:enhance={() => {
              pmBusy = true;
              return async ({ update }) => {
                await update({ reset: false });
                pmBusy = false;
                pmChatMessage = '';
              };
            }}
          >
            <label class="field pm-content-field">
              <span class="field-label">Message</span>
              <input
                class="pm-input"
                type="text"
                name="message"
                bind:value={pmChatMessage}
                placeholder="Ask the PM about strategy, risks, the roadmap…"
                required
              />
            </label>
            <button class="btn primary" type="submit" disabled={pmBusy || !pm || !pmChatMessage.trim()}>
              {pmBusy ? 'Sending…' : 'Send to PM'}
            </button>
          </form>
        </div>
      </div>
    {:else if tab === 'sessions'}
      <div class="tab-body">
        <!-- Job 8: launch a Claude Code session against a task (PRODUCT §4.8). -->
        <div class="card">
          <h2 class="section-title">Launch a session</h2>
          <p class="state-body">
            Spawn a Claude Code session against a task — its transcript streams live below.
          </p>
          {#if tasks.length === 0}
            <p class="state-body">No tasks yet — create a task to launch a session against it.</p>
          {:else}
            <form
              method="POST"
              action="?/launch"
              class="launch-form"
              use:enhance={() => {
                launching = true;
                return async ({ update }) => {
                  await update({ reset: false });
                  launching = false;
                };
              }}
            >
              <label class="field">
                <span class="field-label">Task</span>
                <select name="taskId" bind:value={launchTaskId} required>
                  <option value="" disabled>Select a task…</option>
                  {#each tasks as t (t.id)}
                    <option value={t.id}>{t.title} · {t.status}</option>
                  {/each}
                </select>
              </label>
              <button class="btn primary" type="submit" disabled={launching || !launchTaskId}>
                {launching ? 'Launching…' : 'Launch session'}
              </button>
            </form>
            {#if form?.launch && 'error' in form.launch}
              <p class="form-error" role="alert">{form.launch.error}</p>
            {:else if form?.launch && 'ok' in form.launch}
              <p class="form-ok">Session {shortId(form.launch.sessionId)} launched · {form.launch.status}</p>
            {/if}
          {/if}
        </div>

        <div class="card">
          <h2 class="section-title">Claude Code sessions <span class="count mono">{sessions.length}</span></h2>
          {#if sessions.length === 0}
            <p class="state-body">No sessions yet — start a run and it will appear here, live.</p>
          {:else}
            <ul class="rows" aria-label="sessions">
              {#each sessions as s (s.id)}
                <li class="row session" data-selected={selectedSession === s.id}>
                  <span class="mono sid">{shortId(s.id)}</span>
                  <span class="status" data-status={s.status}>{s.status}</span>
                  <span class="model mono">{s.provider}/{s.modelId}</span>
                  <!-- START (relative; precise on hover) + ELAPSED (live while running, final once
                       terminal). Honest '—' when started_at is absent (F-013). -->
                  <span class="when mono" title={absoluteTime(s.startedAt)}>{relativeTime(s.startedAt, now)}</span>
                  <span class="elapsed mono" class:live={s.status === 'running'} title={s.status === 'running' ? 'elapsed (live)' : 'elapsed'}>{elapsed(s.startedAt, s.endedAt, now)}</span>
                  <button class="open-btn" type="button" onclick={() => openSession(s.id)}>open</button>
                  <!-- OBSERVABILITY — a failed session explains itself right in the list (the
                       screened session.note, or honest "no reason recorded"). Full-row span so
                       the reason wraps under the meta line. -->
                  <SessionFailureReason status={s.status} note={s.note} variant="row" />
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <!-- GAME-VERIFY GV-4 — the live game-mod verification surface (operator visibility; spec
             §"Orchestrator integration"). Shown only for a project that DECLARES a game_verify
             harness (opt-in); the verdict is read from the persisted agent_event (GV-3) and is
             DISPLAY-ONLY — its log tail / stack traces were screened by the runner (D-026). Honest
             states (F-008): configured-but-never-run → "not yet run"; not configured → nothing. -->
        {#if gameVerifyConfigured}
          <div class="card">
            <h2 class="section-title">
              Game verification <span class="count mono">{gameVerify.length}</span>
            </h2>
            <p class="state-body">
              This project verifies its built mod by running the game — the latest verdict(s) appear
              here the moment a run completes (deploy → launch → poll log → kill → verdict).
            </p>
            {#if gameVerify.length === 0}
              <p class="state-body">Not yet run — a verdict appears after the next build verifies in-game.</p>
            {:else}
              {#each gameVerify as v (v.id)}
                <GameVerifyVerdict verdict={v} {now} />
              {/each}
            {/if}
          </div>
        {/if}

        <!-- Live transcript + session controls (PRODUCT §4.8; D-011/D-035). -->
        {#if selectedSession}
          <div class="card">
            <div class="transcript-head">
              <h2 class="section-title">
                Transcript <span class="mono sid">{shortId(selectedSession)}</span>
              </h2>
              <div class="transcript-meta">
                {#if liveStatus ?? selectedRow?.status}
                  <span class="status" data-status={liveStatus ?? selectedRow?.status}>
                    {liveStatus ?? selectedRow?.status}
                  </span>
                {/if}
                {#if liveTokens}
                  <span class="tokens mono">↓{liveTokens.tokensIn} ↑{liveTokens.tokensOut} tok</span>
                {/if}
              </div>
            </div>

            <!-- OBSERVABILITY — the open session's honest failure reason (screened session.note).
                 Status prefers the live SSE status (a session that JUST failed shows it without a
                 reload); the note is persisted-only (never live-streamed), read off the row. -->
            <SessionFailureReason
              status={liveStatus ?? selectedRow?.status}
              note={selectedRow?.note}
              variant="panel"
            />

            <div class="transcript" role="log" aria-live="polite" aria-label="session transcript">
              {#if liveTurns.length === 0}
                <p class="state-body">No transcript yet — output appears here as the session runs.</p>
              {:else}
                <!-- KIND-AWARE render via the shared component: thinking → collapsible turn,
                     tool_use/tool_result → tool turns, briefing → "woke up with" block, the
                     rest → prose. Identical framing to the /claude-code replay (no divergence). -->
                <SessionTranscript turns={liveTurns} onViewFile={viewFileSnapshot} />
              {/if}
            </div>

            <!-- D-035: control actions ride the loopback control endpoint (operator origin).
                 14.6: each control is enabled ONLY when the backend really supports it
                 (honest capability matrix) — disabled-with-reason, never a dead button. -->
            <div class="controls" aria-label="session controls">
              <div class="interject">
                <input
                  class="interject-input mono"
                  type="text"
                  bind:value={interjectMsg}
                  placeholder="Interject a message…"
                  disabled={!selectedIsRunning || controlBusy || !caps.interject}
                />
                <button
                  class="btn"
                  type="button"
                  onclick={() => sendControl('interject')}
                  title={caps.interject
                    ? undefined
                    : (caps.reason ?? 'interject not supported by this backend')}
                  disabled={!selectedIsRunning ||
                    controlBusy ||
                    !caps.interject ||
                    !interjectMsg.trim()}>Interject</button
                >
              </div>
              <button
                class="btn warn"
                type="button"
                onclick={() => sendControl('stop')}
                title={caps.stop ? undefined : (caps.reason ?? 'stop not supported by this backend')}
                disabled={!selectedIsRunning || controlBusy || !caps.stop}>Stop</button
              >
              <button
                class="btn"
                type="button"
                onclick={() => sendControl('resume')}
                title={caps.resume
                  ? undefined
                  : (caps.reason ?? 'resume not supported by this backend')}
                disabled={selectedIsRunning || controlBusy || !caps.resume}>Resume</button
              >
            </div>
            {#if capsNote}
              <!-- HONEST capability state (14.6/F-008): why some controls are disabled. -->
              <p class="caps-note mono">controls limited — {capsNote}</p>
            {/if}
            {#if controlError}
              <p class="form-error" role="alert">{controlError}</p>
            {/if}
          </div>
        {/if}
      </div>
    {:else if tab === 'memory'}
      <!-- TASK 10.4 — project-scoped Memory: recall list + knowledge graph (UI-SPEC §195). -->
      <div class="tab-body">
        <div class="mem-grid">
          <div class="card recall">
            <div class="recall-head">
              <span class="eyebrow"
                >recall · {memories.length} {memories.length === 1 ? 'memory' : 'memories'}</span
              >
              <input
                class="mem-search"
                type="search"
                placeholder="Filter recall…"
                bind:value={memQuery}
                aria-label="Filter project memories by keyword"
              />
            </div>
            {#if memories.length === 0}
              <p class="state-body">
                No memory for this project yet — memories accrue as its sessions run and the
                memory loop extracts durable learnings.
              </p>
            {:else if memFiltered.length === 0}
              <p class="state-body">No memories match “{memQuery}” — clear the filter.</p>
            {:else}
              <ul class="recall-list">
                {#each memFiltered as m (m.id)}
                  <li class="recall-row" data-status={m.status}>
                    <div class="recall-meta">
                      <span class="kind-tag mono" data-kind={m.kind}>{m.kind}</span>
                      <span class="scope mono">{m.scope}</span>
                      {#if m.tier === 0}<span class="tier0 mono">tier-0</span>{/if}
                      {#if m.status !== 'active'}<span class="status-flag mono">{m.status}</span>{/if}
                      <span class="imp mono" title="importance">{m.importance.toFixed(1)}</span>
                    </div>
                    <p class="recall-body">{m.content}</p>
                    <div class="recall-foot">
                      <span class="cite mono">{bareId(m.id)}</span>
                      {#if m.tags}{#each m.tags as t (t)}<span class="tag mono">{t}</span>{/each}{/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <div class="card graph">
            <span class="eyebrow">
              knowledge graph · {graph.nodes.length} nodes · {graph.edges.length} edges
            </span>
            {#if graph.nodes.length === 0}
              <p class="state-body">
                No graph for this project yet — entities and links appear once its memory
                references topics in the knowledge graph.
              </p>
            {:else}
              <ul class="node-list" aria-label="graph entities">
                {#each graph.nodes as n (n.id)}
                  {@const isFocus = focusId === n.id}
                  {@const isNeighbour = neighbours.has(n.id)}
                  <li>
                    <button
                      type="button"
                      class="node"
                      data-status={n.status}
                      data-focus={isFocus}
                      data-neighbour={isNeighbour}
                      data-dim={focusId !== null && !isFocus && !isNeighbour}
                      onclick={() => focusNode(n.id)}
                      aria-pressed={isFocus}
                    >
                      <span class="node-type mono" data-type={n.type}>{n.type}</span>
                      <span class="node-label">{n.label}</span>
                    </button>
                  </li>
                {/each}
              </ul>
              {#if focusId}
                <div class="focus-panel" aria-live="polite">
                  <span class="eyebrow">
                    {focusedEdges.length} {focusedEdges.length === 1 ? 'link' : 'links'} from
                    <span class="mono">{bareId(focusId)}</span>
                  </span>
                  {#if focusedEdges.length}
                    <ul class="edge-list">
                      {#each focusedEdges as e (e.from + e.kind + e.to)}
                        <li class="edge">
                          <span class="edge-kind mono">{e.kind}</span>
                          <span class="edge-target mono"
                            >{e.from === focusId ? bareId(e.to) : bareId(e.from)}</span
                          >
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <p class="state-body">No links from this node.</p>
                  {/if}
                </div>
              {/if}
            {/if}
          </div>
        </div>
      </div>
    {:else if tab === 'loops'}
      <!-- LP-3 — this project's recurring autonomous loops (autonomous PM drive + cadence), surfaced
           via the reusable LoopList (LP-2). VIEW + IDENTIFY only — config-editing is a later wave.
           Honest states (F-008): an unarmed/unscheduled PM ⇒ "no active loops", never a fake card. -->
      <div class="tab-body">
        <p class="state-body loops-lede">
          The recurring loops this project's Project Manager runs on its own — the autonomous drive
          (when armed) and the cadence trigger (when scheduled). Live from the database; states are
          honest ('—' / 'not yet run' / 'unknown') rather than fabricated. View &amp; identify only.
        </p>
        {#if loops.length === 0}
          <div class="card state">
            <span class="eyebrow">no active loops</span>
            <p class="state-body">
              This project has no armed autonomous drive or scheduled PM cadence yet, so it runs no
              recurring loops. Arm the PM or set a cadence on the PM tab and its loops appear here.
            </p>
          </div>
        {:else}
          <LoopList {loops} projectNames={loopProjectNames} />
        {/if}
      </div>
    {:else if tab === 'release'}
      <div class="tab-body">
        <div class="card">
          <h2 class="section-title">Release</h2>
          <p class="state-body">
            The full release pipeline — dry-run → test → changelog → version → tag →
            publish — runs on the dedicated Release surface.
          </p>
          <a class="link-btn" href={releaseHref}>Open release pipeline →</a>
        </div>
      </div>
    {:else if tab === 'sync'}
      <div class="tab-body">
        <div class="card">
          <h2 class="section-title">Sync</h2>
          <p class="state-body">
            Reconcile this project's tasks with GitHub issues — idempotently, via your own
            <span class="mono">gh</span> credentials (never stored). The reference task↔issue
            sync adapter.
          </p>
          <a class="link-btn" href={syncHref}>Open GitHub sync →</a>
        </div>
      </div>
    {:else if tab === 'targets'}
      <div class="tab-body">
        <div class="card">
          <h2 class="section-title">Deploy &amp; publish targets</h2>
          <p class="state-body">
            Declare how this project ships — choose a publish/deploy <em>adapter</em> per target
            ({'{'}adapterId, config{'}'}) and the release pipeline drives that adapter, not a fixed
            script. Credentials are referenced by name from <span class="mono">.env</span> (never
            stored). The D-037 adapter framework.
          </p>
          <a class="link-btn" href={targetsHref}>Open targets →</a>
        </div>
      </div>
    {:else}
      <!-- TASK 10.4 — project Settings: project-level config (UI-SPEC §196). -->
      <div class="tab-body">
        <div class="card">
          <h2 class="section-title">Project settings</h2>
          <p class="state-body">
            Project-level configuration. The slug (<span class="mono">{slug}</span>) and root path
            are immutable; rescan to re-detect on-disk changes.
          </p>
          <form
            method="POST"
            action="?/updateSettings"
            class="settings-form"
            use:enhance={() => {
              settingsBusy = true;
              return async ({ update }) => {
                await update({ reset: false });
                settingsBusy = false;
              };
            }}
          >
            <label class="field settings-field">
              <span class="field-label">Name</span>
              <input class="pm-input" type="text" name="name" value={project.name} required />
            </label>
            <label class="field settings-field">
              <span class="field-label">Status</span>
              <select class="pm-input" name="status" value={project.status}>
                {#each projectStatuses as s (s)}
                  <option value={s}>{s}</option>
                {/each}
              </select>
            </label>
            <label class="field settings-field">
              <span class="field-label">Build tool</span>
              <input
                class="pm-input mono"
                type="text"
                name="build_tool"
                value={project.build_tool ?? ''}
                placeholder="npm / cargo / go …"
              />
            </label>
            <label class="field settings-field">
              <span class="field-label">Test command</span>
              <input
                class="pm-input mono"
                type="text"
                name="test_command"
                value={project.test_command ?? ''}
                placeholder="npm test"
              />
            </label>
            <label class="field settings-field">
              <span class="field-label">Repo URL</span>
              <input
                class="pm-input mono"
                type="text"
                name="repo_url"
                value={project.repo_url ?? ''}
                placeholder="https://github.com/owner/repo"
              />
            </label>
            <button class="btn primary" type="submit" disabled={settingsBusy}>
              {settingsBusy ? 'Saving…' : 'Save settings'}
            </button>
          </form>
          {#if settingsFeedback}
            {#if 'error' in settingsFeedback}
              <p class="form-error" role="alert">{settingsFeedback.error}</p>
            {:else}
              <p class="form-ok">Project settings saved.</p>
            {/if}
          {/if}
        </div>

        <!-- RC-4 — GitHub repository. Honest states (F-008): created (real repo_url) / no-repo
             (create control) / creating / each NAMED failure. ALWAYS private (RC-1/RC-2). -->
        <div class="card repo-card">
          <h2 class="section-title">GitHub repository</h2>

          {#if project.repo_url}
            <!-- CREATED — show the real, live repo_url (never fabricated). -->
            <p class="state-body">This project is backed by a GitHub repository.</p>
            <div class="repo-linked">
              <span class="repo-badge" data-kind="linked">linked</span>
              <a
                class="repo-url mono"
                href={project.repo_url}
                target="_blank"
                rel="noopener noreferrer"
              >{project.repo_url}</a>
            </div>
            <p class="repo-note">
              The remote URL is also editable in the form above. To create a NEW repo, clear it there
              first.
            </p>
          {:else}
            <!-- NO-REPO — offer the private create control + the two-step operator confirm. -->
            <p class="state-body">
              No repository yet. Create one to back this project with a remote. This
              <strong>always creates a PRIVATE repository</strong> — public repos are never created
              here (RC-1).
            </p>

            {#if repoBrief}
              <!-- PM-PROPOSED brief (RC-3) — the operator approves (→ confirmed create) or rejects. -->
              <div class="repo-brief" aria-label="pending repo-create recommendation">
                <span class="repo-badge" data-kind="proposed">PM recommendation</span>
                <p class="repo-brief-ask">{repoBrief.ask}</p>
                <p class="repo-brief-issue">{repoBrief.issue}</p>
                {#if repoBrief.name}
                  <p class="repo-brief-target">
                    Target (private):
                    <span class="mono">{repoBrief.owner ? `${repoBrief.owner}/${repoBrief.name}` : repoBrief.name}</span>
                  </p>
                {/if}
                <div class="repo-brief-actions">
                  <button
                    class="btn primary"
                    type="button"
                    disabled={repoBriefBusy}
                    onclick={() => decideRepoBrief(repoBrief!.id, 'approve')}
                  >
                    {repoBriefBusy ? 'Working…' : 'Approve & create (private)'}
                  </button>
                  <button
                    class="btn ghost"
                    type="button"
                    disabled={repoBriefBusy}
                    onclick={() => decideRepoBrief(repoBrief!.id, 'reject')}
                  >
                    Reject
                  </button>
                </div>
                {#if repoBriefError}
                  <p class="form-error" role="alert">{repoBriefError}</p>
                {/if}
                <p class="repo-note">
                  Approving records your consent and drives the gated create (private-first); rejecting
                  creates nothing. The confirm is server-derived — never client-built.
                </p>
              </div>
            {/if}

            <form
              method="POST"
              action="?/repoCreate"
              class="repo-form"
              use:enhance={() => {
                repoBusy = true;
                return async ({ update }) => {
                  await update({ reset: false });
                  repoBusy = false;
                  repoConfirming = false;
                };
              }}
            >
              <label class="field settings-field">
                <span class="field-label">Repository name</span>
                <input
                  class="pm-input mono"
                  type="text"
                  name="name"
                  bind:value={repoName}
                  placeholder="my-project"
                  autocomplete="off"
                  required
                />
              </label>
              <label class="field settings-field">
                <span class="field-label">Owner <span class="field-hint">(optional — defaults to the authenticated user)</span></span>
                <input
                  class="pm-input mono"
                  type="text"
                  name="owner"
                  bind:value={repoOwner}
                  placeholder="my-org"
                  autocomplete="off"
                />
              </label>

              {#if !repoConfirming}
                <button
                  class="btn primary"
                  type="button"
                  disabled={repoBusy || !repoName.trim()}
                  onclick={() => (repoConfirming = true)}
                >
                  Create repo (private)…
                </button>
              {:else}
                <div class="repo-confirm" role="group" aria-label="confirm private repo creation">
                  <p class="confirm-note">
                    This creates a <strong>PRIVATE</strong> GitHub repository
                    <span class="mono">{repoOwner.trim() ? `${repoOwner.trim()}/${repoName.trim()}` : repoName.trim()}</span>
                    and pushes this project's local commits to it. It is a real outward action,
                    reversible only by deleting the repo on GitHub. The confirm token is derived
                    server-side. Continue?
                  </p>
                  <div class="repo-confirm-actions">
                    <button class="btn primary" type="submit" disabled={repoBusy}>
                      {repoBusy ? 'Creating…' : 'Confirm — create private repo'}
                    </button>
                    <button
                      class="btn ghost"
                      type="button"
                      disabled={repoBusy}
                      onclick={() => (repoConfirming = false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              {/if}
            </form>

            {#if repoFeedback}
              {#if 'error' in repoFeedback}
                <!-- Boundary fail() — a named server-side reason (no PM, invalid name, DB down). -->
                <p class="form-error" role="alert">{repoFeedback.error}</p>
              {:else if repoFeedback.created}
                <!-- CREATED — the gate landed the repo. Show the real URL (live next reload). -->
                <p class="form-ok">
                  {repoFeedback.summary ?? 'Repository created.'}
                  {#if repoFeedback.repoUrl}
                    <a class="repo-url mono" href={String(repoFeedback.repoUrl)} target="_blank" rel="noopener noreferrer">{repoFeedback.repoUrl}</a>
                  {/if}
                </p>
              {:else}
                <!-- NOT created — the gate halted at a NAMED stage (unauthed / permission /
                     private re-assert). Surface the honest summary, never a fabricated success. -->
                <p class="form-error" role="alert">
                  {repoFeedback.summary ?? 'The repository was not created.'}
                  {#if repoFeedback.failedAt}<span class="repo-failed-at mono"> (halted at: {repoFeedback.failedAt})</span>{/if}
                </p>
              {/if}
            {/if}
          {/if}
        </div>

        <div class="card">
          <h2 class="section-title">Model routing &amp; gates</h2>
          <p class="state-body">
            Routing tiers, intent→config mapping, and gate defaults are configured globally for
            now; per-project overrides land with the routing override surface.
          </p>
          <a class="link-btn" href="/settings">Open global settings →</a>
        </div>
      </div>
    {/if}
  {/if}
</section>

<!-- FS-3 (FILE-SNAPSHOT-SPEC §4) — the read-only file-snapshot viewer, opened from a finding's
     cited file:line. Scoped to THIS project so the lookup resolves the project's own snapshot. -->
<FileSnapshotViewer
  open={snapshotViewer.open}
  path={snapshotViewer.path}
  project={data.projectId}
  onClose={() => (snapshotViewer = { open: false })}
/>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    width: 100%; /* 14.2a: fluid full-width — the shell gutter (--page-gutter) frames it */
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .path {
    font-size: 0.78rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .state {
    gap: var(--space-2);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  /* LP-3 — the Loops tab intro line; max-width keeps the copy readable above the card grid. */
  .loops-lede {
    max-width: 72ch;
  }
  .tabs {
    display: flex;
    gap: var(--space-2, 0.5rem);
    border-bottom: var(--border-width, 1px) solid var(--color-border);
    /* 14.2b: the strip never clips tabs at narrow widths — it scrolls. The
       browser keeps keyboard reachability (a focused tab scrolls into view). */
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .tab {
    appearance: none;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--color-text-muted);
    font: var(--type-body-sm);
    font-weight: 600;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    min-height: 24px;
    /* 14.2b: tabs keep their natural width inside the scrollable strip. */
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .tab:hover {
    color: var(--color-text);
  }
  .tab:focus-visible {
    /* Inset ring: the strip is a scroll container, so an offset ring would be
       clipped at its edges. Inset keeps the indicator fully visible. */
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
    border-radius: var(--radius-sm, 6px);
  }
  /* 14.2b: visible affordance at narrow widths — the right edge fades while
     more tabs are off-screen (mask only where overflow can occur). */
  @media (max-width: 767px) {
    .tabs {
      -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
      mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
    }
  }
  .tab[data-active='true'] {
    color: var(--color-text);
    border-bottom-color: var(--color-accent);
  }
  .tab-body {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack, 1rem);
  }
  .section-title {
    font: var(--type-h2, var(--type-body));
    font-weight: 600;
    color: var(--color-text);
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .sub {
    /* h3 = heading → display face (Lastik), never mono (14.3 / D-034 §4) */
    font: var(--weight-semibold) var(--text-xs) / var(--leading-snug) var(--font-display);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }
  .count {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .plan {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.4rem 1rem;
    margin: 0;
  }
  .plan dt {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 600;
  }
  .plan dd {
    margin: 0;
    font: var(--type-body-sm);
    color: var(--color-text);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font: var(--type-body-sm);
    color: var(--color-text);
    min-width: 0;
  }
  .row-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session {
    flex-wrap: wrap;
  }
  .sid {
    font-size: 0.74rem;
    color: var(--color-text-muted);
  }
  .model {
    font-size: 0.74rem;
    color: var(--color-text-2);
  }
  .when {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .elapsed {
    font-size: 0.72rem;
    color: var(--color-text-secondary, var(--color-text-muted));
    padding: 0.02rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .elapsed.live {
    color: var(--color-running-on-overlay, var(--color-running));
  }
  .card-when {
    font-size: 0.66rem;
    color: var(--color-text-muted);
  }
  .prio {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .status {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.12rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    text-transform: lowercase;
    white-space: nowrap;
    flex: none;
  }
  .status[data-status='active'],
  .status[data-status='in_progress'],
  .status[data-status='running'] {
    color: var(--color-running, var(--color-accent));
  }
  .status[data-status='done'],
  .status[data-status='shipped'] {
    color: var(--color-success, var(--color-running));
  }
  .status[data-status='failed'] {
    /* -on-overlay tints hit BODY AA on the overlay tag background (14.3) */
    color: var(--color-error-on-overlay);
  }
  .status[data-status='blocked'] {
    color: var(--color-blocked-on-overlay);
  }
  /* TASK 16.4 — the proposed-task pipeline states (PM-SPEC §4). */
  .status[data-status='proposed'] {
    color: var(--color-info-on-overlay);
  }
  .status[data-status='withdrawn'] {
    color: var(--color-text-muted);
  }
  /* PM→HR dispatch (gap A) — a HIRE gap (a class no role proves). */
  .status[data-status='hire'] {
    color: var(--color-info-on-overlay);
  }
  .tag {
    font-size: 0.68rem;
    color: var(--color-accent);
    background: var(--color-accent-muted, var(--color-surface-overlay));
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
  }
  /* CAH4 — the honest "setup incomplete" markers (warning tone, design tokens only). */
  .setup-badge {
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--color-error-on-overlay);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-error);
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
  }
  .setup-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    border-color: var(--color-error);
  }
  .setup-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .link-btn {
    align-self: flex-start;
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-accent);
    text-decoration: none;
    padding: 0.4rem 0.75rem;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
  }
  .link-btn:hover {
    background: var(--color-surface-overlay);
  }
  .link-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  /* ── Job-8 launch + transcript + controls ──────────────────────────────── */
  .launch-form {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    min-width: 0;
    flex: 1 1 16rem;
  }
  .field-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 600;
  }
  .field select,
  .interject-input {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.4rem 0.6rem;
    font: var(--type-body-sm);
    min-height: 24px;
  }
  .field select:focus-visible,
  .interject-input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .btn {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.4rem 0.85rem;
    font: var(--type-body-sm);
    font-weight: 600;
    cursor: pointer;
    min-height: 24px;
  }
  .btn:hover:not(:disabled) {
    background: var(--color-surface-card);
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.primary {
    color: var(--color-text-inverse, var(--color-bg));
    background: var(--color-accent);
    border-color: var(--color-accent);
  }
  .btn.warn {
    /* -on-overlay tint: BODY AA on the overlay button face (14.3) */
    color: var(--color-error-on-overlay);
    border-color: var(--color-error);
  }
  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error);
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  /* RC-4 — GitHub repository surface (Settings tab). Tokens only; a11y-first. */
  .btn.ghost {
    background: transparent;
  }
  .repo-card {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .repo-linked {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .repo-url {
    color: var(--color-text-accent, var(--color-accent));
    text-decoration: underline;
    word-break: break-all;
  }
  .repo-url:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }
  .repo-badge {
    display: inline-block;
    font: var(--type-body-sm);
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    border: var(--border-width, 1px) solid var(--color-border);
    color: var(--color-text-2);
  }
  .repo-badge[data-kind='linked'] {
    color: var(--color-success-on-overlay, var(--color-success));
    border-color: var(--color-success, var(--color-border));
  }
  .repo-badge[data-kind='proposed'] {
    color: var(--color-info-on-overlay, var(--color-info));
    border-color: var(--color-info, var(--color-border));
  }
  .repo-note {
    font: var(--type-body-sm);
    color: var(--color-text-muted, var(--color-text-2));
  }
  .field-hint {
    font-weight: 400;
    color: var(--color-text-muted, var(--color-text-2));
  }
  .repo-form {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .repo-confirm {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6rem;
    border: var(--border-width, 1px) solid var(--color-border-strong, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-bg-inset, var(--color-surface));
  }
  .confirm-note {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  .repo-confirm-actions,
  .repo-brief-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .repo-brief {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.6rem;
    border: var(--border-width, 1px) solid var(--color-info, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-info-bg, var(--color-surface));
  }
  .repo-brief-ask {
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }
  .repo-brief-issue,
  .repo-brief-target {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  .repo-failed-at {
    color: var(--color-text-muted, var(--color-text-2));
  }
  .open-btn {
    appearance: none;
    background: transparent;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    color: var(--color-accent);
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    margin-left: auto;
    min-height: 24px;
  }
  .open-btn:hover {
    background: var(--color-surface-overlay);
  }
  .open-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .row.session {
    flex-wrap: wrap;
  }
  .row.session[data-selected='true'] {
    background: var(--color-surface-overlay);
    border-radius: var(--radius-sm, 6px);
  }
  /* The failure reason (SessionFailureReason) wraps onto its own full-width line below the
     session meta row so a long reason is readable rather than truncated inline. */
  .row.session :global(.fail-reason) {
    flex: 1 0 100%;
  }
  .transcript-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .transcript-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .tokens {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .transcript {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 24rem;
    overflow-y: auto;
    background: var(--color-bg, #03120e);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.6rem 0.75rem;
  }
  /* The kind-aware turn framing (prose / thinking / tool / briefing) lives in the shared
     <SessionTranscript> component (src/lib/components/shell/SessionTranscript.svelte) — both
     this view and /claude-code render through it, so the per-line CSS is owned there. */
  .controls {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  /* 14.6 — honest capability note: why some controls render disabled (F-008). */
  .caps-note {
    margin: var(--space-2, 0.5rem) 0 0;
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .interject {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex: 1 1 18rem;
  }
  .interject-input {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* ── TASK 9.1 — Project Manager surface (tokens-only; a11y AA; reduced-motion safe) ── */
  .pm-head {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
  }
  /* ── PM periodic review (TASK 11.4) ─────────────────────────────────────── */
  .review-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .review-mode-hint {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
  }
  .review-list {
    gap: var(--space-3, 0.75rem);
  }
  .review-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: var(--space-3, 0.75rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .review-row-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .review-trigger {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: lowercase;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .review-trigger[data-trigger='periodic'] {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .review-when {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .review-summary {
    font: var(--type-body-sm);
    color: var(--color-text);
  }
  .review-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  /* TASK 16.2 — the periodic-schedule editor (cadence cron + stagger offset). */
  .schedule-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-3, 0.75rem);
    margin-block: var(--space-3, 0.75rem);
  }
  .schedule-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  /* TASK 16.4 — the proposals queue (PM-SPEC §4 Act with Purpose). */
  .authority-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    margin-block: var(--space-2, 0.5rem);
  }
  .authority-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .proposal-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  /* PM→HR dispatch (gap A) — the hiring-gap rows + dispatch affordance. */
  .gap-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .gap {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.75rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    background: var(--color-bg-inset);
  }
  .gap-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .gap-evidence {
    margin: 0;
    font-size: 0.82rem;
    color: var(--color-text-muted);
  }
  .gap-form {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .gap-role {
    flex: 1 1 14rem;
  }
  .gap-result {
    margin: 0;
    font-size: 0.82rem;
  }
  .gap-result.ok {
    color: var(--color-success, var(--color-running));
  }
  .gap-result.err {
    color: var(--color-error-on-overlay);
  }
  /* Gap D — PM fit-verdict on hire gates */
  .fit-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .fit-gate {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.75rem);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 0.5rem);
    background: var(--color-bg-secondary, transparent);
  }
  .fit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .fit-ask {
    margin: 0;
    font-weight: 600;
  }
  .fit-falsifier {
    margin: 0;
    font-size: 0.82rem;
    color: var(--color-text-muted);
  }
  .fit-current {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
    font-size: 0.85rem;
  }
  .fit-badge {
    display: inline-block;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 0.25rem);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .fit-badge[data-outcome='approve'] {
    color: var(--color-success, var(--color-running));
    border: 1px solid var(--color-success, var(--color-running));
  }
  .fit-badge[data-outcome='deny'] {
    color: var(--color-warn);
    border: 1px solid var(--color-warn);
  }
  .fit-reason {
    color: var(--color-text-primary);
  }
  .fit-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .fit-actions {
    display: flex;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .fit-result {
    margin: 0;
    font-size: 0.82rem;
  }
  .fit-result.ok {
    color: var(--color-success, var(--color-running));
  }
  .fit-result.err {
    color: var(--color-error-on-overlay);
  }
  .chip {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    margin: 0 0.2rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    font-size: 0.72rem;
  }
  .proposal {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.75rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    background: var(--color-bg-inset);
  }
  .proposal-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .proposal-fields {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
  }
  .proposal-fields dt {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .proposal-fields dd {
    margin: 0;
    font: var(--type-body-sm);
    color: var(--color-text-2);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .criteria-list {
    margin: 0;
    padding-left: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .verdicts {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .verdict {
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.35rem 0.5rem;
  }
  .verdict-summary {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    cursor: pointer;
  }
  .verdict-meta {
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .verdict-reasons {
    margin: 0.4rem 0 0;
    padding-left: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  /* TASK 16.7b — panel-composition rationale (WORKFORCE-SPEC §8). */
  .verdict-rationale {
    margin: 0.35rem 0 0;
    font-size: 0.68rem;
    font-style: italic;
    color: var(--color-text-muted);
  }
  .proposal-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .brief-open-hint {
    color: var(--color-warn-on-overlay, var(--color-warn));
  }
  .revise-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border-top: var(--border-width, 1px) solid var(--color-border);
    padding-top: var(--space-2, 0.5rem);
  }
  /* TASK 16.2 — trigger provenance line (what woke the PM). */
  .review-prov {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .review-prov-kind {
    font-weight: 600;
    color: var(--color-accent);
  }
  .pm-badge {
    font-size: 0.66rem;
    font-weight: 600;
    text-transform: lowercase;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .pm-badge[data-on='true'] {
    color: var(--color-running, var(--color-accent));
    border-color: var(--color-running, var(--color-accent));
  }
  /* ── TASK 16.1 — hire wizard + charter editor ───────────────────────────── */
  .hint {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
  }
  .hire-wizard {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    margin-top: var(--space-3, 0.75rem);
    padding: var(--space-3, 0.75rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .hire-pre-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .hire-pre-evidence {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .hire-question,
  .hire-charter {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .hire-progress {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .hire-question-text {
    font: var(--type-body);
    color: var(--color-text);
  }
  .hire-push-text {
    font: var(--type-body-sm);
    color: var(--color-accent);
  }
  .hire-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .charter-text {
    font: var(--type-body-sm);
    color: var(--color-text);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-3, 0.75rem);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0;
  }
  .charter-form-hidden {
    display: none;
  }
  .pm-kind-stats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
  }
  .pm-kind-stat {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    font-size: 0.72rem;
    color: var(--color-text-2);
    padding: 0.12rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .pm-kind-name {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    color: var(--color-text-muted);
  }
  .pm-kind-count {
    color: var(--color-text);
  }
  .pm-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .pm-form-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .pm-kind-field {
    flex: 0 0 9rem;
  }
  .pm-content-field {
    flex: 1 1 16rem;
  }
  .pm-input {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.4rem 0.6rem;
    font: var(--type-body-sm);
    min-height: 24px;
    width: 100%;
  }
  .pm-input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .pm-memory {
    gap: 0.45rem;
  }
  .pm-memory-row {
    align-items: baseline;
    flex-wrap: wrap;
  }
  .pm-memory-content {
    white-space: normal;
    overflow: visible;
  }
  .pm-kind-tag {
    flex: none;
    font-size: 0.64rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.08rem 0.45rem;
    border-radius: var(--radius-xs, 4px);
    color: var(--color-on-accent, var(--color-bg));
    background: var(--color-text-muted);
  }
  .pm-kind-tag[data-kind='risk'] {
    background: var(--color-warn, var(--color-blocked, orange));
  }
  .pm-kind-tag[data-kind='learning'] {
    background: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .pm-kind-tag[data-kind='pattern'] {
    background: var(--color-accent);
  }
  .pm-kind-tag[data-kind='decision'] {
    background: var(--color-text-2, var(--color-text));
  }
  .pm-source {
    flex: none;
    font-size: 0.66rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .pm-decisions {
    gap: 0.6rem;
  }
  .pm-decision {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.5rem 0.6rem;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .pm-decision-head {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
  }
  .pm-decision-title {
    font-weight: 600;
    white-space: normal;
  }
  .pm-decision-line {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  .pm-decision-lbl {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    font-weight: 600;
    margin-right: 0.35rem;
  }
  .pm-sprint-row {
    gap: 0.6rem;
  }
  .pm-chat-form {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .pm-chat-form .field {
    flex: 1 1 18rem;
  }
  .link-inline {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--color-accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    text-decoration: underline;
  }
  .link-inline:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  /* ── PM-LC-3 — the one-click "start the project's life" lifecycle control ───── */
  .lifecycle-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .lifecycle-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-3, 0.75rem);
  }
  .lifecycle-head .count {
    margin-left: auto;
    color: var(--color-text-muted);
  }
  .lifecycle-start {
    align-self: flex-start;
  }
  .lifecycle-result {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .lifecycle-counts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3, 0.75rem);
    font-size: 0.78rem;
    color: var(--color-text-muted);
  }
  .lifecycle-counts .lc-n {
    font-weight: 700;
    color: var(--color-text);
    margin-right: 0.3rem;
  }
  .lifecycle-counts .lc-warn .lc-n {
    color: var(--color-warn);
  }
  /* PMA — autonomous drive control + honest loop-state surface (tokens only). */
  .autonomous-control {
    margin-top: var(--space-3, 0.75rem);
    border-top: var(--border-width, 1px) solid var(--color-border);
    padding-top: var(--space-3, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .autonomous-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .autonomous-label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    min-width: 12rem;
    flex: 1 1 16rem;
  }
  .auto-title {
    font-weight: 600;
    color: var(--color-text);
  }
  .auto-sub {
    font-size: 0.85rem;
    color: var(--color-text-muted);
    line-height: 1.4;
  }
  .autonomous-state {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    border-radius: var(--radius-sm, 0.375rem);
    border-left: 3px solid var(--color-running, var(--color-accent));
    background: var(--color-surface-overlay, transparent);
  }
  .autonomous-state[data-state='blocked'],
  .autonomous-state[data-state='cap-reached'] {
    border-left-color: var(--color-blocked, var(--color-warn));
  }
  .autonomous-state[data-state='dod-reached'],
  .autonomous-state[data-state='awaiting-release-confirm'],
  .autonomous-state[data-state='published'] {
    border-left-color: var(--color-success);
  }
  .auto-state-label {
    font-weight: 600;
    color: var(--color-text);
  }
  .auto-state-reason {
    font-size: 0.85rem;
    color: var(--color-text-muted);
    line-height: 1.4;
  }

  /* PMA — pre-authorize-auto-publish opt-in (default OFF — a clearly-labelled operator switch). */
  .autopublish-opt {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3, 0.75rem);
    cursor: pointer;
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 0.375rem);
    background: var(--color-surface-overlay, transparent);
  }
  .toggle {
    flex: 0 0 auto;
    margin-top: 0.15rem;
    width: 2.25rem;
    height: 1.25rem;
    border-radius: 999px;
    border: var(--border-width, 1px) solid var(--color-border);
    background: var(--color-surface-sunken, var(--color-bg));
    padding: 0;
    position: relative;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  .toggle[data-on='true'] {
    background: var(--color-success);
    border-color: var(--color-success);
  }
  .toggle-knob {
    position: absolute;
    top: 50%;
    left: 0.15rem;
    transform: translateY(-50%);
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 50%;
    background: var(--color-text-on-accent, #fff);
    transition: left 120ms ease;
  }
  .toggle[data-on='true'] .toggle-knob {
    left: calc(100% - 1.05rem);
  }
  .toggle:focus-visible {
    outline: 2px solid var(--color-focus, var(--color-accent));
    outline-offset: 2px;
  }
  .autopublish-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .autopublish-title {
    font-weight: 600;
    color: var(--color-text);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }
  .autopublish-state {
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 0.375rem);
    border: var(--border-width, 1px) solid var(--color-border);
    color: var(--color-text-muted);
  }
  .autopublish-state[data-on='true'] {
    color: var(--color-success);
    border-color: var(--color-success);
  }
  .autopublish-sub {
    font-size: 0.85rem;
    color: var(--color-text-muted);
    line-height: 1.4;
  }
  @media (prefers-reduced-motion: reduce) {
    .toggle,
    .toggle-knob {
      transition: none;
    }
  }
  .lifecycle-live {
    margin-top: var(--space-2, 0.5rem);
    border-top: var(--border-width, 1px) solid var(--color-border);
    padding-top: var(--space-3, 0.75rem);
  }
  .lifecycle-live .section-subtitle {
    font-size: var(--text-base);
    font-weight: 600;
    margin: 0;
    color: var(--color-text);
  }

  /* ── CC-3 — overview progressive-disclosure (Plan / Maintain) ──────────────── */
  .disclosure {
    /* the disclosure head owns the card padding; the card itself becomes a tight shell so the
       collapsed state is a single compact row (reduces the at-a-glance flooding). */
    padding: 0;
    gap: 0;
  }
  .disclosure-head {
    /* a real <button> (keyboard + aria-expanded), styled as the panel header row. */
    appearance: none;
    background: transparent;
    border: 0;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    padding: var(--pad-card, 1rem);
    cursor: pointer;
    color: inherit;
    text-align: left;
  }
  .disclosure-head:hover .section-title {
    color: var(--color-text);
  }
  .disclosure-head:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
    border-radius: var(--radius-md, 10px);
  }
  .disclosure-hint {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    flex: none;
  }
  .disclosure-sub {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
  }
  .disclosure-sub.muted {
    color: var(--color-text-muted);
    opacity: 0.8;
  }
  .disclosure-hint .count[data-tone='warn'] {
    color: var(--color-blocked-on-overlay, var(--color-error-on-overlay));
    font-weight: 600;
  }
  .chevron {
    display: inline-block;
    font-size: 1.1rem;
    line-height: 1;
    color: var(--color-text-muted);
    transform: rotate(90deg);
    transition: transform var(--motion-fast, 120ms) ease;
  }
  .chevron[data-open='true'] {
    transform: rotate(270deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }
  .disclosure-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    padding: 0 var(--pad-card, 1rem) var(--pad-card, 1rem);
    border-top: var(--border-width, 1px) solid var(--color-border);
    padding-top: var(--space-3, 0.75rem);
  }

  /* ── TASK 10.4 — Overview at-a-glance + Maintain panel ─────────────────────── */
  .overview-stats {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-3, 0.75rem);
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    align-items: flex-start;
  }
  .stat-val {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--color-text);
  }
  .stat-val[data-tone='warn'] {
    color: var(--color-warn);
  }
  .stat-label {
    font-size: 0.72rem;
    text-transform: lowercase;
    color: var(--color-text-muted);
  }
  .maintain-card {
    gap: var(--space-3, 0.75rem);
  }
  /* TASK 11.5 — UX-inspection trigger row in the Maintain panel. */
  .maintain-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3, 0.75rem);
  }
  .ux-count {
    color: var(--color-text-muted, var(--color-text-secondary));
    font-size: var(--font-size-sm, 0.8125rem);
  }
  .maintain-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .sev-summary {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .sev-chip {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .sev-chip[data-empty='true'] {
    opacity: 0.45;
  }
  .sev-n {
    font-weight: 700;
    color: var(--color-text);
  }
  .sev-label {
    font-size: 0.7rem;
    text-transform: lowercase;
    color: var(--color-text-muted);
  }
  .finding-list {
    gap: 0.45rem;
  }
  .finding-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
    font: var(--type-body-sm);
    padding: 0.4rem 0.5rem;
    border: var(--border-width, 1px) solid var(--color-border-subtle, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .sev-tag {
    font-size: 0.68rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    text-transform: lowercase;
    font-weight: 600;
    flex: none;
  }
  /* Severity → color role per UI-SPEC §103: critical→error, high/medium→warn, low→info. */
  .sev-tag[data-sev='critical'],
  .sev-chip[data-sev='critical'] .sev-n {
    color: var(--color-error);
  }
  .sev-tag[data-sev='high'],
  .sev-chip[data-sev='high'] .sev-n {
    color: var(--color-warn);
  }
  .sev-tag[data-sev='medium'],
  .sev-chip[data-sev='medium'] .sev-n {
    color: var(--color-warn);
  }
  .sev-tag[data-sev='low'],
  .sev-chip[data-sev='low'] .sev-n {
    color: var(--color-info);
  }
  .family-tag {
    font-size: 0.64rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-xs, 4px);
    color: var(--color-text-muted);
    background: var(--color-surface-card);
    flex: none;
  }
  .family-tag[data-family='dependency'] {
    color: var(--color-accent);
  }
  .finding-rule {
    font-size: 0.72rem;
    color: var(--color-text);
  }
  .finding-loc {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  /* FS-3 — the cited file as a view-snapshot trigger. A real <button> (keyboard-reachable);
     reads as a quiet link until hover/focus so it does not shout over the finding row. */
  button.view-file {
    appearance: none;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  button.view-file:hover {
    color: var(--color-accent);
  }
  button.view-file:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-xs, 3px);
  }
  .finding-detail {
    flex: 1 1 100%;
    font-size: 0.74rem;
    color: var(--color-text-2);
  }

  /* ── TASK 10.4 — Tasks board (kanban) ──────────────────────────────────────── */
  .task-create-form {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .task-title-field {
    flex: 1 1 18rem;
  }
  .task-prio-field {
    flex: 0 0 9rem;
  }
  .task-prio-field select,
  .move-select {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.3rem 0.5rem;
    font: var(--type-body-sm);
    min-height: 24px;
  }
  .task-prio-field select:focus-visible,
  .move-select:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .board {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(160px, 1fr);
    gap: var(--space-3, 0.75rem);
    overflow-x: auto;
    padding-bottom: 0.4rem;
  }
  .board-col {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    padding: var(--space-3, 0.6rem);
    min-width: 0;
  }
  .board-col-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .board-empty {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    text-align: center;
    padding: 0.5rem 0;
  }
  .board-cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .board-card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.5rem 0.6rem;
  }
  .board-card-title {
    font: var(--type-body-sm);
    color: var(--color-text);
    word-break: break-word;
  }
  .board-card-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .prio[data-prio='high'],
  .prio[data-prio='critical'] {
    color: var(--color-warn);
  }
  .move-form {
    margin: 0;
  }
  .move-label {
    display: inline-flex;
  }
  .terminal-tag {
    font-size: 0.64rem;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* ── TASK 10.4 — hierarchical Roadmap ──────────────────────────────────────── */
  .roadmap {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .release-node {
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .release-summary {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.7rem;
    cursor: pointer;
    list-style: none;
    flex-wrap: wrap;
  }
  .release-summary::-webkit-details-marker {
    display: none;
  }
  .release-summary:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
    border-radius: var(--radius-sm, 6px);
  }
  .release-ver {
    font-weight: 600;
    color: var(--color-accent);
  }
  .release-title {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-text);
    flex: 1 1 auto;
  }
  .release-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: 0 0.7rem 0.6rem 1.4rem;
  }
  .tree-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font: var(--type-body-sm);
    color: var(--color-text);
    min-width: 0;
  }
  .tree-bullet {
    color: var(--color-text-muted);
    flex: none;
  }

  /* ── TASK 10.4 — project Memory tab ────────────────────────────────────────── */
  .mem-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: var(--space-3, 0.75rem);
    align-items: start;
  }
  @media (max-width: 900px) {
    .mem-grid {
      grid-template-columns: 1fr;
    }
  }
  .recall,
  .graph {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .recall-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .mem-search {
    flex: 1;
    min-width: 12ch;
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text);
    padding: 0.3rem 0.55rem;
    font: var(--type-body-sm);
  }
  .mem-search:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .recall-list,
  .node-list,
  .edge-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .recall-list {
    max-height: 60vh;
    overflow-y: auto;
  }
  .recall-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.6rem;
    border: var(--border-width, 1px) solid var(--color-border-subtle, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .recall-row[data-status='archived'],
  .recall-row[data-status='superseded'] {
    opacity: 0.5;
  }
  .recall-meta,
  .recall-foot {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .recall-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .kind-tag,
  .node-type {
    font-size: 0.66rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .scope,
  .imp,
  .cite {
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .tier0 {
    font-size: 0.62rem;
    text-transform: uppercase;
    color: var(--color-accent);
  }
  .status-flag {
    font-size: 0.62rem;
    text-transform: uppercase;
    color: var(--color-warn);
  }
  .imp {
    margin-left: auto;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    padding: 0.35rem 0.55rem;
    border: var(--border-width, 1px) solid var(--color-border-subtle, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    color: var(--color-text-2);
    cursor: pointer;
    transition: border-color 0.14s ease, opacity 0.14s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .node {
      transition: none;
    }
  }
  .node:hover {
    border-color: var(--color-accent);
  }
  .node:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .node[data-focus='true'] {
    border-color: var(--color-accent);
    color: var(--color-text);
  }
  .node[data-neighbour='true'] {
    border-color: var(--color-accent-muted, var(--color-accent));
  }
  .node[data-dim='true'] {
    opacity: 0.4;
  }
  .node[data-status='archived'],
  .node[data-status='superseded'] {
    opacity: 0.45;
  }
  .node-label {
    font: var(--type-body-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .node-list {
    max-height: 50vh;
    overflow-y: auto;
  }
  .focus-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-top: var(--border-width, 1px) solid var(--color-border);
    padding-top: var(--space-2, 0.5rem);
  }
  .edge {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .edge-kind {
    font-size: 0.66rem;
    color: var(--color-accent);
    min-width: 9ch;
  }
  .edge-target {
    font-size: 0.72rem;
    color: var(--color-text-2);
  }

  /* ── TASK 10.4 — Settings form ─────────────────────────────────────────────── */
  .settings-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    max-width: 36rem;
  }
  .settings-field {
    flex: none;
  }
</style>
