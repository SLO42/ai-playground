<script lang="ts">
  /**
   * /claude-code — harness hub, v0.1 READ-ONLY config catalog (UI-SPEC §313).
   *
   * Lists the Claude Code config mirror per scope (hooks / skills / agents / MCP
   * servers) with each scope's synced / out-of-sync state (UI-SPEC §214). All data
   * is LIVE from the cc_* mirror (F-008 — no fabricated rows); honest empty states
   * when nothing is synced or the DB isn't connected yet. Svelte 5 runes only.
   */
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import SessionTranscript from '$lib/components/shell/SessionTranscript.svelte';
  import { rowToTurn, interjectEventToTurn, type Turn } from '$lib/client/transcript-core';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const scopes = $derived(data.scopes ?? []);
  const connected = $derived(data.connected);
  const queryError = $derived(data.queryError);

  // ── TASK 9.3 — the cross-project SESSION FLEET (portfolio-wide live session control). ──
  // Every running/recent Claude Code session ACROSS ALL projects (F-008 live rows), with
  // project label, model/tier, status, live liveness (session.status), and per-session
  // controls (stop/interject/resume) over the loopback control endpoint (D-035).
  const fleet = $derived(data.fleet ?? []);
  const running = $derived(fleet.filter((s) => s.status === 'running'));
  const recent = $derived(fleet.filter((s) => s.status !== 'running'));

  // ── TASK (transcript-panel) — the LIVE read-only transcript the fleet's `transcript →`
  // link (/claude-code?session=<id>) lands on. The PERSISTED LT1 conversation (`message`
  // rows, oldest-first by seq) replays here, and a new persisted turn live-appends via the
  // `message` onDbChange below (scoped `app:transcript` dep — no invalidate storm). Read-only:
  // session controls already live on the fleet rows above; this introduces NO new control.
  const selectedSession = $derived(data.selectedSession ?? null);
  const transcript = $derived(data.transcript ?? []);
  const sessionMeta = $derived(data.sessionMeta ?? null);
  // `sessionMeta === null` while a session id IS selected = the session row was not found
  // (an unknown / never-launched id) — an honest state, not a fabricated header (F-008).
  const sessionUnknown = $derived(!!selectedSession && sessionMeta === null && transcript.length === 0);

  // The persisted rows → the shared kind-aware Turn shape (transcript-core). The collapsible
  // thinking state, tool-input formatting and briefing parse all live in <SessionTranscript>,
  // so this view and projects/[id] render identical framing — one kind-aware renderer, no
  // divergence (the projects/[id] view used to render `thinking` as assistant prose).
  const persistedTurns = $derived(transcript.map((m, i) => rowToTurn(m, i)));

  // GA2 — LIVE operator interjects pushed into the selected session. A channel push is
  // republished on the one bus as an `interject` event; we append it IMMEDIATELY as a
  // communication turn (shared `interjectEventToTurn` — same mapping projects/[id] uses) so a
  // pushed message appears the instant it streams, not only when the `message` db_change reload
  // lands. Keyed by the server message id, so once the reload brings the PERSISTED row (same id)
  // the live copy is de-duped away below — no double render, no fabrication (D-035a/F-008).
  let liveInterjects = $state<Turn[]>([]);
  // Subscribe per selected session; reset the live buffer on every selection change (a stale
  // session's interjects must never bleed into another transcript).
  $effect(() => {
    const sid = selectedSession;
    liveInterjects = [];
    if (!sid) return;
    let seq = 0;
    const off = stream.subscribeTopic<{
      origin?: string;
      steer?: boolean;
      messageId?: string;
      content?: string;
    }>('interject', sid, (d) => {
      const turn = interjectEventToTurn(d as Record<string, unknown>, seq);
      if (!turn) return;
      if (liveInterjects.some((t) => t.id === turn.id)) return; // idempotent (re-fire-safe)
      seq += 1;
      liveInterjects = [...liveInterjects, turn];
    });
    return off;
  });

  // The rendered turns: the persisted replay, then any live interject NOT yet in the persisted
  // set (deduped by the server message id — the reload-merge collapses the live copy once the
  // db_change pulls the persisted row).
  const transcriptTurns = $derived.by(() => {
    if (liveInterjects.length === 0) return persistedTurns;
    const seen = new Set(persistedTurns.map((t) => t.id));
    return [...persistedTurns, ...liveInterjects.filter((t) => !seen.has(t.id))];
  });

  // TASK 14.6 — the HONEST backend capability matrix (F-008): a control the wired
  // backend cannot really perform renders DISABLED with its reason, never a button
  // that claims to work and does nothing.
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

  // Per-session control state — keyed by session id so several rows can be in flight
  // independently. `interjectMsg` is the open interject draft; `busy`/`err` track the
  // last action's progress + failure per row (honest — never a fake success, F-008).
  let openInterject = $state<string | null>(null);
  let interjectMsg = $state('');
  let busyId = $state<string | null>(null);
  let controlErr = $state<Record<string, string>>({});

  function shortId(id: string): string {
    const i = id.indexOf(':');
    return i >= 0 ? id.slice(i + 1) : id;
  }

  function fmtTime(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  async function sendControl(
    sessionId: string,
    action: 'interject' | 'stop' | 'resume'
  ): Promise<void> {
    busyId = sessionId;
    controlErr = { ...controlErr, [sessionId]: '' };
    try {
      const sid = shortId(sessionId);
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          action === 'interject' ? { action, message: interjectMsg } : { action }
        )
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        controlErr = { ...controlErr, [sessionId]: j.message ?? `control failed (${res.status})` };
      } else if (action === 'interject') {
        interjectMsg = '';
        openInterject = null;
      }
      // The session_status / db_change events republished by the control endpoint
      // re-invalidate `app:fleet` below, so the row's live state updates in place.
    } catch (e) {
      controlErr = { ...controlErr, [sessionId]: (e as Error).message };
    } finally {
      busyId = null;
    }
  }

  // The editor is a single shared panel; `editing` identifies which scope+kind it's open for
  // so only that scope's card shows the panel. The action phases (editing → confirming →
  // saved) flow through `form.edit` (D-010 diff-and-confirm).
  let editing = $state<{ scopeId: string; kind: string } | null>(null);

  // The `form.edit` action result is a union across loadFile/planEdit/applyEdit (+ their
  // fail returns). Narrow it ONCE here into a plain, fully-typed view the template reads —
  // so the markup never wrestles the union (D-010 phases: editing → confirming → saved).
  interface EditView {
    phase: 'editing' | 'confirming' | 'saved' | 'error';
    error?: string;
    issues?: Array<{ path: string; message: string }>;
    claudeDir?: string;
    kind?: string;
    filePath?: string;
    content?: string;
    bytesWritten?: number;
    status?: string;
    validation?: { ok: boolean; issues: Array<{ path: string; message: string }> };
    diff?: { unchanged: boolean; hunks: Array<{ op: string; line: string }> };
    confirmToken?: string;
  }
  const edit = $derived.by((): EditView | null => {
    const e = form?.edit as Record<string, unknown> | null | undefined;
    if (!e) return null;
    const out: EditView = { phase: 'editing' };
    if ('error' in e) out.phase = 'error';
    if (typeof e.phase === 'string') out.phase = e.phase as EditView['phase'];
    if (typeof e.error === 'string') out.error = e.error;
    if (Array.isArray(e.issues)) out.issues = e.issues as EditView['issues'];
    if (typeof e.claudeDir === 'string') out.claudeDir = e.claudeDir;
    if (typeof e.kind === 'string') out.kind = e.kind;
    if (typeof e.filePath === 'string') out.filePath = e.filePath;
    if (typeof e.content === 'string') out.content = e.content;
    if (typeof e.bytesWritten === 'number') out.bytesWritten = e.bytesWritten;
    if (typeof e.status === 'string') out.status = e.status;
    if (e.validation) out.validation = e.validation as EditView['validation'];
    if (e.diff) out.diff = e.diff as EditView['diff'];
    if (typeof e.confirmToken === 'string') out.confirmToken = e.confirmToken;
    return out;
  });

  // Live: a cc_* re-sync after an apply changes the catalog — re-invalidate so the synced
  // badge updates in place. SCOPED (DEFECT 2): invalidate ONLY this page's `app:claude-code`
  // dep, never `() => true`. A `project` row change must NOT re-pull the whole catalog
  // through every loader on the page (the "invalidate storm") — it nudges just this loader.
  $effect(() => {
    const off = stream.onDbChange('project', () => void invalidate('app:claude-code'));
    // TASK 9.3 — a `session` row change (launch/stop/resume anywhere in the portfolio)
    // live-refreshes the cross-project fleet via its OWN scoped dep (`app:fleet`), so a
    // session moving never re-pulls the whole config catalog (no invalidate storm).
    const offS = stream.onDbChange('session', () => void invalidate('app:fleet'));
    // TASK (transcript-panel) — a `message` row change (a new persisted turn from the driven
    // session, OR a status change on it) live-refreshes ONLY the transcript via its OWN scoped
    // dep (`app:transcript`); it never re-pulls the config catalog or the fleet (no storm).
    // `message` is in WATCHED_TABLES (the static-scan test enforces every onDbChange table is).
    const offMsg = stream.onDbChange('message', () => void invalidate('app:transcript'));
    return () => {
      off();
      offS();
      offMsg();
    };
  });

  // ── Transcript replay grouping ──────────────────────────────────────────────────────────
  // The kind→turn mapping (incl. the pre-m0037 by-role fallback) lives in transcript-core's
  // rowToTurn / rowTurnKind; this view maps `transcript` → `transcriptTurns` above and renders
  // them through the shared <SessionTranscript> component.

  function statusLabel(s: string): string {
    if (s === 'synced') return 'synced';
    if (s === 'out_of_sync') return 'out of sync · edited on disk';
    return 'not synced';
  }

  // Which editable file kinds a scope offers (settings + the two siblings — the common set).
  const FILE_KINDS = [
    { kind: 'settings', label: 'settings.json' },
    { kind: 'claude_md', label: 'CLAUDE.md' },
    { kind: 'mcp_json', label: '.mcp.json' }
  ] as const;

  function openEditor(scopeId: string, kind: string): void {
    editing = { scopeId, kind };
  }
  function closeEditor(): void {
    editing = null;
  }
</script>

<svelte:head>
  <title>Claude Code — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">harness</span>
    <h1 class="title">Claude Code</h1>
    <p class="lede">
      Read-only catalog of the Claude Code config mirror — hooks, skills, agents,
      and MCP servers per scope. The filesystem is authoritative; this view mirrors
      <span class="mono">.claude/</span> + <span class="mono">.mcp.json</span> and
      flags drift when a file is edited on disk.
    </p>
  </header>

  <!-- ── TASK 9.3 — cross-project SESSION FLEET (portfolio-wide live session control). ──
       Running/recent Claude Code sessions ACROSS ALL projects with project label, model/tier,
       live status (session.status, not a pool flag), and per-session stop/interject/resume
       over the loopback control endpoint (D-035). Live over the one SSE. -->
  {#if connected}
    <section class="card fleet" aria-label="cross-project session fleet">
      <div class="fleet-head">
        <span class="eyebrow">session fleet · all projects</span>
        <span class="count mono">{running.length} running · {recent.length} recent</span>
      </div>
      {#if capsNote && fleet.length > 0}
        <!-- HONEST capability state (14.6/F-008): why some controls are disabled. -->
        <p class="caps-note mono">controls limited — {capsNote}</p>
      {/if}
      {#if fleet.length === 0}
        <p class="card-body none-body">
          No sessions across the portfolio yet — launch a Claude Code session from any
          project and it appears here, live.
        </p>
      {:else}
        <ul class="fleet-rows" aria-label="sessions across all projects">
          {#each [...running, ...recent] as s (s.id)}
            {@const isRunning = s.status === 'running'}
            <li class="fleet-row" class:running={isRunning}>
              <div class="fleet-main">
                <span class="sess-status" data-status={s.status}>{s.status}</span>
                {#if s.projectName}
                  {#if s.projectSlug}
                    <a class="proj" href={`/projects/${s.projectSlug}`}>{s.projectName}</a>
                  {:else}
                    <span class="proj">{s.projectName}</span>
                  {/if}
                {:else}
                  <span class="proj none-proj">no project</span>
                {/if}
                <span class="sess-model mono">{s.provider}/{s.modelId}</span>
                {#if s.tier}<span class="tier-tag" data-tier={s.tier}>{s.tier}</span>{/if}
                <span class="sess-id mono" title={s.id}>{shortId(s.id)}</span>
                <span class="sess-when mono">{fmtTime(s.startedAt)}</span>
              </div>

              <!-- Per-session controls (D-035 loopback control endpoint, operator origin). -->
              <!-- 14.6: each control is enabled ONLY when the backend really supports it
                   (honest capability matrix) — disabled-with-reason, never a dead button. -->
              <div class="sess-controls">
                {#if isRunning}
                  <button
                    class="ctl"
                    type="button"
                    aria-pressed={openInterject === s.id}
                    disabled={busyId === s.id || !caps.interject}
                    title={caps.interject
                      ? undefined
                      : (caps.reason ?? 'interject not supported by this backend')}
                    onclick={() =>
                      (openInterject = openInterject === s.id ? null : s.id)}>Interject</button
                  >
                  <button
                    class="ctl warn"
                    type="button"
                    disabled={busyId === s.id || !caps.stop}
                    title={caps.stop
                      ? undefined
                      : (caps.reason ?? 'stop not supported by this backend')}
                    onclick={() => sendControl(s.id, 'stop')}>Stop</button
                  >
                {:else}
                  <button
                    class="ctl"
                    type="button"
                    disabled={busyId === s.id || !caps.resume}
                    title={caps.resume
                      ? undefined
                      : (caps.reason ?? 'resume not supported by this backend')}
                    onclick={() => sendControl(s.id, 'resume')}>Resume</button
                  >
                {/if}
              </div>

              {#if isRunning && openInterject === s.id}
                <div class="interject-row">
                  <input
                    class="interject-input mono"
                    type="text"
                    bind:value={interjectMsg}
                    placeholder="Interject a message into this session…"
                    disabled={busyId === s.id}
                  />
                  <button
                    class="ctl primary"
                    type="button"
                    disabled={busyId === s.id || !interjectMsg.trim()}
                    onclick={() => sendControl(s.id, 'interject')}>Send</button
                  >
                </div>
              {/if}

              {#if controlErr[s.id]}
                <p class="ctl-error" role="alert">{controlErr[s.id]}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <!-- ── TASK (transcript-panel) — the LIVE read-only transcript the fleet's `transcript →`
       link (/claude-code?session=<id>) lands on. Renders the persisted LT1 conversation
       (`message` rows, oldest-first by seq): assistant prose, collapsible thinking (honest
       empty), tool calls (name + compact input) + their results, and the final result/status
       badge. Read-only — NO new control surface (stop/interject already live on the fleet).
       Live-appends a new turn via the `message` onDbChange → scoped `app:transcript` dep. -->
  {#if connected && selectedSession}
    <section class="card transcript-panel" aria-label="session transcript">
      <div class="tp-head">
        <div class="tp-id">
          <span class="eyebrow">transcript</span>
          <span class="tp-sid mono" title={selectedSession}>{shortId(selectedSession)}</span>
        </div>
        <div class="tp-meta">
          {#if sessionMeta}
            <span class="sess-status" data-status={sessionMeta.status}>{sessionMeta.status}</span>
            {#if sessionMeta.projectName}
              {#if sessionMeta.projectSlug}
                <a class="proj" href={`/projects/${sessionMeta.projectSlug}`}>{sessionMeta.projectName}</a>
              {:else}
                <span class="proj">{sessionMeta.projectName}</span>
              {/if}
            {/if}
            <span class="sess-model mono">{sessionMeta.provider}/{sessionMeta.modelId}</span>
            {#if sessionMeta.tier}
              <span class="tier-tag" data-tier={sessionMeta.tier}>{sessionMeta.tier}</span>
            {/if}
            <span class="sess-when mono">{fmtTime(sessionMeta.startedAt)}</span>
          {/if}
        </div>
      </div>

      <div class="transcript-log" role="log" aria-live="polite" aria-label="conversation transcript">
        {#if sessionUnknown}
          <!-- Honest unknown-session state (F-008): a valid-shaped id with no session row + no
               messages — never a fabricated transcript. -->
          <p class="tp-state">
            No session found for <span class="mono">{shortId(selectedSession)}</span> — it may have
            been cleared, or the id is stale.
          </p>
        {:else if transcriptTurns.length === 0}
          <!-- Honest empty: a real session that has not yet persisted (or live-streamed) any turn. -->
          <p class="tp-state">No transcript yet — turns appear here as the session runs.</p>
        {:else}
          <!-- KIND-AWARE replay via the shared component (briefing / thinking-collapsible /
               tool_use / tool_result / prose). The session's FINAL result/status is the badge
               in the panel header (sessionMeta.status) — the launch path persists done/error as
               session lifecycle, NOT a transcript `message` row (launch.ts), so there is no
               separate result turn here. This is the SAME renderer projects/[id] uses. -->
          <SessionTranscript turns={transcriptTurns} />
        {/if}
      </div>

      {#if sessionMeta?.status === 'running'}
        <p class="tp-foot mono" aria-live="polite">live — new turns append as the session runs</p>
      {:else if transcriptTurns.length > 0}
        <p class="tp-foot mono">{transcriptTurns.length} turn{transcriptTurns.length === 1 ? '' : 's'} · read-only replay</p>
      {/if}
    </section>
  {/if}

  {#if !connected}
    <div class="card empty">
      <span class="eyebrow">offline</span>
      <p class="card-body">
        The database is not connected — no mirror to read yet. Run a config sync
        once the runtime is wired.
      </p>
    </div>
  {:else if queryError}
    <div class="card empty">
      <span class="eyebrow">error</span>
      <p class="card-body">
        Connected, but the config mirror failed to load — <span class="mono">{queryError}</span>.
      </p>
    </div>
  {:else if scopes.length === 0}
    <div class="card empty">
      <span class="eyebrow">empty</span>
      <p class="card-body">
        No config scopes synced yet. Sync a project's
        <span class="mono">.claude/</span> directory to populate the catalog.
      </p>
    </div>
  {:else}
    <div class="scopes">
      {#each scopes as scope (scope.scopeId)}
        <article class="card scope">
          <div class="scope-head">
            <div class="scope-id">
              <span class="kind mono">{scope.kind}</span>
              <span class="path mono" title={scope.path}>{scope.path}</span>
            </div>
            <span class="status status-{scope.status}">{statusLabel(scope.status)}</span>
          </div>

          <div class="catalog">
            <!-- Hooks -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">hooks</span>
                <span class="count mono">{scope.hooks.length}</span>
              </div>
              {#if scope.hooks.length}
                <ul class="rows">
                  {#each scope.hooks as h, hi (h.event + '␟' + h.command + '␟' + hi)}
                    <li class="row">
                      <span class="tag mono">{h.event}</span>
                      {#if h.matcher}<span class="matcher mono">{h.matcher}</span>{/if}
                      <span class="cmd mono">{h.command}</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>

            <!-- Skills -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">skills</span>
                <span class="count mono">{scope.skills.length}</span>
              </div>
              {#if scope.skills.length}
                <ul class="rows">
                  {#each scope.skills as k (k.file_path)}
                    <li class="row">
                      <span class="name mono">{k.name}</span>
                      {#if k.plugin}<span class="tag mono">{k.plugin}</span>{/if}
                      {#if k.description}<span class="desc">{k.description}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>

            <!-- Agents -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">agents</span>
                <span class="count mono">{scope.agents.length}</span>
              </div>
              {#if scope.agents.length}
                <ul class="rows">
                  {#each scope.agents as a (a.file_path)}
                    <li class="row">
                      <span class="name mono">{a.name}</span>
                      {#if a.category}<span class="tag mono">{a.category}</span>{/if}
                      {#if a.description}<span class="desc">{a.description}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>

            <!-- MCP servers -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">mcp servers</span>
                <span class="count mono">{scope.mcpServers.length}</span>
              </div>
              {#if scope.mcpServers.length}
                <ul class="rows">
                  {#each scope.mcpServers as m (m.name)}
                    <li class="row">
                      <span class="name mono">{m.name}</span>
                      <span class="tag mono">{m.type}</span>
                      <span class="cmd mono">{m.command ?? m.url ?? ''}</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>
          </div>

          <!-- Job 9: config edit (D-010 diff + confirm). Filesystem stays authoritative. -->
          {#if scope.kind === 'project' || scope.kind === 'global'}
            <div class="edit-bar">
              <span class="eyebrow">edit config</span>
              {#each FILE_KINDS as fk (fk.kind)}
                <form
                  method="POST"
                  action="?/loadFile"
                  use:enhance={() => {
                    openEditor(scope.scopeId, fk.kind);
                    return async ({ update }) => update({ reset: false });
                  }}
                >
                  <input type="hidden" name="kind" value={fk.kind} />
                  <input type="hidden" name="claudeDir" value={scope.path} />
                  <input type="hidden" name="scopeKind" value={scope.kind} />
                  {#if scope.project}<input type="hidden" name="project" value={scope.project} />{/if}
                  <button
                    class="edit-btn"
                    type="submit"
                    aria-pressed={editing?.scopeId === scope.scopeId && editing?.kind === fk.kind}
                    >{fk.label}</button
                  >
                </form>
              {/each}
            </div>

            {#if (editing?.scopeId === scope.scopeId) || (edit?.claudeDir === scope.path)}
              {@const k = edit?.kind ?? editing?.kind ?? 'settings'}
              <div class="editor" aria-label="config editor">
                <div class="editor-head">
                  <span class="mono">{k}</span>
                  {#if edit && 'filePath' in edit && edit.filePath}
                    <span class="path mono" title={edit.filePath}>{edit.filePath}</span>
                  {/if}
                  <button class="edit-btn" type="button" onclick={closeEditor}>close</button>
                </div>

                {#if edit?.error}
                  <p class="form-error" role="alert">{edit.error}</p>
                  {#if edit.issues}
                    <ul class="issues">
                      {#each edit.issues as iss (iss.path + iss.message)}
                        <li class="mono"><b>{iss.path}</b> — {iss.message}</li>
                      {/each}
                    </ul>
                  {/if}
                {/if}

                {#if edit?.phase === 'saved'}
                  <p class="form-ok">
                    Config saved — {edit.bytesWritten} bytes · mirror {edit.status}
                  </p>
                {/if}

                <!-- The edit form: textarea content → planEdit (diff) → applyEdit (confirm). -->
                {#if edit && edit.phase !== 'saved'}
                  <form
                    method="POST"
                    action="?/planEdit"
                    use:enhance={() => async ({ update }) => update({ reset: false })}
                  >
                    <input type="hidden" name="kind" value={k} />
                    <input type="hidden" name="claudeDir" value={scope.path} />
                    <input type="hidden" name="scopeKind" value={scope.kind} />
                    {#if scope.project}<input type="hidden" name="project" value={scope.project} />{/if}
                    {#if edit.filePath}<input type="hidden" name="filePath" value={edit.filePath} />{/if}
                    <textarea class="editor-area mono" name="content" rows="12">{edit.content ?? ''}</textarea>
                    <div class="editor-actions">
                      <button class="edit-btn primary" type="submit">Review diff</button>
                    </div>
                  </form>
                {/if}

                <!-- The confirm step: show the diff + a confirm button bound to the token. -->
                {#if edit?.phase === 'confirming' && edit.diff && edit.validation}
                  <div class="diff" aria-label="config diff">
                    {#if edit.diff.unchanged}
                      <p class="state-body">No changes — the proposed content matches disk.</p>
                    {:else}
                      <pre class="diff-pre mono">{#each edit.diff.hunks as h, i (i)}<span
                            class="hunk"
                            data-op={h.op}>{h.op} {h.line}
</span>{/each}</pre>
                    {/if}
                  </div>
                  {#if !edit.validation.ok}
                    <p class="form-error" role="alert">
                      Validation failed — fix the issues before saving:
                    </p>
                    <ul class="issues">
                      {#each edit.validation.issues as iss (iss.path + iss.message)}
                        <li class="mono"><b>{iss.path}</b> — {iss.message}</li>
                      {/each}
                    </ul>
                  {/if}
                  <form
                    method="POST"
                    action="?/applyEdit"
                    use:enhance={() => async ({ update }) => update({ reset: false })}
                  >
                    <input type="hidden" name="kind" value={k} />
                    <input type="hidden" name="claudeDir" value={scope.path} />
                    <input type="hidden" name="scopeKind" value={scope.kind} />
                    {#if scope.project}<input type="hidden" name="project" value={scope.project} />{/if}
                    {#if edit.filePath}<input type="hidden" name="filePath" value={edit.filePath} />{/if}
                    <input type="hidden" name="content" value={edit.content ?? ''} />
                    <input type="hidden" name="confirmToken" value={edit.confirmToken ?? ''} />
                    <div class="editor-actions">
                      <button
                        class="edit-btn primary"
                        type="submit"
                        disabled={!edit.validation.ok || edit.diff.unchanged}>Confirm &amp; save</button
                      >
                    </div>
                  </form>
                {/if}
              </div>
            {/if}
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

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
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    max-width: 70ch;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card, 1rem);
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .card-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .scopes {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .scope {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .scope-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .scope-id {
    display: flex;
    align-items: baseline;
    gap: var(--space-3, 0.75rem);
    min-width: 0;
  }
  .kind {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-accent);
  }
  .path {
    font-size: 0.8rem;
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Sync-state chips (UI-SPEC §214). */
  .status {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.55rem;
    border-radius: var(--radius-sm, 6px);
    white-space: nowrap;
  }
  .status-synced {
    color: var(--color-success);
    background: var(--color-success-bg);
  }
  .status-out_of_sync {
    color: var(--color-warn);
    background: var(--color-warn-bg);
  }
  .status-unsynced {
    color: var(--color-blocked);
    background: var(--color-blocked-bg);
  }
  .catalog {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-4, 1rem);
  }
  .cat {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    min-width: 0;
  }
  .cat-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-border-faint, var(--color-border));
    padding-bottom: var(--space-1, 0.25rem);
  }
  .count {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.78rem;
    padding: 0.25rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    min-width: 0;
  }
  .name {
    color: var(--color-text);
    font-weight: 500;
  }
  .tag {
    font-size: 0.68rem;
    color: var(--color-accent);
    background: var(--color-accent-muted, transparent);
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm, 6px);
  }
  .matcher {
    font-size: 0.7rem;
    color: var(--color-text-2);
  }
  .cmd {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1 1 auto;
  }
  .desc {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    flex: 1 1 100%;
  }
  .none {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    font-style: italic;
  }

  /* ── Job-9 config editor (D-010 diff + confirm) ──────────────────────────── */
  .edit-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
    border-top: 1px solid var(--color-border-faint, var(--color-border));
    padding-top: var(--space-3, 0.75rem);
  }
  .edit-bar form {
    display: contents;
  }
  .edit-btn {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    min-height: 24px;
  }
  .edit-btn:hover {
    background: var(--color-surface-card);
  }
  .edit-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .edit-btn[aria-pressed='true'] {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  .edit-btn.primary {
    background: var(--color-accent);
    color: var(--color-text-inverse, var(--color-bg, #03120e));
    border-color: var(--color-accent);
  }
  .edit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-3, 0.75rem);
    background: var(--color-surface-overlay);
  }
  .editor-head {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }
  .editor-head .path {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.72rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .editor-area {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    background: var(--color-bg, #03120e);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.6rem 0.7rem;
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .editor-area:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .editor-actions {
    display: flex;
    gap: var(--space-2, 0.5rem);
    margin-top: var(--space-2, 0.5rem);
  }
  .diff {
    max-height: 18rem;
    overflow: auto;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-bg, #03120e);
  }
  .diff-pre {
    margin: 0;
    padding: 0.5rem 0.7rem;
    font-size: 0.76rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .hunk[data-op='+'] {
    color: var(--color-success, #6fae6f);
  }
  .hunk[data-op='-'] {
    color: var(--color-error);
  }
  .hunk[data-op=' '] {
    color: var(--color-text-muted);
  }
  .issues {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.74rem;
    color: var(--color-error);
  }
  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error);
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }

  /* ── TASK 9.3 — cross-project session fleet (tokens-only; a11y AA; reduced-motion safe) ── */
  .fleet {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .fleet-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }
  .count {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }
  .none-body {
    font-style: italic;
  }
  .fleet-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .fleet-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: 0.55rem 0.7rem;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .fleet-row.running {
    border-color: var(--color-running, var(--color-success, #2a9d4a));
  }
  .fleet-main {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
  }
  .sess-status {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: lowercase;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-card);
    white-space: nowrap;
    flex: none;
  }
  .sess-status[data-status='running'] {
    color: var(--color-running, var(--color-success, #2a9d4a));
  }
  .sess-status[data-status='done'],
  .sess-status[data-status='shipped'] {
    color: var(--color-success, var(--color-running));
  }
  .sess-status[data-status='failed'] {
    color: var(--color-error-on-overlay);
  }
  .sess-status[data-status='cancelled'],
  .sess-status[data-status='blocked'] {
    color: var(--color-blocked, var(--color-warn, orange));
  }
  .proj {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--color-text);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 16rem;
  }
  a.proj:hover {
    color: var(--color-accent);
    text-decoration: underline;
  }
  a.proj:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-xs, 3px);
  }
  .none-proj {
    color: var(--color-text-muted);
    font-style: italic;
    font-weight: 400;
  }
  .sess-model {
    font-size: 0.74rem;
    color: var(--color-text-2);
  }
  .tier-tag {
    font-size: 0.66rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text);
    flex: none;
  }
  .tier-tag[data-tier='opus'] {
    color: var(--color-tier-opus, var(--color-accent));
  }
  .tier-tag[data-tier='sonnet'] {
    color: var(--color-tier-sonnet, var(--color-accent));
  }
  .tier-tag[data-tier='haiku'] {
    color: var(--color-tier-haiku, var(--color-text-muted));
  }
  .tier-tag[data-tier='local'] {
    color: var(--color-tier-local, var(--color-text-muted));
  }
  .sess-id {
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .sess-when {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .sess-controls {
    display: flex;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  /* 14.6 — honest capability note: why some controls render disabled (F-008). */
  .caps-note {
    margin: var(--space-2, 0.5rem) 0 0;
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .ctl {
    appearance: none;
    background: var(--color-surface-card);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.2rem 0.7rem;
    cursor: pointer;
    min-height: 24px;
  }
  .ctl:hover:not(:disabled) {
    background: var(--color-surface-overlay);
  }
  .ctl:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .ctl:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ctl[aria-pressed='true'] {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  .ctl.primary {
    background: var(--color-accent);
    color: var(--color-text-inverse, var(--color-bg, #03120e));
    border-color: var(--color-accent);
  }
  .ctl.warn {
    /* -on-overlay tint stays BODY AA even on the overlay hover face (14.3) */
    color: var(--color-error-on-overlay);
    border-color: var(--color-error);
  }
  .interject-row {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }
  .interject-input {
    flex: 1 1 auto;
    min-width: 0;
    appearance: none;
    background: var(--color-bg, #03120e);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.35rem 0.6rem;
    font-size: 0.76rem;
    min-height: 24px;
  }
  .interject-input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .ctl-error {
    font: var(--type-body-sm);
    color: var(--color-error);
    margin: 0;
  }

  /* ── TASK (transcript-panel) — live read-only transcript (tokens-only; a11y AA; reduced-motion safe) ── */
  .transcript-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .tp-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .tp-id {
    display: flex;
    align-items: baseline;
    gap: var(--space-2, 0.5rem);
    min-width: 0;
  }
  .tp-sid {
    font-size: 0.8rem;
    color: var(--color-text);
  }
  .tp-meta {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .tp-state {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    font-style: italic;
    margin: 0;
  }
  .transcript-log {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    max-height: 32rem;
    overflow: auto;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-bg, #03120e);
    padding: var(--space-3, 0.75rem);
  }
  /* The kind-aware turn framing (.tp-turn / .tp-tag / thinking / tool / briefing) lives in the
     shared <SessionTranscript> component — both this view and projects/[id] render through it. */
  .tp-foot {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    margin: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .transcript-log {
      scroll-behavior: auto;
    }
  }
</style>
