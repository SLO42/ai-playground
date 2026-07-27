<script lang="ts">
  // THE CHIP WALL, fixed once (operator review 2026-07-26 §2).
  //
  // Renders a list of attribution session-refs as GROUPED chips instead of a wall of identical
  // labels. A group of one is a plain drill-through link (nothing to expand); a group of many is a
  // disclosure button reading `code-write ×30` that expands to the distinct sessions, each with the
  // discriminators the old markup discarded — the task title (or task-id tail) and the start time —
  // and the SAME per-session drill-through link as before. Nothing is hidden: the count is on the
  // face of the chip and every session is one keystroke away.
  //
  // Used by BOTH the `granted to` chips (all five dimensions) and the `used by` chips, which is the
  // point — the review asked for one component pattern, not five card patches.
  //
  // A11y: the disclosure is a real <button> with aria-expanded/aria-controls; the panel is a <ul>
  // with an accessible name; focus-visible keeps a visible ring (never outline:none); the chevron
  // transition is disabled under prefers-reduced-motion.

  import { groupSessionRefs, type SessionRefLike } from './session-ref-core';

  interface Props {
    /** The attribution refs. nil/empty renders {@link emptyText} — never a bare blank row. */
    refs: readonly SessionRefLike[] | null | undefined;
    /** The row label ("granted to" / "used by"). */
    label: string;
    /** Honest empty-state text when there are no refs at all (F-008). */
    emptyText?: string;
  }

  const { refs, label, emptyText = '— no in-window session' }: Props = $props();

  const groups = $derived(groupSessionRefs(refs));
  /** Which group keys are expanded. Collapsed by default — that is the whole fix. */
  let open = $state(new Set<string>());
  const uid = $props.id();

  function toggle(key: string) {
    // Reassign so the rune tracks the change (mutating a Set in place is not reactive).
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    open = next;
  }

  /** F-013 — an absent/unparseable timestamp renders '—', NEVER 'undefined'/'Invalid Date'. */
  function whenLabel(at: string | null): string {
    if (!at) return '—';
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }
</script>

<div class="attrib">
  <span class="attrib-label">{label}</span>
  <span class="chips">
    {#if groups.length === 0}
      <span class="none">{emptyText}</span>
    {:else}
      {#each groups as g (g.key)}
        {#if g.count === 1}
          <!-- A single session needs no disclosure — link straight through, as before. -->
          <a class="chip" class:placeholder={g.isPlaceholder} href={g.sessions[0].href} title={g.sessions[0].sessionTitle}>
            <span class="chip-label">{g.label}</span>
            <span class="chip-id mono">{g.sessions[0].idTail}</span>
          </a>
        {:else}
          <span class="group">
            <button
              type="button"
              class="chip chip-toggle"
              class:placeholder={g.isPlaceholder}
              class:open={open.has(g.key)}
              aria-expanded={open.has(g.key)}
              aria-controls={`${uid}-${g.domKey}`}
              onclick={() => toggle(g.key)}
            >
              <span class="chevron" aria-hidden="true"></span>
              <span class="chip-label">{g.label}</span>
              <span class="chip-count mono">×{g.count}</span>
            </button>
            <ul
              class="sessions"
              id={`${uid}-${g.domKey}`}
              hidden={!open.has(g.key)}
              aria-label={`${g.count} sessions labelled ${g.label}`}
            >
              {#each g.sessions as s (s.sessionId)}
                <li class="session">
                  <a class="session-link" href={s.href} title={s.sessionTitle}>
                    <span class="session-id mono">{s.idTail}</span>
                  </a>
                  {#if s.taskTitle}
                    <span class="session-task" title={s.taskTitle}>{s.taskTitle}</span>
                  {:else if s.taskRef}
                    <span class="session-task mono dim">task {s.taskRef}</span>
                  {:else}
                    <span class="session-task dim">no task</span>
                  {/if}
                  <span class="session-when mono">{whenLabel(s.startedAt)}</span>
                </li>
              {/each}
            </ul>
          </span>
        {/if}
      {/each}
    {/if}
  </span>
</div>

<style>
  .attrib {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
  }
  .attrib-label {
    color: var(--color-text-muted);
    text-transform: lowercase;
    min-width: 5rem;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    flex: 1 1 16rem;
    min-width: 0;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.66rem;
    /* `.chip` renders as BOTH an <a> (a group of one) and a <button> (a group of many); a
       <button> does NOT inherit the page face, so the token is stated explicitly rather than
       left to `inherit` — which is also the D-034 rule the typography-tokens guard enforces. */
    font-family: var(--font-body);
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm);
    background: var(--color-surface-card);
    color: var(--color-text-2);
    border: var(--border-width) solid var(--color-border);
    text-decoration: none;
  }
  .chip:hover {
    color: var(--color-text);
    border-color: var(--color-accent);
  }
  .chip:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }
  .chip-toggle {
    cursor: pointer;
  }
  /* Honest-unknown identity (F-008): visibly NOT a real name. */
  .chip.placeholder .chip-label {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .chip-id,
  .chip-count {
    color: var(--color-text-muted);
  }
  .chip-count {
    font-variant-numeric: tabular-nums;
  }
  .chevron {
    width: 0.5em;
    height: 0.5em;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(-45deg);
    transition: transform var(--motion-fast) var(--ease-out);
    opacity: 0.7;
  }
  .chip-toggle.open .chevron {
    transform: rotate(45deg);
  }
  .sessions {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0 0.25rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    border-left: var(--border-width) solid var(--color-border);
  }
  .session {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.66rem;
    min-width: 0;
  }
  .session-link {
    color: var(--color-text-link);
    text-decoration: none;
  }
  .session-link:hover {
    text-decoration: underline;
  }
  .session-link:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
  .session-id {
    color: inherit;
  }
  .session-task {
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 28rem;
    flex: 1 1 8rem;
    min-width: 0;
  }
  .session-when {
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .dim {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .none {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .mono {
    font-family: var(--font-mono);
  }

  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }
</style>
