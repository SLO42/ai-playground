<script lang="ts">
  /**
   * /projects/[id]/tasks — the full-page task board + per-task detail (TASK-BOARD-SPEC §5, P3).
   *
   * The operator's ask was an Asana-shaped board: every card says WHAT the task is and WHY it
   * exists, and one click opens everything the row stores. The project page's inline kanban keeps
   * its slim quick-glance shape; this is the surface that renders the §4.1 fields — objective,
   * purpose, acceptance criteria, provenance, the proposal links, the fingerprint — which have been
   * stored and panel-validated since TASK 16.4 and shown nowhere.
   *
   * Live (D-005 / UI-SPEC §1.2): the ONE `task` SSE watcher re-invalidates `app:tasks`, which is
   * the same key this route's loader `depends` on — reuse of the existing channel, no polling and
   * no new push seam.
   *
   * Honesty (F-008): every count is taken from the array rendered beside it (see
   * `task-board-view.ts`'s counts note); an absent field renders an honest '—' or is omitted with a
   * named "not recorded" line — never an empty heading implying the operator left it blank.
   *
   * Svelte 5 runes only; `{@const}` appears solely as an immediate child of `{#each}`/`{#if}`
   * (F-011); tokens only (D-034).
   */
  import { enhance } from '$app/forms';
  import { invalidate, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { stream } from '$lib/client/stream.svelte';
  import { relativeTime, absoluteTime } from '$lib/client/time-format';
  import { shortRef } from '$lib/shared/naming';
  import {
    applyBoardViewToParams,
    columnCountLabel,
    completenessHint,
    contextCompleteness,
    filterSummary,
    isBoardChipDisabled,
    parseBoardView,
    resolveBoard,
    linkLabel,
    originLabel,
    type BoardTask,
    type BoardView
  } from './task-board-view';
  import type { PageData } from './$types';

  let { data, form }: { data: PageData; form: Record<string, unknown> | null } = $props();

  const connected = $derived(data.connected);
  const loadError = $derived(data.error);
  const slug = $derived(data.slug);
  const projectName = $derived(data.projectName ?? slug);
  const tasks = $derived(data.tasks as BoardTask[]);
  const statuses = $derived(data.taskStatuses);
  const priorities = $derived(data.taskPriorities);
  const sprintReality = $derived(data.sprintReality);
  const backHref = $derived(`/projects/${slug}`);

  /** The action envelope this route's actions return (`{ board: … }`). */
  const feedback = $derived(
    (form?.board ?? null) as
      | { error?: string; ok?: true; action?: string; to?: string; tagCount?: number; priority?: string }
      | null
  );

  // ── The view lives in the URL (shareable, survives a reload) ───────────────────────────────
  //
  // Filter changes are written with `replaceState`, which updates the address bar WITHOUT re-running
  // the loader — so a filter click cannot trigger an invalidate storm. `replaceState` never writes
  // `page.url` (kit client.js), so the re-seed below keys on the href actually CHANGING: a
  // republished `page` (this route invalidates on every `task` row change) carries an identical
  // href and adopts nothing, which is what keeps the live stream from wiping the operator's filter.
  // The exact defect and its measurement are recorded in `/claude-code`'s `reseedFleetView`.
  let view = $state<BoardView>(parseBoardView(page.url.searchParams));
  let seededHref = $state(page.url.href);

  $effect(() => {
    const href = page.url.href;
    if (href === seededHref) return;
    seededHref = href;
    view = parseBoardView(page.url.searchParams);
  });

  /** Board params only — deterministic, and unrelated params on this route do not exist. */
  function hrefFor(patch: Partial<BoardView>): string {
    const params = applyBoardViewToParams(new URLSearchParams(), { ...view, ...patch });
    const q = params.toString();
    return q ? `?${q}` : `/projects/${slug}/tasks`;
  }

  /** Apply a filter patch and mirror it into the address bar (no loader round-trip). */
  function setView(patch: Partial<BoardView>): void {
    view = { ...view, ...patch };
    const params = applyBoardViewToParams(new URLSearchParams(), view);
    const q = params.toString();
    replaceState(q ? `?${q}` : `/projects/${slug}/tasks`, page.state);
  }

  function toggleTag(tag: string): void {
    const on = view.tags.includes(tag);
    setView({ tags: on ? view.tags.filter((t) => t !== tag) : [...view.tags, tag] });
  }

  function clearFilters(): void {
    setView({ query: '', tags: [], priority: null, origin: null, status: null });
  }

  const board = $derived(resolveBoard(tasks, view, statuses, priorities));
  const selection = $derived(board.selection);
  const activeFilters = $derived(filterSummary(view));

  // ONE shared clock for every relative age on the page — a single 1s interval, never per-card
  // timers. Torn down on unmount.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });

  // Live: a `task` row change re-invalidates THIS loader (the same `app:tasks` key the project
  // page's inline board uses) so the columns reorder in place. REUSE of the one SSE surface.
  $effect(() => {
    const off = stream.onDbChange('task', () => void invalidate('app:tasks'));
    return () => off();
  });

  let busy = $state(false);
  function submitting() {
    busy = true;
    return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await update({ reset: false });
      busy = false;
    };
  }
</script>

<svelte:head>
  <title>Task board · {projectName} — Atelier</title>
</svelte:head>

<div class="page">
  <header class="head">
    <div class="crumbs">
      <a class="link-inline" href={backHref}>← {projectName}</a>
    </div>
    <h1 class="title">Task board</h1>
    <p class="lede">
      Every task on this project, grouped by status, with the metadata the executing model is given:
      what it is, why it exists, how it will be judged, and the tags that remind an agent how to
      handle it. Open a card for everything the row stores.
    </p>
  </header>

  {#if !connected}
    <!-- DB-down / load failure — honest and NAMED, never an empty board dressed as "no tasks". -->
    <div class="card state" role="status">
      <h2 class="section-title">Live data unavailable</h2>
      <p class="state-body">
        {#if loadError}
          The task board couldn't be read: {loadError}
        {:else}
          The database isn't connected. Start SurrealDB and this board resumes automatically.
        {/if}
      </p>
    </div>
  {:else}
    {#if feedback}
      {#if feedback.error}
        <p class="form-error" role="alert">{feedback.error}</p>
      {:else if feedback.action === 'move'}
        <p class="form-ok" role="status">Moved task to {feedback.to}.</p>
      {:else if feedback.action === 'retag'}
        <p class="form-ok" role="status">
          {Number(feedback.tagCount) === 0
            ? 'Tags cleared.'
            : `Tags saved (${Number(feedback.tagCount)}).`}
        </p>
      {:else if feedback.action === 'priority'}
        <p class="form-ok" role="status">Priority set to {feedback.priority}.</p>
      {/if}
    {/if}

    {#if board.total === 0}
      <div class="card state">
        <h2 class="section-title">No tasks yet</h2>
        <p class="state-body">
          This project has no tasks. Add the first one from the
          <a class="link-inline" href={`${backHref}?tab=tasks`}>project page's Tasks tab</a> and it
          appears here, live.
        </p>
      </div>
    {:else}
      <!-- FILTERS. Every option is derived from the LOADED rows and carries its real count, so the
           operator is never offered a narrowing filter that cannot match (F-008). -->
      <section class="card filters" aria-label="Filter tasks">
        <div class="filter-row">
          <label class="field">
            <span class="field-label">Search titles</span>
            <input
              id="board-q"
              class="input"
              type="search"
              value={view.query}
              placeholder="title contains…"
              oninput={(e) => setView({ query: e.currentTarget.value })}
            />
          </label>

          <label class="field">
            <span class="field-label">Priority</span>
            <select
              id="board-prio"
              class="input"
              value={view.priority ?? ''}
              onchange={(e) => setView({ priority: e.currentTarget.value || null })}
            >
              <!-- The WIDENING option is a measured count too: clearing priority while a tag filter
                   stands may still show 0, and this control has to say so (see BoardClearedCounts —
                   it read a hardcoded total beside an empty board on 2026-08-05). -->
              <option value="">any ({board.clearedCounts.priority})</option>
              {#each board.priorityOptions as o (o.value)}
                <option value={o.value}>{o.label} ({o.count}){o.stale ? ' — none match' : ''}</option>
              {/each}
            </select>
          </label>

          <label class="field">
            <span class="field-label">Origin</span>
            <select
              id="board-origin"
              class="input"
              value={view.origin ?? ''}
              onchange={(e) => setView({ origin: e.currentTarget.value || null })}
            >
              <option value="">any ({board.clearedCounts.origin})</option>
              {#each board.originOptions as o (o.value)}
                <option value={o.value}
                  >{originLabel(o.label)} ({o.count}){o.stale ? ' — none match' : ''}</option
                >
              {/each}
            </select>
          </label>

          <label class="field">
            <span class="field-label">Status</span>
            <select
              id="board-status"
              class="input"
              value={view.status ?? ''}
              onchange={(e) => setView({ status: e.currentTarget.value || null })}
            >
              <option value="">every column ({board.clearedCounts.status})</option>
              {#each board.statusOptions as o (o.value)}
                <option value={o.value}>{o.label} ({o.count}){o.stale ? ' — none match' : ''}</option>
              {/each}
            </select>
          </label>
        </div>

        {#if board.tagOptions.length}
          <div class="chips" role="group" aria-label="Filter by tag (tags combine with AND)">
            {#each board.tagOptions as o (o.value)}
              {@const active = view.tags.includes(o.value)}
              <button
                type="button"
                class="chip"
                data-active={active}
                aria-pressed={active}
                disabled={isBoardChipDisabled(o.count, active)}
                title={active
                  ? `showing tasks tagged ${o.value}`
                  : `add ${o.value} — tags combine with AND`}
                onclick={() => toggleTag(o.value)}
              >
                {o.label}
                <span class="chip-n mono">{o.count}</span>
              </button>
            {/each}
            {#if view.tags.length}
              <!-- The tag axis gets the same WIDENING affordance the selects have, with the same
                   measured count: dropping every tag while priority/origin/status stand may still
                   show 0, so the number is computed, never assumed to be the board total. -->
              <button
                type="button"
                class="chip"
                title="drop every tag filter — the other filters stay"
                onclick={() => setView({ tags: [] })}
              >
                any tag
                <span class="chip-n mono">{board.clearedCounts.tags}</span>
              </button>
            {/if}
          </div>
        {/if}

        <div class="filter-foot">
          <!-- HONEST COUNTS: `showing N of M` is taken from the same array the columns render, and
               what the filters HIDE is stated as its own named quantity — never as the numerator of
               a second "N of M" (the inversion that shipped once already). -->
          <p class="summary mono">{board.summaryLine}</p>
          {#if board.filtered}
            <button type="button" class="btn small" onclick={clearFilters}>Clear filters</button>
          {/if}
        </div>

        {#if board.staleFilter}
          <p class="stale-note" role="status">
            A filter in the address bar matches no task on this board — it may come from a shared or
            stale link. Clear filters to see everything.
          </p>
        {/if}

        <!-- The other half of the operator's 2026-07-26 question, answered with measurements. -->
        <p class="sprint-note">
          <strong>Sprints don't group these tasks.</strong>
          A <code>sprint</code> row stores only a name and optional start/end dates — a task carries no
          sprint link, so a sprint holds no tasks, goals or tickets. This project has
          {sprintReality.total === 0 ? 'no sprint rows' : `${sprintReality.total} sprint row${sprintReality.total === 1 ? '' : 's'}`}{#if sprintReality.total > 0}, {sprintReality.timeBoxed}
            of them time-boxed{/if}. Tags are the grouping that actually exists — and they reach the
          agent.
        </p>
      </section>

      <div class="board-layout" class:has-detail={!!selection.requested}>
        {#if board.filteredEmpty}
          <!-- Honest FILTERED-empty — a different fact from "no tasks exist". Names WHY. -->
          <div class="card state" role="status">
            <h2 class="section-title">No task matches these filters</h2>
            <p class="state-body">
              {board.total} task{board.total === 1 ? '' : 's'} on this board, none matching
              {activeFilters}. Clear filters to see them.
            </p>
          </div>
        {:else}
          <div class="board" aria-label="task board">
            {#each board.columns as col (col.status)}
              <section class="board-col" aria-label={`${col.status} column`}>
                <header class="board-col-head">
                  <span class="status" data-status={col.status}>{col.status}</span>
                  <!-- The first number is ALWAYS what is rendered below; the pair only appears when
                       a filter is engaged, and it is composed in one place (columnCountLabel). -->
                  <span
                    class="count mono"
                    title={board.filtered
                      ? `${col.shown} shown here · ${col.hidden} hidden by filters · ${col.total} in this status`
                      : `${col.total} in this status`}>{columnCountLabel(col, board.filtered)}</span
                  >
                </header>

                {#if col.tasks.length === 0}
                  <p class="board-empty">
                    {board.filtered && col.total > 0 ? `${col.total} hidden` : '—'}
                  </p>
                {:else}
                  <ul class="board-cards">
                    {#each col.tasks as t (t.id)}
                      {@const ctx = contextCompleteness(t)}
                      <li class="board-card" class:selected={selection.task?.id === t.id}>
                        <a class="card-title" href={hrefFor({ task: t.id })}>{t.title}</a>

                        {#if t.objective}
                          <p class="card-objective">{t.objective}</p>
                        {/if}

                        {#if t.tags.length}
                          <ul class="card-tags" aria-label="tags">
                            {#each t.tags as tag (tag)}
                              <li class="card-tag mono">{tag}</li>
                            {/each}
                          </ul>
                        {/if}

                        <div class="card-foot">
                          <span class="prio mono" data-prio={t.priority}>{t.priority}</span>
                          <span class="origin mono" title={`origin: ${t.origin}`}>{originLabel(t.origin)}</span>
                          <!-- Counts ONLY the fields really present on the row (TB-10); the tooltip
                               names the missing ones so `1/3` is explainable, never a score. -->
                          <span
                            class="ctx mono"
                            data-full={ctx.have === ctx.of}
                            title={completenessHint(ctx)}>why/how {ctx.have}/{ctx.of}</span
                          >
                          <span class="when mono" title={absoluteTime(t.createdAt)}
                            >{relativeTime(t.createdAt, now)}</span
                          >
                        </div>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>
            {/each}
          </div>
        {/if}

        {#if selection.requested}
          <aside class="card detail" aria-label="Task detail">
            {#if !selection.task}
              <!-- Honest not-found INSIDE the panel (§5.2): a shared link to a task that is not on
                   this board must say so rather than render an empty shell. -->
              <div class="detail-head">
                <h2 class="section-title">Task not on this board</h2>
                <a class="link-inline" href={hrefFor({ task: null })}>Close</a>
              </div>
              <p class="state-body">
                <span class="mono">{selection.requested}</span> is not among this project's
                {board.total} task{board.total === 1 ? '' : 's'}. It may belong to another project, or
                it may never have existed.
              </p>
            {:else}
              {@const t = selection.task}
              {@const ctx = contextCompleteness(t)}
              <div class="detail-head">
                <h2 class="section-title">{t.title}</h2>
                <a class="link-inline" href={hrefFor({ task: null })}>Close</a>
              </div>

              <div class="detail-badges">
                <span class="status" data-status={t.status}>{t.status}</span>
                <span class="prio mono" data-prio={t.priority}>{t.priority}</span>
                <span class="origin mono">{originLabel(t.origin)}</span>
                <span class="ctx mono" data-full={ctx.have === ctx.of} title={completenessHint(ctx)}
                  >why/how {ctx.have}/{ctx.of}</span
                >
              </div>

              <!-- ── WHY & HOW — the §4.1 fields, each with a named absence ─────────────── -->
              <section class="detail-block">
                <h3 class="detail-h">Objective</h3>
                {#if t.objective}
                  <p class="detail-text">{t.objective}</p>
                {:else}
                  <p class="detail-absent">Not recorded — the agent receives no objective section.</p>
                {/if}
              </section>

              <section class="detail-block">
                <h3 class="detail-h">Why this task</h3>
                {#if t.purpose}
                  <p class="detail-text">{t.purpose}</p>
                {:else}
                  <p class="detail-absent">Not recorded — the agent receives no purpose section.</p>
                {/if}
              </section>

              <section class="detail-block">
                <h3 class="detail-h">Acceptance criteria</h3>
                {#if t.acceptanceCriteria.length}
                  <ol class="detail-criteria">
                    {#each t.acceptanceCriteria as c, i (i)}
                      <li>{c}</li>
                    {/each}
                  </ol>
                {:else}
                  <p class="detail-absent">None stored — nothing defines "done" for this task yet.</p>
                {/if}
              </section>

              <!-- ── The immutable run seed (D-008) — labelled as such, never editable ──── -->
              <section class="detail-block">
                <h3 class="detail-h">
                  Description <span class="detail-h-note">— the immutable run seed (D-008)</span>
                </h3>
                <pre class="detail-seed">{t.description}</pre>
              </section>

              <!-- ── EDITABLE metadata (tags · priority) ────────────────────────────────── -->
              <section class="detail-block">
                <h3 class="detail-h">Tags <span class="detail-h-note">— sent to the agent</span></h3>
                <form
                  method="POST"
                  action="?/retagTask"
                  class="detail-form"
                  use:enhance={submitting}
                >
                  <input type="hidden" name="taskId" value={t.id} />
                  <label class="vh" for={`detail-tags-${t.id}`}>Tags for {t.title}</label>
                  <input
                    id={`detail-tags-${t.id}`}
                    class="input"
                    type="text"
                    name="tags"
                    value={t.tags.join(', ')}
                    placeholder="comma-separated; empty clears"
                  />
                  <button class="btn small" type="submit" disabled={busy}>Save tags</button>
                </form>
                <p class="detail-hint">
                  Up to 8 tags of 32 characters, lower-cased. They appear in the agent's
                  <span class="mono">## Task metadata</span> line — use them to remind it how to handle
                  the task.
                </p>
              </section>

              <section class="detail-block">
                <h3 class="detail-h">Priority</h3>
                <form
                  method="POST"
                  action="?/setPriority"
                  class="detail-form"
                  use:enhance={submitting}
                >
                  <input type="hidden" name="taskId" value={t.id} />
                  <label class="vh" for={`detail-prio-${t.id}`}>Priority for {t.title}</label>
                  <select id={`detail-prio-${t.id}`} class="input" name="priority" value={t.priority}>
                    {#each priorities as p (p)}
                      <option value={p}>{p}</option>
                    {/each}
                  </select>
                  <button class="btn small" type="submit" disabled={busy}>Set priority</button>
                </form>
              </section>

              <!-- ── STATUS — every move goes through setStatus's state machine (TB-4) ──── -->
              <section class="detail-block">
                <h3 class="detail-h">Status</h3>
                {#if t.moves.length}
                  <form method="POST" action="?/moveTask" class="detail-moves" use:enhance={submitting}>
                    <input type="hidden" name="taskId" value={t.id} />
                    {#each t.moves as to (to)}
                      <button class="btn small" type="submit" name="to" value={to} disabled={busy}
                        >→ {to}</button
                      >
                    {/each}
                  </form>
                {:else}
                  <p class="detail-absent">
                    <span class="mono">{t.status}</span> is terminal — rework spawns a new follow-up
                    task, so the audit trail and the run seed are preserved.
                  </p>
                {/if}
              </section>

              <!-- ── PROVENANCE — display-only. D-026 constrains PROMPTS, not operator UI. ─ -->
              <section class="detail-block">
                <h3 class="detail-h">Provenance</h3>
                {#if t.provenanceKind || t.provenanceAuthority || t.provenanceEvidence.length || t.provenanceDetail.length}
                  <dl class="detail-kv">
                    {#if t.provenanceKind}
                      <dt>trigger</dt>
                      <dd class="mono">{t.provenanceKind}</dd>
                    {/if}
                    <!-- The authority IN FORCE when the proposal was made — stamped on every PM
                         proposal, and the field that answers "was this PM allowed to act on it?".
                         Absent ⇒ the row predates the stamp or was not PM-proposed. -->
                    {#if t.provenanceAuthority}
                      <dt>authority</dt>
                      <dd class="mono">{t.provenanceAuthority}</dd>
                    {/if}
                    {#if t.provenanceEvidence.length}
                      <dt>evidence</dt>
                      <dd>
                        <ul class="detail-list">
                          {#each t.provenanceEvidence as ev (ev)}
                            <li class="mono">{ev}</li>
                          {/each}
                        </ul>
                      </dd>
                    {/if}
                    {#each t.provenanceDetail as d (d.key)}
                      <dt>{d.key}</dt>
                      <dd class="mono">{d.value}</dd>
                    {/each}
                  </dl>
                  <p class="detail-hint">
                    Evidence is shown here but is deliberately kept OUT of the agent's prompt (D-026)
                    — it can quote scanner or external output. Only the trigger kind crosses.
                  </p>
                {:else}
                  <p class="detail-absent">
                    Not recorded — this task carries no trigger provenance (typical for a manually
                    created task).
                  </p>
                {/if}
              </section>

              <!-- ── LINKS + identifiers. Labels go through the shared naming composer. ─── -->
              <section class="detail-block">
                <h3 class="detail-h">Record</h3>
                <dl class="detail-kv">
                  <dt>id</dt>
                  <dd class="mono">{t.id}</dd>
                  <dt>created</dt>
                  <dd class="mono" title={absoluteTime(t.createdAt)}>
                    {t.createdAt ? relativeTime(t.createdAt, now) : '—'}
                  </dd>
                  <dt>updated</dt>
                  <dd class="mono" title={absoluteTime(t.updatedAt)}>
                    {t.updatedAt ? relativeTime(t.updatedAt, now) : '—'}
                  </dd>
                  <dt>parent</dt>
                  <dd>
                    {#if t.parent}
                      <a class="link-inline" href={hrefFor({ task: t.parent })}>{linkLabel(t.parent)}</a>
                    {:else}
                      <span class="detail-absent-inline">—</span>
                    {/if}
                  </dd>
                  <dt>proposed by</dt>
                  <dd>
                    {#if t.proposedBy}
                      {@const name = t.proposedByName ?? linkLabel(t.proposedBy)}
                      <!-- The loader JOINS the pm row's name, because `proposed_by` stores an opaque
                           auto-id and naming.ts's own rule is that such an id is NOT a name — the
                           composer returns '—' for one. So we prefer the joined name, and only when
                           there genuinely is none do we show the id alone, as an id: rendering
                           "— <id>" would read as a name followed by a qualifier, and calling a PM
                           the DB has named "unnamed" is a false claim about live data (F-008). -->
                      {#if name === '—'}
                        <span class="mono" title={t.proposedBy}>{shortRef(t.proposedBy)}</span>
                        <span class="detail-absent-inline">(unnamed)</span>
                      {:else}
                        <span>{name}</span>
                        <span class="mono dim" title={t.proposedBy}>{shortRef(t.proposedBy)}</span>
                      {/if}
                    {:else}
                      <span class="detail-absent-inline">—</span>
                    {/if}
                  </dd>
                  <dt>revision of</dt>
                  <dd>
                    {#if t.revisionOf}
                      <a class="link-inline" href={hrefFor({ task: t.revisionOf })}
                        >{linkLabel(t.revisionOf)}</a
                      >
                    {:else}
                      <span class="detail-absent-inline">—</span>
                    {/if}
                  </dd>
                  <dt>superseded by</dt>
                  <dd>
                    {#if t.supersededBy}
                      <a class="link-inline" href={hrefFor({ task: t.supersededBy })}
                        >{linkLabel(t.supersededBy)}</a
                      >
                    {:else}
                      <span class="detail-absent-inline">—</span>
                    {/if}
                  </dd>
                  <dt>fingerprint</dt>
                  <dd class="mono" title={t.proposalFingerprint ?? 'not recorded'}>
                    {t.proposalFingerprint ? shortRef(t.proposalFingerprint, 12) : '—'}
                  </dd>
                </dl>
                {#if t.status === 'proposed'}
                  <p class="detail-hint">
                    This task is a PM proposal. Its objective, purpose and criteria are PM-owned and
                    change only through the revise loop on the
                    <a class="link-inline" href={`${backHref}?tab=pm`}>project's PM tab</a> — not from
                    this board.
                  </p>
                {/if}
              </section>
            {/if}
          </aside>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1.25rem);
    padding: var(--space-5, 1.5rem);
    width: 100%;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .crumbs {
    font-size: var(--text-sm, 0.875rem);
  }
  .title {
    margin: 0;
    font-family: var(--font-display, var(--font-sans));
    font-size: var(--text-2xl, 1.5rem);
    color: var(--color-text);
  }
  .lede {
    margin: 0;
    color: var(--color-text-2);
    max-width: 78ch;
    font-size: var(--text-sm, 0.875rem);
  }
  .link-inline {
    color: var(--color-text-link, var(--color-accent));
    text-decoration: none;
  }
  .link-inline:hover {
    text-decoration: underline;
  }
  .link-inline:focus-visible,
  .card-title:focus-visible,
  .chip:focus-visible,
  .btn:focus-visible,
  .input:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
    border-radius: var(--radius-xs, 3px);
  }

  .card {
    padding: var(--space-4, 1.25rem);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg, 12px);
    background: var(--color-surface-card, var(--color-surface));
  }
  .state {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .section-title {
    margin: 0;
    font-size: var(--text-md, 1rem);
    color: var(--color-text);
  }
  .state-body {
    margin: 0;
    color: var(--color-text-2);
    font-size: var(--text-sm, 0.875rem);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .dim {
    color: var(--color-text-muted);
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  .form-error,
  .form-ok {
    margin: 0;
    padding: var(--space-3, 0.75rem);
    border-radius: var(--radius-sm, 5px);
    font-size: var(--text-sm, 0.875rem);
  }
  .form-error {
    color: var(--color-error);
    background: var(--color-error-bg);
    border: 1px solid var(--color-error);
  }
  .form-ok {
    color: var(--color-success);
    background: var(--color-success-bg);
    border: 1px solid var(--color-success);
  }

  /* ── Filters ─────────────────────────────────────────────────────────── */
  .filters {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4, 1rem);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    min-width: 12rem;
  }
  .field-label {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-muted);
  }
  .input {
    padding: var(--pad-control, 0.5rem);
    color: var(--color-text);
    background: var(--color-bg-inset, var(--color-surface));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 5px);
    /* A form control does NOT inherit the page face by default (the UA sheet overrides it), and
       `inherit` is refused by the 14.1 token gate anyway — name the token. --font-sans IS the
       app's UI face (app.css §14.1: mono body, Lastik display-only). */
    font-family: var(--font-sans);
    font-size: var(--text-sm, 0.875rem);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-inline, 0.5rem);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2, 0.375rem);
    padding: 0.2rem 0.55rem;
    font-family: var(--font-mono);
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-2);
    background: var(--color-surface-overlay, var(--color-surface));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-pill, 999px);
    cursor: pointer;
  }
  .chip[data-active='true'] {
    color: var(--color-on-accent);
    background: var(--color-accent);
    border-color: var(--color-accent);
  }
  /* A DISABLED chip means "selecting this shows nothing" — it must still be READABLE, because the
     zero beside it is the information. WCAG 1.4.3 exempts disabled controls from the body minimum,
     but the faint ramp (1.86:1 on overlay) made the label guesswork, so this keeps the muted ramp
     and signals the state through the cursor + a light opacity instead of by hiding the text. */
  .chip:disabled {
    color: var(--color-text-muted);
    cursor: not-allowed;
    opacity: 0.7;
  }
  .chip-n {
    color: inherit;
    opacity: 0.75;
  }

  .filter-foot {
    display: flex;
    align-items: center;
    gap: var(--space-4, 1rem);
    flex-wrap: wrap;
  }
  .summary {
    margin: 0;
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-muted);
  }
  .stale-note {
    margin: 0;
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-warn);
  }
  .sprint-note {
    margin: 0;
    padding-top: var(--space-3, 0.75rem);
    border-top: 1px solid var(--color-border-faint, var(--color-border));
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-muted);
    max-width: 90ch;
  }
  .sprint-note code {
    font-family: var(--font-mono);
    color: var(--color-text-2);
  }

  .btn {
    padding: 0.3rem 0.65rem;
    color: var(--color-text);
    background: var(--color-surface-raised, var(--color-surface));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 5px);
    font-family: var(--font-sans);
    font-size: var(--text-sm, 0.875rem);
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    background: var(--color-surface-overlay, var(--color-surface));
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .btn.small {
    font-size: var(--text-xs, 0.75rem);
  }

  /* ── Board ───────────────────────────────────────────────────────────── */
  .board-layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-4, 1rem);
    align-items: start;
  }
  @media (min-width: 72rem) {
    .board-layout.has-detail {
      grid-template-columns: minmax(0, 1fr) minmax(22rem, 30rem);
    }
  }
  .board {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(15rem, 1fr);
    gap: var(--space-3, 0.75rem);
    overflow-x: auto;
    padding-bottom: var(--space-2, 0.5rem);
  }
  .board-col {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.75rem);
    background: var(--color-surface, var(--color-bg-inset));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    min-width: 0;
  }
  .board-col-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2, 0.5rem);
  }
  .status {
    font-family: var(--font-mono);
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-neutral-on-overlay, var(--color-text-2));
  }
  .status[data-status='ready'],
  .status[data-status='in_progress'] {
    color: var(--color-running-on-overlay, var(--color-running));
  }
  .status[data-status='done'] {
    color: var(--color-success-on-overlay, var(--color-success));
  }
  .status[data-status='failed'] {
    color: var(--color-error-on-overlay, var(--color-error));
  }
  .status[data-status='blocked'] {
    color: var(--color-blocked-on-overlay, var(--color-blocked));
  }
  .status[data-status='proposed'] {
    color: var(--color-info-on-overlay, var(--color-info));
  }
  .count {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-muted);
  }
  /* MEASURED, not assumed: `--color-text-faint` is 2.67:1 on `--color-surface` (the column's
     background) and would have failed AA body here. Every non-disabled text colour on this page is
     `--color-text-muted` or better; the gate test re-measures the pairs (board-a11y.test.ts). */
  .board-empty {
    margin: 0;
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-muted);
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
    gap: var(--space-2, 0.4rem);
    padding: var(--space-3, 0.6rem);
    background: var(--color-surface-card, var(--color-surface));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 5px);
  }
  .board-card.selected {
    border-color: var(--color-accent);
    background: var(--color-surface-selected, var(--color-surface-card));
  }
  .card-title {
    color: var(--color-text);
    font-size: var(--text-sm, 0.875rem);
    text-decoration: none;
  }
  .card-title:hover {
    color: var(--color-text-link);
    text-decoration: underline;
  }
  .card-objective {
    margin: 0;
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .card-tags {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.35rem);
  }
  .card-tag {
    padding: 0.05rem 0.4rem;
    font-size: var(--text-xs, 0.7rem);
    color: var(--color-text-2);
    background: var(--color-surface-overlay, var(--color-surface));
    border-radius: var(--radius-xs, 3px);
  }
  .card-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3, 0.5rem);
    font-size: var(--text-xs, 0.7rem);
    color: var(--color-text-muted);
  }
  .prio[data-prio='high'],
  .prio[data-prio='critical'] {
    color: var(--color-warn-on-overlay, var(--color-warn));
  }
  .ctx[data-full='true'] {
    color: var(--color-success-on-overlay, var(--color-success));
  }
  .ctx {
    color: var(--color-text-muted);
  }

  /* ── Detail panel ────────────────────────────────────────────────────── */
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
    position: sticky;
    top: var(--space-4, 1rem);
    max-height: calc(100vh - var(--space-8, 2rem));
    overflow-y: auto;
  }
  .detail-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }
  .detail-badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3, 0.5rem);
    font-size: var(--text-xs, 0.75rem);
  }
  .detail-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.4rem);
  }
  .detail-h {
    margin: 0;
    font-size: var(--text-xs, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .detail-h-note {
    text-transform: none;
    letter-spacing: 0;
    color: var(--color-text-muted);
  }
  .detail-text {
    margin: 0;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-2);
  }
  .detail-absent {
    margin: 0;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-muted);
    font-style: italic;
  }
  .detail-absent-inline {
    color: var(--color-text-muted);
  }
  .detail-criteria {
    margin: 0;
    padding-left: 1.2rem;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.2rem);
  }
  .detail-seed {
    margin: 0;
    padding: var(--space-3, 0.6rem);
    background: var(--color-bg-inset, var(--color-surface));
    border: 1px solid var(--color-border-faint, var(--color-border));
    border-radius: var(--radius-sm, 5px);
    font-family: var(--font-mono);
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-2);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 16rem;
    overflow-y: auto;
  }
  .detail-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
    align-items: center;
  }
  .detail-form .input {
    flex: 1 1 10rem;
    min-width: 0;
  }
  .detail-moves {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
  }
  .detail-hint {
    margin: 0;
    font-size: var(--text-xs, 0.7rem);
    color: var(--color-text-muted);
  }
  .detail-kv {
    display: grid;
    grid-template-columns: minmax(6rem, auto) minmax(0, 1fr);
    gap: var(--space-1, 0.25rem) var(--space-3, 0.75rem);
    margin: 0;
    font-size: var(--text-xs, 0.75rem);
  }
  .detail-kv dt {
    color: var(--color-text-muted);
  }
  .detail-kv dd {
    margin: 0;
    color: var(--color-text-2);
    word-break: break-word;
  }
  .detail-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.2rem);
  }

  /* Motion: the only animated property is the card/chip hover tint. Reduced-motion keeps the end
     state and drops the transition entirely (UI-SPEC §7). */
  @media (prefers-reduced-motion: no-preference) {
    .chip,
    .btn,
    .card-title {
      transition: color 120ms ease, background-color 120ms ease;
    }
  }
</style>
