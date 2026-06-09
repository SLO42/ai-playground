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
  import { enhance } from '$app/forms';
  import { invalidate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const connected = $derived(data.connected);
  const project = $derived(data.project);
  const releases = $derived(data.releases ?? []);
  const phases = $derived(data.phases ?? []);
  const features = $derived(data.features ?? []);
  const sprints = $derived(data.sprints ?? []);
  const tasks = $derived(data.tasks ?? []);
  const sessions = $derived(data.sessions ?? []);
  // ── TASK 10.4 — the missing workspace surfaces (board / memory / settings / maintain).
  const taskStatuses = $derived(data.taskStatuses ?? []);
  const taskPriorities = $derived(data.taskPriorities ?? []);
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
  const selectedSession = $derived(data.selectedSession);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // The slug segment for child routes (the [id] param is the bare slug, not `project:slug`).
  const slug = $derived(page.params.id);
  const releaseHref = $derived(`/projects/${slug}/release`);
  const syncHref = $derived(`/projects/${slug}/sync`);
  const projectName = $derived(project?.name ?? slug);

  type Tab =
    | 'overview'
    | 'tasks'
    | 'roadmap'
    | 'pm'
    | 'sessions'
    | 'memory'
    | 'release'
    | 'sync'
    | 'settings';
  let tab = $state<Tab>('overview');
  // Default to the Sessions tab when a session is selected via ?session=.
  $effect(() => {
    if (selectedSession) tab = 'sessions';
  });

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

  // PM form state.
  let pmBusy = $state(false);
  let newMemoryKind = $state('observation');
  let newMemoryContent = $state('');
  let newDecisionTitle = $state('');
  let newDecisionContext = $state('');
  let newDecisionRationale = $state('');
  let newSprintName = $state('');
  let pmChatMessage = $state('');

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
    // TASK 10.4 — the Maintain panel + Memory tab update live too.
    const offF = stream.onDbChange('security_finding', () => void invalidate('app:findings'));
    const offMem = stream.onDbChange('memory', () => void invalidate('app:memory'));
    const offE = stream.onDbChange('entity', () => void invalidate('app:graph'));
    return () => {
      offP();
      offT();
      offS();
      offM();
      offD();
      offSp();
      offRv();
      offF();
      offMem();
      offE();
    };
  });

  // ── Live transcript (PRODUCT §4.8): stream the selected session's transcript over the one
  // SSE bus (`transcript`/`token_usage`/`session_status` events, §2.11). We seed from the
  // persisted historical transcript (data.transcript) and append each streamed event live.
  type LiveLine = { role: string; content: string; toolCall?: Record<string, unknown> };
  let liveLines = $state<LiveLine[]>([]);

  // ── Wake-up briefing (TASK 8.3) — the recalled, fenced context the agent woke up with.
  // A briefing transcript line carries `toolCall.kind === 'briefing'` and `content` = the
  // raw fenced text (§10 sentinels). We PARSE it into its distinct items so the operator can
  // SEE the past context as an unmistakable "woke up with" block — not a generic log line.
  const FENCE_OPEN = '⎆BEGIN_REFERENCE⎆';
  const FENCE_CLOSE = '⎆END_REFERENCE⎆';
  type BriefingRecallItem = { source: string; citation: string | null; body: string };

  function isBriefing(line: LiveLine): boolean {
    return line.toolCall?.kind === 'briefing';
  }

  /** Split a fenced briefing string into its recalled items (source · citation · body). */
  function parseBriefing(text: string): BriefingRecallItem[] {
    const items: BriefingRecallItem[] = [];
    const blocks = text.split(FENCE_OPEN).slice(1);
    for (const raw of blocks) {
      const block = raw.split(FENCE_CLOSE)[0] ?? '';
      // First line: `[source] [#N] <note>`; body follows the `---` separator.
      const sepIdx = block.indexOf('\n---\n');
      const head = (sepIdx >= 0 ? block.slice(0, sepIdx) : block).trim();
      const body = (sepIdx >= 0 ? block.slice(sepIdx + 5) : '').trim();
      const sourceMatch = head.match(/^\[([^\]]+)\]/);
      const citationMatch = head.match(/\[#([^\]]+)\]/);
      items.push({
        source: sourceMatch?.[1] ?? 'memory',
        citation: citationMatch?.[1] ?? null,
        body: body || head
      });
    }
    return items;
  }
  let liveTokens = $state<{ tokensIn: number; tokensOut: number } | null>(null);
  let liveStatus = $state<string | null>(null);

  $effect(() => {
    // Reset the live buffer to the historical transcript whenever the selection changes.
    const sid = selectedSession;
    liveLines = (data.transcript ?? []).map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCall ? { toolCall: m.toolCall } : {})
    }));
    liveTokens = null;
    liveStatus = null;
    if (!sid) return;

    const offT = stream.subscribeTopic<{ kind: string; event: unknown }>(
      'transcript',
      sid,
      (d) => {
        const ev = d.event as Record<string, unknown> | undefined;
        if (!ev) return;
        const t = ev.type as string;
        // TASK 8.3 — the wake-up briefing (recalled fenced memory) leads the transcript so the
        // operator sees the past context the agent woke up with.
        if (t === 'briefing')
          liveLines = [{ role: 'system', content: String(ev.text ?? ''), toolCall: { kind: 'briefing' } }, ...liveLines];
        else if (t === 'log') liveLines = [...liveLines, { role: 'assistant', content: String(ev.message ?? '') }];
        else if (t === 'tool_call')
          liveLines = [
            ...liveLines,
            { role: 'tool', content: `→ ${String(ev.name ?? 'tool')}`, toolCall: ev }
          ];
        else if (t === 'tool_result')
          liveLines = [...liveLines, { role: 'tool', content: String(ev.output ?? ''), toolCall: ev }];
      }
    );
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

  function shortId(id: string): string {
    const i = id.indexOf(':');
    return i >= 0 ? id.slice(i + 1) : id;
  }

  function fmtTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

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

<section class="page">
  <header class="page-head">
    <span class="eyebrow">project</span>
    <h1 class="title">{projectName}</h1>
    {#if project}
      <p class="path mono" title={project.root_path}>{project.root_path}</p>
      <div class="meta">
        <span class="status" data-status={project.status}>{project.status}</span>
        {#each project.ecosystem as e (e)}
          <span class="tag mono">{e}</span>
        {/each}
      </div>
    {/if}
  </header>

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
      <button
        class="tab"
        type="button"
        aria-pressed={tab === 'tasks'}
        data-active={tab === 'tasks'}
        onclick={() => (tab = 'tasks')}
        >Tasks{#if tasks.length > 0}<span class="count mono">{tasks.length}</span>{/if}</button
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
        data-active={tab === 'pm'}
        onclick={() => (tab = 'pm')}
        >PM{#if pmStats && pmStats.total > 0}<span class="count mono">{pmStats.total}</span>{/if}</button
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
        data-active={tab === 'memory'}
        onclick={() => (tab = 'memory')}
        >Memory{#if memories.length > 0}<span class="count mono">{memories.length}</span>{/if}</button
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
        aria-pressed={tab === 'settings'}
        data-active={tab === 'settings'}
        onclick={() => (tab = 'settings')}>Settings</button
      >
    </nav>

    {#if tab === 'overview'}
      <div class="tab-body">
        <div class="card">
          <h2 class="section-title">Plan</h2>
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

        <!-- At-a-glance counts → the dedicated surfaces -->
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
            <span class="stat-label">open findings</span>
          </li>
        </ul>

        <!-- Maintain panel (UI-SPEC §189) — the per-project security/dep-health/UX rollup.
             Reuses the SAME live security_finding rows the global /reports rollup reads. -->
        <div class="card maintain-card">
          <div class="maintain-head">
            <h2 class="section-title">Maintain</h2>
            <span class="count mono">{findings.length} open</span>
          </div>
          <p class="state-body">
            Security, dependency-health and UX-inspection findings for this project — the
            per-project view of the Maintain surface. Findings appear the moment a scan writes
            them; nothing here is fabricated.
          </p>
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
                  <span class="finding-loc mono">{f.file ?? '—'}{#if f.line}:{f.line}{/if}</span>
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
      <!-- TASK 9.1 — Project Manager: the strategic layer above task execution. -->
      <div class="tab-body">
        <div class="card">
          <div class="pm-head">
            <h2 class="section-title">Project Manager</h2>
            {#if pmBootstrapped}
              <span class="pm-badge mono" data-on="true">active</span>
            {:else}
              <span class="pm-badge mono">not bootstrapped</span>
            {/if}
          </div>
          <p class="state-body">
            The per-project PM accumulates typed memory, records decisions, runs sprints, and
            can be consulted directly. All persisted live on the project datastore.
          </p>
          {#if !pmBootstrapped}
            <form
              method="POST"
              action="?/pmBootstrap"
              use:enhance={() => {
                pmBusy = true;
                return async ({ update }) => {
                  await update({ reset: false });
                  pmBusy = false;
                };
              }}
            >
              <button class="btn primary" type="submit" disabled={pmBusy}>
                {pmBusy ? 'Bootstrapping…' : 'Bootstrap PM from project state'}
              </button>
            </form>
          {/if}
          {#if pmFeedback}
            {#if 'error' in pmFeedback}
              <p class="form-error" role="alert">{pmFeedback.error}</p>
            {:else if pmFeedback.action === 'bootstrap'}
              <p class="form-ok">
                {pmFeedback.bootstrapped
                  ? `PM bootstrapped — seeded ${pmFeedback.seeded} observation(s) from live project state.`
                  : 'PM already bootstrapped — existing memory left intact.'}
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
                PM session {shortId(String(pmFeedback.sessionId))} started · {String(pmFeedback.status)}.
                <button class="link-inline" type="button" onclick={() => openSession(String(pmFeedback.sessionId))}
                  >open transcript →</button
                >
              </p>
            {:else if pmFeedback.action === 'review'}
              <p class="form-ok">
                {String(pmFeedback.trigger)} review complete — wrote {String(pmFeedback.written)}
                memory entry(ies).
              </p>
            {/if}
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
            <p class="hint">Bootstrap the PM first to enable reviews.</p>
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
            Drive a real Claude Code PM session seeded with this project's plan + PM memory. The
            reply streams in the Sessions tab.
          </p>
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
            <button class="btn primary" type="submit" disabled={pmBusy || !pmChatMessage.trim()}>
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
                  <span class="when mono">{fmtTime(s.startedAt)}</span>
                  <button class="open-btn" type="button" onclick={() => openSession(s.id)}>open</button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

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

            <div class="transcript" role="log" aria-live="polite" aria-label="session transcript">
              {#if liveLines.length === 0}
                <p class="state-body">No transcript yet — output appears here as the session runs.</p>
              {:else}
                {#each liveLines as line, i (i)}
                  {#if isBriefing(line)}
                    {@const items = parseBriefing(line.content)}
                    <div class="briefing" role="note" aria-label="wake-up briefing — recalled context">
                      <div class="briefing-lead">
                        <span class="briefing-icon" aria-hidden="true">◆</span>
                        <span class="briefing-title">woke up with</span>
                        <span class="briefing-count mono"
                          >{items.length} recalled {items.length === 1 ? 'item' : 'items'}</span
                        >
                      </div>
                      <ul class="briefing-items">
                        {#each items as it, j (j)}
                          <li class="briefing-item">
                            <span class="briefing-tag mono"
                              >{it.source}{#if it.citation}&nbsp;[#{it.citation}]{/if}</span
                            >
                            <span class="briefing-body mono">{it.body}</span>
                          </li>
                        {/each}
                      </ul>
                    </div>
                  {:else}
                    <div class="line" data-role={line.role}>
                      <span class="line-role mono">{line.role}</span>
                      <span class="line-content mono">{line.content}</span>
                    </div>
                  {/if}
                {/each}
              {/if}
            </div>

            <!-- D-035: control actions ride the loopback control endpoint (operator origin). -->
            <div class="controls" aria-label="session controls">
              <div class="interject">
                <input
                  class="interject-input mono"
                  type="text"
                  bind:value={interjectMsg}
                  placeholder="Interject a message…"
                  disabled={!selectedIsRunning || controlBusy}
                />
                <button
                  class="btn"
                  type="button"
                  onclick={() => sendControl('interject')}
                  disabled={!selectedIsRunning || controlBusy || !interjectMsg.trim()}>Interject</button
                >
              </div>
              <button
                class="btn warn"
                type="button"
                onclick={() => sendControl('stop')}
                disabled={!selectedIsRunning || controlBusy}>Stop</button
              >
              <button
                class="btn"
                type="button"
                onclick={() => sendControl('resume')}
                disabled={selectedIsRunning || controlBusy}>Resume</button
              >
            </div>
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
              <input
                class="pm-input"
                type="text"
                name="status"
                value={project.status}
                placeholder="active / paused / archived"
              />
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

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    max-width: 980px;
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
  .tabs {
    display: flex;
    gap: var(--space-2, 0.5rem);
    border-bottom: var(--border-width, 1px) solid var(--color-border);
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
  }
  .tab:hover {
    color: var(--color-text);
  }
  .tab:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm, 6px);
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
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 600;
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
    color: var(--color-error, var(--color-danger, crimson));
  }
  .status[data-status='blocked'] {
    color: var(--color-blocked, var(--color-warn, orange));
  }
  .tag {
    font-size: 0.68rem;
    color: var(--color-accent);
    background: var(--color-accent-muted, var(--color-surface-overlay));
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
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
    color: var(--color-error, var(--color-danger, crimson));
    border-color: var(--color-error, var(--color-danger, crimson));
  }
  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error, var(--color-danger, crimson));
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success, var(--color-running, var(--color-accent)));
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
  .row.session[data-selected='true'] {
    background: var(--color-surface-overlay);
    border-radius: var(--radius-sm, 6px);
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
  .line {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    font-size: 0.78rem;
  }
  .line-role {
    flex: none;
    width: 5rem;
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .line[data-role='tool'] .line-role {
    color: var(--color-accent);
  }
  .line-content {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* TASK 8.3 — the wake-up briefing: a DISTINCT, accent-bordered "woke up with" block so the
     recalled context the agent started with is unmistakable, never a normal transcript line.
     Token-driven; a11y — accent lead has AA contrast on the inset surface; motion is opt-in. */
  .briefing {
    border: var(--border-width, 1px) solid var(--color-accent);
    border-left-width: 3px;
    border-radius: var(--radius-sm, 5px);
    background: var(--color-bg-inset, #03120e);
    padding: var(--space-3, 8px) var(--space-4, 12px);
    margin: var(--space-1, 2px) 0 var(--space-3, 8px);
    animation: briefing-in 0.18s ease-out;
  }
  .briefing-lead {
    display: flex;
    align-items: center;
    gap: var(--space-3, 8px);
    margin-bottom: var(--space-3, 8px);
  }
  .briefing-icon {
    color: var(--color-accent);
    font-size: 0.7rem;
    line-height: 1;
  }
  .briefing-title {
    color: var(--color-accent);
    font-weight: 600;
    font-size: 0.74rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .briefing-count {
    color: var(--color-text-muted);
    font-size: 0.7rem;
    margin-left: auto;
  }
  .briefing-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 8px);
  }
  .briefing-item {
    display: flex;
    gap: var(--space-3, 8px);
    align-items: baseline;
    font-size: 0.76rem;
  }
  .briefing-tag {
    flex: none;
    align-self: flex-start;
    color: var(--color-on-accent, #0a0f0d);
    background: var(--color-accent);
    border-radius: var(--radius-xs, 3px);
    padding: 1px var(--space-3, 8px);
    font-size: 0.66rem;
    white-space: nowrap;
  }
  .briefing-body {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  @keyframes briefing-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .briefing {
      animation: none;
    }
  }
  .controls {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
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
    color: var(--color-warning, var(--color-blocked, orange));
  }
  .stat-label {
    font-size: 0.72rem;
    text-transform: lowercase;
    color: var(--color-text-muted);
  }
  .maintain-card {
    gap: var(--space-3, 0.75rem);
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
  .sev-tag[data-sev='critical'],
  .sev-chip[data-sev='critical'] .sev-n {
    color: var(--color-danger, var(--color-error, crimson));
  }
  .sev-tag[data-sev='high'],
  .sev-chip[data-sev='high'] .sev-n {
    color: var(--color-warning, var(--color-blocked, orange));
  }
  .sev-tag[data-sev='medium'],
  .sev-chip[data-sev='medium'] .sev-n {
    color: var(--color-accent);
  }
  .sev-tag[data-sev='low'],
  .sev-chip[data-sev='low'] .sev-n {
    color: var(--color-text-muted);
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
    color: var(--color-warning, var(--color-blocked, orange));
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
    color: var(--color-warning, var(--color-blocked, orange));
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
