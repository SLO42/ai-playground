<script lang="ts">
  /**
   * ActivityFeed — the living-brain "what's happening now" panel (MEMORY-SCENE-SPEC §5).
   *
   * A rolling, human-readable list of the recent `scene_event`s (job_fired / memory_added /
   * connection_formed / job_done / node_spawned …). DERIVED, append-only: every line mirrors
   * a real observed row-change (F-008 — never a fabricated event). It is also the scene's
   * TEXT-EQUIVALENT replay (a11y): the animation timeline made readable. The truth is the
   * `activity` prop (re-derived live by the loader on every `scene_event` change); this
   * component owns NO truth and never fabricates a line.
   *
   * RAILS: design-system TOKENS only (the per-event dot color is class-driven — no literals);
   * honest empty ('no recent activity'); reduced-motion safe (no entrance animation here — the
   * list just re-renders); Svelte 5 runes only.
   */
  import { describeSceneEvent } from '$lib/client/scene/scene-graph';
  import type { SceneEvent } from '$lib/server/scene';

  interface Props {
    /** The recent scene_event slice (newest-first) — the loader's derived truth. */
    activity: SceneEvent[];
  }

  let { activity }: Props = $props();

  // Map each event → its human line; skip any that can't be described (defensive, F-008).
  const lines = $derived(
    (activity ?? [])
      .map((e) => ({ event: e, line: describeSceneEvent(e) }))
      .filter((x): x is { event: SceneEvent; line: NonNullable<ReturnType<typeof describeSceneEvent>> } => x.line !== null)
  );
  const hasActivity = $derived(lines.length > 0);

  /** Relative time ('2m ago') from an ISO string, or '—' when absent (F-013, never str(NONE)). */
  function ago(at: string | undefined): string {
    if (!at) return '—';
    const t = new Date(at).getTime();
    if (Number.isNaN(t)) return '—';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
</script>

<div class="feed" aria-label="Recent scene activity ({lines.length})">
  <span class="eyebrow">activity · {lines.length} recent</span>
  {#if !hasActivity}
    <!-- Honest empty (F-008) — never a fabricated activity line. -->
    <p class="feed-empty" role="status">No recent activity — events appear as jobs fire, memories land and connections form.</p>
  {:else}
    <ul class="feed-list">
      {#each lines as { event, line } (event.id)}
        <li class="feed-row">
          <span class="feed-dot" data-class={line.colorClass} aria-hidden="true"></span>
          <span class="feed-verb">{line.verb}</span>
          <span class="feed-subject mono">{line.subject}</span>
          {#if line.detail}<span class="feed-detail">{line.detail}</span>{/if}
          <span class="feed-when mono" title={event.at ?? ''}>{ago(event.at)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .feed {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .feed-empty {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    max-width: 48ch;
  }
  .feed-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    max-height: 22rem;
    overflow-y: auto;
  }
  .feed-row {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.3rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    border: 1px solid transparent;
  }
  .feed-row:hover {
    background: var(--color-surface-overlay);
    border-color: var(--color-border-subtle, var(--color-border));
  }
  .feed-dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    flex: none;
    align-self: center;
  }
  /* Token-driven dot color per node-class family — NO literals. */
  .feed-dot[data-class='memory'] {
    background: var(--color-accent);
  }
  .feed-dot[data-class='job'] {
    background: var(--color-running);
  }
  .feed-verb {
    font: var(--type-body-sm);
    color: var(--color-text);
  }
  .feed-subject {
    font-size: 0.72rem;
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
  .feed-detail {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--color-text-muted);
  }
  .feed-when {
    margin-left: auto;
    font-size: 0.66rem;
    color: var(--color-text-muted);
    white-space: nowrap;
  }
</style>
