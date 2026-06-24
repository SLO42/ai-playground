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
  //   • status === 'failed'        → the failure banner (error tone): the screened reason verbatim,
  //                                  or an explicit "no reason recorded" (legacy/absent — NEVER fabricated).
  //   • status !== 'failed' + note → a non-error ADVISORY banner. A session can END 'done' yet still
  //                                  carry an operator-actionable note — WI-3 merge-back stamps
  //                                  "work preserved on branch <b>; merge needed" on a done-but-
  //                                  couldn't-fast-forward session. That note MUST surface (the anti-
  //                                  invisible-failure directive) even though the session did not fail.
  //   • !failed + no note          → renders nothing (a clean session with no advisory).
  //
  // The note text is server-screened plain text; it is rendered as text content (Svelte escapes it),
  // so no operator/agent freetext can inject markup here (D-026 boundary already passed upstream).

  interface Props {
    /** The session's terminal status — drives the error vs advisory tone. */
    status: string | null | undefined;
    /** The screened session.note (WHY it failed, or a work-preserved advisory), or null. */
    note: string | null | undefined;
    /** Visual density: 'row' (compact, in a session list) or 'panel' (header banner). */
    variant?: 'row' | 'panel';
  }

  let { status, note, variant = 'row' }: Props = $props();

  const isFailed = $derived(status === 'failed');
  // A non-failed session with a note is an ADVISORY (WI-3 merge-preserved work, etc.) — surfaced,
  // never dropped, but visually distinct from a hard failure (no error border).
  const isAdvisory = $derived(!isFailed && !!note && note.trim().length > 0);
  const label = $derived(
    isFailed ? (variant === 'panel' ? 'failure reason' : 'reason') : variant === 'panel' ? 'needs attention' : 'note'
  );
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
{:else if isAdvisory}
  <p class="fail-reason advisory" data-variant={variant} role="status">
    <span class="fail-label advisory-label">{label}</span>
    <span class="fail-text">{note}</span>
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
    /* On --color-surface-overlay this small (≈11px) bold text is BODY-AA: it MUST use
       the on-overlay token (error-300, 5.31:1), not raw --color-error (error-500, 3.50:1
       — only AA_LARGE). The contrast gate covers the *-on-overlay pairings, not raw
       --color-error as body text on the overlay. (colors.css:111-118) */
    color: var(--color-error-on-overlay);
  }
  /* ADVISORY variant (WI-3 merge-preserved work etc.): a NON-failure, operator-actionable note on
     a clean session. Warn tone (not error) — a left border + label in the gated warn-on-overlay
     color so it is visually distinct from a hard failure but equally un-missable. */
  .fail-reason.advisory {
    border-left-color: var(--color-warn);
  }
  .advisory-label {
    color: var(--color-warn-on-overlay);
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
