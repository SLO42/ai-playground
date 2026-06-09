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
  const selectedSession = $derived(data.selectedSession);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // The slug segment for child routes (the [id] param is the bare slug, not `project:slug`).
  const slug = $derived(page.params.id);
  const releaseHref = $derived(`/projects/${slug}/release`);
  const projectName = $derived(project?.name ?? slug);

  type Tab = 'plan' | 'sessions' | 'release';
  let tab = $state<Tab>('plan');
  // Default to the Sessions tab when a session is selected via ?session=.
  $effect(() => {
    if (selectedSession) tab = 'sessions';
  });

  // Live updates: a project/task/session row change re-runs the server loader. SSR-safe —
  // $effect runs only in the browser, and the handlers are torn down on unmount.
  $effect(() => {
    const offP = stream.onDbChange('project', () => void invalidate('app:projects'));
    const offT = stream.onDbChange('task', () => void invalidate('app:tasks'));
    const offS = stream.onDbChange('session', () => void invalidate('app:fleet'));
    return () => {
      offP();
      offT();
      offS();
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

  function fmtTime(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
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
        aria-pressed={tab === 'plan'}
        data-active={tab === 'plan'}
        onclick={() => (tab = 'plan')}>Plan</button
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
        aria-pressed={tab === 'release'}
        data-active={tab === 'release'}
        onclick={() => (tab = 'release')}>Release</button
      >
    </nav>

    {#if tab === 'plan'}
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

        <div class="card">
          <h2 class="section-title">Roadmap</h2>
          {#if releases.length === 0 && phases.length === 0 && features.length === 0 && sprints.length === 0}
            <p class="state-body">No plan hierarchy yet — releases, phases and features will appear here.</p>
          {:else}
            <div class="grid-two">
              <div class="col">
                <h3 class="sub">Releases</h3>
                {#if releases.length === 0}
                  <p class="state-body">None.</p>
                {:else}
                  <ul class="rows">
                    {#each releases as r (r.id)}
                      <li class="row">
                        <span class="mono">{r.version}</span>
                        {#if r.title}<span class="row-title">{r.title}</span>{/if}
                        <span class="status" data-status={r.status}>{r.status}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
              <div class="col">
                <h3 class="sub">Phases</h3>
                {#if phases.length === 0}
                  <p class="state-body">None.</p>
                {:else}
                  <ul class="rows">
                    {#each phases as ph (ph.id)}
                      <li class="row">
                        <span class="row-title">{ph.name}</span>
                        <span class="status" data-status={ph.status}>{ph.status}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
              <div class="col">
                <h3 class="sub">Features</h3>
                {#if features.length === 0}
                  <p class="state-body">None.</p>
                {:else}
                  <ul class="rows">
                    {#each features as f (f.id)}
                      <li class="row">
                        <span class="row-title">{f.title}</span>
                        <span class="status" data-status={f.status}>{f.status}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
              <div class="col">
                <h3 class="sub">Sprints</h3>
                {#if sprints.length === 0}
                  <p class="state-body">None.</p>
                {:else}
                  <ul class="rows">
                    {#each sprints as s (s.id)}
                      <li class="row"><span class="row-title">{s.name}</span></li>
                    {/each}
                  </ul>
                {/if}
              </div>
            </div>
          {/if}
        </div>

        <div class="card">
          <h2 class="section-title">Open tasks <span class="count mono">{tasks.length}</span></h2>
          {#if tasks.length === 0}
            <p class="state-body">No tasks yet for this project.</p>
          {:else}
            <ul class="rows" aria-label="tasks">
              {#each tasks as t (t.id)}
                <li class="row">
                  <span class="row-title">{t.title}</span>
                  <span class="status" data-status={t.status}>{t.status}</span>
                  <span class="prio mono">{t.priority}</span>
                </li>
              {/each}
            </ul>
          {/if}
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
    {:else}
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
  .grid-two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-4, 1rem);
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    min-width: 0;
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
</style>
