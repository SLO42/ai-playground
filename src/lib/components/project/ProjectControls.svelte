<script lang="ts">
  /**
   * CC-CONTROLS — the operator command-center CONTROLS card for /projects/[id] (OPERATOR PAIN).
   *
   * Gives the operator the controls they asked for, in ONE place on the project page:
   *   • CONTINUE — re-drive this project's already-READY tasks through the live orchestrator (the
   *     ?/continueProject action). The honest fix for ready tasks that sat undeveloped after a boot.
   *   • RESTART  — re-run the task behind a FAILED/stuck session (the ?/restartSession action), guarded
   *     so a double-click can't double-spawn (the work_item dedup_key collapses a concurrent re-enqueue).
   * (RE-RUN PM / the autonomous tick + ARM / DISARM / STOP live in the "Project lifecycle" card below —
   *  this card complements them with the two missing get-it-moving / re-run controls.)
   *
   * EXTRACTED sub-component (the page +page.svelte is already ~4200 lines — that bloat is a known smell).
   * Owns its own enhance forms so the parent stays lean. Honest states throughout (F-008): the CONTINUE
   * button shows the REAL ready-task count and is disabled with a reason when nothing is ready; every
   * result is a faithful read of the server result (ok / noop / error), never a fabricated success.
   * Svelte 5 RUNES only; design TOKENS only; a11y (aria-busy, role=status/alert, focus-visible).
   */
  import { enhance } from '$app/forms';
  import SessionFailureReason from '$lib/components/shell/SessionFailureReason.svelte';
  import {
    readyTaskCount,
    restartableSessions,
    continueState,
    continueSummary,
    restartState,
    restartSummary,
    type TaskLike,
    type SessionLike,
    type ContinueFeedback,
    type RestartFeedback
  } from './project-controls-core';

  interface Props {
    /** The live task rows (loader TaskSummary[]) — drives the CONTINUE candidate count. */
    tasks: readonly TaskLike[];
    /** The live session rows for THIS project (loader FleetSession[]) — drives the RESTART list. */
    sessions: readonly SessionLike[];
    /** The last ?/continueProject action result (form.continue), or undefined. */
    continueFeedback: ContinueFeedback | undefined;
    /** The last ?/restartSession action result (form.restart), or undefined. */
    restartFeedback: RestartFeedback | undefined;
  }

  let { tasks, sessions, continueFeedback, restartFeedback }: Props = $props();

  // Pure derivations from the live rows (project-controls-core) — no fabricated counts (F-008).
  const readyCount = $derived(readyTaskCount(tasks));
  const restartable = $derived(restartableSessions(sessions));

  // ── CONTINUE — re-enqueue + drain this project's ready tasks. ───────────────────────────────────
  let continueBusy = $state(false);
  const contState = $derived(continueState(continueFeedback, continueBusy));
  const contSummary = $derived(continueSummary(continueFeedback));
  // Disabled when nothing is ready AND we are not showing the result of a just-run continue (so the
  // operator can still read the last result). Honest: an empty ready set means there is nothing to drive.
  const continueDisabled = $derived(continueBusy || (readyCount === 0 && contState !== 'busy'));

  // ── RESTART — re-run a failed/stuck session's task. Per-session busy state (which row is in flight). ─
  let restartBusyId = $state<string | null>(null);
  // The session id the last restart result is about (so the banner attaches to the right row).
  const restartTargetId = $derived(
    restartFeedback && typeof restartFeedback === 'object' && 'sessionId' in restartFeedback
      ? String((restartFeedback as { sessionId?: unknown }).sessionId ?? '')
      : ''
  );
</script>

<section class="controls card" aria-label="project controls">
  <header class="controls-head">
    <span class="eyebrow">controls</span>
    <h2 class="controls-title">Run controls</h2>
  </header>

  <!-- CONTINUE — get a stalled project moving (re-drive its ready tasks). -->
  <div class="control-block">
    <div class="control-copy">
      <span class="control-name">Continue</span>
      <p class="control-sub">
        Re-drive this project’s ready tasks through the engine. Use this when ready work is sitting
        undeveloped (e.g. after a restart) — it asks the orchestrator to pick them up, bounded by the
        spawn cap. It never double-runs a task already in flight.
      </p>
    </div>
    <form
      method="POST"
      action="?/continueProject"
      use:enhance={() => {
        continueBusy = true;
        return async ({ update }) => {
          await update({ reset: false });
          continueBusy = false;
        };
      }}
    >
      <button
        class="btn primary"
        type="submit"
        aria-busy={continueBusy}
        disabled={continueDisabled}
        aria-label={`Continue — re-drive ${readyCount} ready task${readyCount === 1 ? '' : 's'}`}
      >
        {#if continueBusy}
          Continuing…
        {:else}
          Continue ({readyCount} ready)
        {/if}
      </button>
    </form>
  </div>

  {#if contState === 'error'}
    <p class="form-error" role="alert">{contSummary}</p>
  {:else if contState === 'noop'}
    <p class="form-note" role="status" aria-live="polite">{contSummary}</p>
  {:else if contState === 'ok'}
    <p class="form-ok" role="status" aria-live="polite">{contSummary}</p>
  {/if}

  <!-- RESTART — re-run a failed/stuck session's task. -->
  <div class="control-block restart-block">
    <div class="control-copy">
      <span class="control-name">Restart a failed run</span>
      <p class="control-sub">
        Re-run the task behind a session that failed or got stuck. Guarded so a double-click can’t
        double-spawn the same task.
      </p>
    </div>

    {#if restartable.length === 0}
      <p class="form-note muted" role="status">No failed or stuck sessions to restart.</p>
    {:else}
      <ul class="restart-list" aria-label="failed or stuck sessions">
        {#each restartable as row (row.sessionId)}
          <li class="restart-row">
            <div class="restart-meta">
              <span class="restart-label">{row.label}</span>
              <SessionFailureReason status="failed" note={row.note} variant="row" />
            </div>
            <form
              method="POST"
              action="?/restartSession"
              use:enhance={() => {
                restartBusyId = row.sessionId;
                return async ({ update }) => {
                  await update({ reset: false });
                  restartBusyId = null;
                };
              }}
            >
              <input type="hidden" name="sessionId" value={row.sessionId} />
              <button
                class="btn"
                type="submit"
                aria-busy={restartBusyId === row.sessionId}
                disabled={restartBusyId === row.sessionId}
                aria-label="Restart this run — re-enqueues its task"
              >
                {restartBusyId === row.sessionId ? 'Restarting…' : 'Restart'}
              </button>
            </form>
            {#if restartTargetId === row.sessionId && restartBusyId !== row.sessionId}
              {@const rs = restartState(restartFeedback, false)}
              {#if rs === 'error'}
                <p class="form-error restart-banner" role="alert">{restartSummary(restartFeedback)}</p>
              {:else if rs === 'noop'}
                <p class="form-note restart-banner" role="status" aria-live="polite">
                  {restartSummary(restartFeedback)}
                </p>
              {:else if rs === 'ok'}
                <p class="form-ok restart-banner" role="status" aria-live="polite">
                  {restartSummary(restartFeedback)}
                </p>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-5, 16px);
  }
  .controls-head {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .eyebrow {
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
  .controls-title {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--color-text);
  }

  .control-block {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4, 12px);
    padding: var(--space-4, 12px);
    border-radius: var(--radius-md, 8px);
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border-faint, var(--color-border));
  }
  .control-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 4px);
    flex: 1 1 18rem;
    min-width: 14rem;
  }
  .control-name {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--color-text);
  }
  .control-sub {
    margin: 0;
    font-size: 0.78rem;
    line-height: 1.4;
    color: var(--color-text-secondary, var(--color-text-muted));
  }
  .restart-block {
    flex-direction: column;
  }

  .restart-list {
    list-style: none;
    margin: var(--space-3, 8px) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 8px);
    width: 100%;
  }
  .restart-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 8px);
    padding: var(--space-3, 8px);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    border: 1px solid var(--color-border-faint, var(--color-border));
  }
  .restart-meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 4px);
    flex: 1 1 16rem;
    min-width: 12rem;
  }
  .restart-label {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--color-text);
    text-transform: lowercase;
  }
  .restart-banner {
    flex-basis: 100%;
    margin: var(--space-2, 4px) 0 0;
  }

  /* ── result banners (reuse the page's token classes locally) ─────────────── */
  .form-error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--color-error-on-overlay, var(--color-blocked-on-overlay));
  }
  .form-ok {
    margin: 0;
    font-size: 0.8rem;
    color: var(--color-success-on-overlay, var(--color-success));
  }
  .form-note {
    margin: 0;
    font-size: 0.8rem;
    color: var(--color-text-secondary, var(--color-text-muted));
  }
  .form-note.muted {
    color: var(--color-text-muted);
  }

  /* ── buttons (token-only; mirrors the page .btn) ─────────────────────────── */
  .btn {
    font-size: 0.82rem;
    font-weight: 600;
    padding: 0.4rem 0.9rem;
    border-radius: var(--radius-sm, 6px);
    border: 1px solid var(--color-border);
    background: var(--color-surface-card);
    color: var(--color-text);
    cursor: pointer;
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--color-accent);
  }
  .btn.primary {
    background: var(--color-accent);
    color: var(--color-accent-contrast, var(--color-surface-card));
    border-color: var(--color-accent);
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .controls * {
      transition: none;
    }
  }
</style>
