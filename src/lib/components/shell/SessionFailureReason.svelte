<script lang="ts">
  // OBSERVABILITY — the honest failure reason for a session (the session.note observability fix).
  //
  // When an agent session ends 'failed', launch.ts stamps a concrete, D-026-SCREENED reason onto
  // session.note (a child spawn-fail / instant pre-init death with cc_session_id=null, a non-zero
  // exit whose reason rides STDOUT, a mid-stream throw, or a done(ok=false) result). Before that
  // fix a failed session showed NO reason (the live 6-ROUNDS symptom: note=null — an invisible
  // failure). This component renders that reason wherever a failed session is shown — the project
  // page session list + transcript header, and (via its own inline markup) /claude-code.
  //
  // HONEST states (F-008):
  //   • status !== 'failed'        → renders nothing (a clean/running session has no failure reason).
  //   • failed + note present      → the screened reason verbatim (safe to render — secrets already
  //                                  redacted at the launch write, never re-screened/double-handled).
  //   • failed + note absent (null)→ an explicit "no reason recorded" (legacy rows from before the
  //                                  fix, or a row whose note write itself failed) — NEVER fabricated.
  //
  // The note text is server-screened plain text; it is rendered as text content (Svelte escapes it),
  // so no operator/agent freetext can inject markup here (D-026 boundary already passed upstream).

  interface Props {
    /** The session's terminal status — the reason renders ONLY when this is 'failed'. */
    status: string | null | undefined;
    /** The screened session.note (WHY it failed), or null when none was recorded. */
    note: string | null | undefined;
    /** Visual density: 'row' (compact, in a session list) or 'panel' (header banner). */
    variant?: 'row' | 'panel';
  }

  let { status, note, variant = 'row' }: Props = $props();

  const isFailed = $derived(status === 'failed');
  const label = $derived(variant === 'panel' ? 'failure reason' : 'reason');
</script>

{#if isFailed}
  <p class="fail-reason" data-variant={variant} role="status">
    <span class="fail-label">{label}</span>
    {#if note}
      <span class="fail-text">{note}</span>
    {:else}
      <span class="fail-text none">no reason recorded</span>
    {/if}
  </p>
{/if}

<style>
  .fail-reason {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
    margin: var(--space-2, 0.5rem) 0 0;
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    background: var(--color-surface-overlay);
    border-left: 3px solid var(--color-error);
    border-radius: var(--radius-sm, 6px);
    font: var(--type-body-sm);
  }
  .fail-label {
    flex: none;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-error);
  }
  .fail-text {
    color: var(--color-text);
    word-break: break-word;
    white-space: pre-wrap;
  }
  .fail-text.none {
    color: var(--color-text-muted);
    font-style: italic;
  }
</style>
