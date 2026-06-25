<script lang="ts">
  /**
   * ProjectActivity — the live "what's happening now?" panel for ONE project (/projects/[id]).
   *
   * Consolidates the per-session watching the operator used to do on /claude-code into the project
   * view: a compact list of this project's RUNNING (and most-recent) sessions, each labelled BY
   * KIND (PM lifecycle / validation panel / dev task / HR / …, derived from session.kind + the
   * workforce role it ran AS), with its live status. Expanding the active one renders its FULL
   * transcript inline — assistant thinking + tool_use + tool_result + result + origin-labelled
   * pushed-in turns — by REUSING the shared <SessionTranscript> renderer and the parent's live
   * `message`/transcript SSE pipeline (NOT a re-built renderer). The operator no longer needs three
   * pages to watch one project.
   *
   * Honest throughout (F-008): no running session AND no recent ones → an honest "idle — nothing
   * running"; a failed session shows its MC-4 reason via <SessionFailureReason>; an absent/unknown
   * session kind → a neutral label, never a fabricated one. The expanded transcript's content was
   * already D-026-screened at the persist/stream boundary, so it is rendered as the shared
   * component frames it (no re-screen needed here, no raw freetext introduced).
   *
   * The panel is READ-focused — open/expand only. Session steering (interject/stop/resume) lives on
   * the Sessions tab's control bar; this surface introduces NO new control (it drives the SAME
   * `?session=` selection the parent already wires, so the parent's live transcript streams here).
   *
   * Svelte 5 RUNES only; design TOKENS only (a11y: the expand control is a real <button> with
   * aria-expanded + a focus-visible ring; the live region is a labelled role="log"). Reduced-motion safe.
   */
  import SessionTranscript from '$lib/components/shell/SessionTranscript.svelte';
  import SessionFailureReason from '$lib/components/shell/SessionFailureReason.svelte';
  import type { Turn } from '$lib/client/transcript-core';
  import { relativeTime, elapsed, absoluteTime } from '$lib/client/time-format';
  import {
    buildActivity,
    type ActivitySessionLike
  } from './project-activity-core';

  interface Props {
    /** The live per-project session rows (loader FleetSession[] — running + recent). */
    sessions: readonly ActivitySessionLike[];
    /** The currently-expanded session id (the parent's `?session=` selection), or null. */
    selectedSession: string | null;
    /** The expanded session's normalized live transcript turns (parent's `liveTurns`). */
    turns: readonly Turn[];
    /** The expanded session's LIVE status (parent's `liveStatus`), or null (use the row status). */
    liveStatus: string | null;
    /** The expanded session's live token usage, or null (honest — omitted when unknown). */
    liveTokens: { tokensIn: number; tokensOut: number } | null;
    /** Expand/collapse a session — the parent navigates to/from `?session=<id>` (drives the SSE). */
    onToggle: (id: string) => void;
    /** FS-3 — hand a referenced file path back so the parent opens the snapshot viewer. */
    onViewFile?: (path: string) => void;
  }
  let {
    sessions,
    selectedSession,
    turns,
    liveStatus,
    liveTokens,
    onToggle,
    onViewFile
  }: Props = $props();

  // The activity model — running-first, finished tail bounded — derived LIVE from real rows.
  const model = $derived(buildActivity(sessions));

  // The expanded row, if any (so its header shows the live status/tokens of the open session).
  const expanded = $derived(model.entries.find((e) => e.id === selectedSession) ?? null);

  function shortId(id: string): string {
    const i = id.indexOf(':');
    return i >= 0 ? id.slice(i + 1) : id;
  }

  // A SINGLE shared clock ticks for the whole panel (one interval, never per-row timers) so the
  // running sessions' live elapsed advances without hammering. Updated every 1s; absent any RUNNING
  // session the tick is harmless (finished rows freeze their elapsed at end−start). Reduced-motion is
  // irrelevant here (no animation — just a text update); the interval is torn down on unmount.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });
</script>

<section class="activity card" aria-label="live project activity">
  <header class="act-head">
    <span class="eyebrow">activity · what's happening now</span>
    <span class="count mono">
      {#if model.runningCount > 0}
        {model.runningCount} running
      {:else if model.nothingRunning}
        idle · {model.entries.length} recent
      {:else}
        idle
      {/if}
    </span>
  </header>

  {#if model.idle}
    <!-- HONEST idle (F-008): nothing running and no recent sessions for this project. -->
    <p class="act-idle">
      Idle — nothing running. Launch a session or let the PM drive, and live activity appears here.
    </p>
  {:else}
    <ul class="act-list" aria-label="project sessions">
      {#each model.entries as e (e.id)}
        {@const isOpen = selectedSession === e.id}
        <li class="act-row" class:running={e.running} class:open={isOpen}>
          <button
            class="act-toggle"
            type="button"
            aria-expanded={isOpen}
            aria-controls={`act-tx-${shortId(e.id)}`}
            onclick={() => onToggle(e.id)}
          >
            <span class="act-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            <span class="act-status" data-tone={e.tone}>
              {#if e.running}<span class="act-dot" aria-hidden="true"></span>{/if}
              {e.status}
            </span>
            <span class="act-label">{e.label}</span>
            <span class="act-model mono">{e.provider}/{e.modelId}</span>
            {#if e.tier}<span class="act-tier" data-tier={e.tier}>{e.tier}</span>{/if}
            <span class="act-sid mono" title={e.id}>{shortId(e.id)}</span>
            <!-- START (relative, absolute on hover) + ELAPSED (live-ticking while running, final once
                 terminal). Honest '—' when the timestamp is absent (F-013) — never a fabricated time. -->
            <span class="act-times" aria-hidden="false">
              <span class="act-when mono" title={absoluteTime(e.startedAt)}>{relativeTime(e.startedAt, now)}</span>
              <span
                class="act-elapsed mono"
                class:live={e.running}
                title={e.running ? 'elapsed (live)' : 'elapsed'}
              >{elapsed(e.startedAt, e.endedAt, now)}</span>
            </span>
          </button>

          <!-- OBSERVABILITY (MC-4) — a failed session explains itself right in the list (the
               D-026-screened session.note, or the honest "no reason recorded"). -->
          <SessionFailureReason status={e.status} note={e.note} variant="row" />

          {#if isOpen}
            <!-- The inline LIVE transcript for the active session — the SAME kind-aware renderer
                 /claude-code uses, fed by the parent's live `message`/transcript SSE pipeline. -->
            <div class="act-detail" id={`act-tx-${shortId(e.id)}`}>
              <div class="act-detail-head">
                <span class="act-detail-status" data-tone={expanded?.tone ?? e.tone}>
                  {liveStatus ?? e.status}
                </span>
                {#if liveTokens}
                  <span class="act-tokens mono"
                    >↓{liveTokens.tokensIn} ↑{liveTokens.tokensOut} tok</span
                  >
                {/if}
              </div>
              <!-- The open session's honest failure reason in the detail header (prefers the live
                   status so a JUST-failed session explains itself without a reload). -->
              <SessionFailureReason status={liveStatus ?? e.status} note={e.note} variant="panel" />
              <div
                class="act-log"
                role="log"
                aria-live="polite"
                aria-label={`transcript for ${e.label} session ${shortId(e.id)}`}
              >
                {#if turns.length === 0}
                  <p class="act-empty">
                    No transcript yet — turns appear here as the session runs.
                  </p>
                {:else}
                  <SessionTranscript turns={[...turns]} {onViewFile} />
                {/if}
              </div>
              {#if (liveStatus ?? e.status) === 'running'}
                <p class="act-foot mono" aria-live="polite">live — new turns append as it runs</p>
              {:else if turns.length > 0}
                <p class="act-foot mono">
                  {turns.length} turn{turns.length === 1 ? '' : 's'} · read-only replay
                </p>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .activity {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .act-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }
  .eyebrow {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-accent);
  }
  .count {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .act-idle {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    font-style: italic;
    margin: 0;
  }
  .act-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .act-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: 0.5rem 0.65rem;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .act-row.running {
    border-color: var(--color-running, var(--color-success, #2a9d4a));
  }
  .act-row.open {
    border-color: var(--color-accent);
    background: var(--color-accent-muted, var(--color-surface-card));
  }
  .act-toggle {
    appearance: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    text-align: left;
    color: var(--color-text);
    min-width: 0;
  }
  .act-toggle:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-xs, 3px);
  }
  .act-caret {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    flex: none;
  }
  .act-status {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: lowercase;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text-muted);
    white-space: nowrap;
    flex: none;
  }
  .act-status[data-tone='running'] {
    color: var(--color-running, var(--color-success, #2a9d4a));
  }
  .act-status[data-tone='done'] {
    color: var(--color-success, var(--color-running));
  }
  .act-status[data-tone='failed'] {
    color: var(--color-error-on-overlay);
  }
  .act-status[data-tone='blocked'] {
    color: var(--color-blocked, var(--color-warn, orange));
  }
  /* A small pulsing dot marks a live (running) session; reduced-motion shows it static. */
  .act-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: var(--color-running, var(--color-success, #2a9d4a));
    animation: act-pulse 1.6s ease-in-out infinite;
  }
  @keyframes act-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .act-dot {
      animation: none;
    }
  }
  .act-label {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--color-text);
    flex: none;
  }
  .act-model {
    font-size: 0.72rem;
    color: var(--color-text-2);
  }
  .act-tier {
    font-size: 0.64rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text);
    flex: none;
  }
  .act-tier[data-tier='opus'] {
    color: var(--color-tier-opus, var(--color-accent));
  }
  .act-tier[data-tier='sonnet'] {
    color: var(--color-tier-sonnet, var(--color-accent));
  }
  .act-tier[data-tier='haiku'] {
    color: var(--color-tier-haiku, var(--color-text-muted));
  }
  .act-tier[data-tier='local'] {
    color: var(--color-tier-local, var(--color-text-muted));
  }
  .act-sid {
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .act-times {
    display: inline-flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-left: auto;
    flex: none;
  }
  .act-when {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .act-elapsed {
    font-size: 0.7rem;
    color: var(--color-text-2);
    padding: 0.02rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
  }
  .act-elapsed.live {
    color: var(--color-running, var(--color-success, #2a9d4a));
  }
  .act-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .act-detail-head {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
  }
  .act-detail-status {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: lowercase;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text-muted);
  }
  .act-detail-status[data-tone='running'] {
    color: var(--color-running, var(--color-success, #2a9d4a));
  }
  .act-detail-status[data-tone='done'] {
    color: var(--color-success, var(--color-running));
  }
  .act-detail-status[data-tone='failed'] {
    color: var(--color-error-on-overlay);
  }
  .act-detail-status[data-tone='blocked'] {
    color: var(--color-blocked, var(--color-warn, orange));
  }
  .act-tokens {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .act-log {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    max-height: 28rem;
    overflow: auto;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-bg, #03120e);
    padding: var(--space-3, 0.75rem);
  }
  .act-empty {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    font-style: italic;
    margin: 0;
  }
  .act-foot {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    margin: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .act-log {
      scroll-behavior: auto;
    }
  }
</style>
