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
  //
  // MC-4 READABILITY (operator: failure reasons are walls of raw text): the RAW note (a streamed-
  // JSON CLI exit tail, a long git merge hint, the D-036 capability line) is classified by the PURE
  // `classifyFailureNote` into { category, shortLabel } so the overview shows ONE clean line — a
  // short human label + a category tag. The full screened note stays available in a COLLAPSED
  // <details> disclosure (collapsed by default, opened on demand). The disclosure renders the SAME
  // already-screened text — no new exposure (D-026 unchanged); classification NEVER fabricates a
  // category (F-008): an unrecognized note falls back to 'session failed' + the raw note.

  import { classifyFailureNote } from './failure-classify';

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

  // Classify the raw screened note → human short label + category tag. Pure + total (never throws).
  const classified = $derived(classifyFailureNote(note));
  // Show the collapsible detail only when there is a real note (empty ⇒ the "no reason recorded"
  // fallback below; nothing to disclose). The disclosure text === the screened note verbatim.
  const hasDetail = $derived(!classified.empty && classified.detail.trim().length > 0);
</script>

{#if isFailed}
  <div class="fail-reason" data-variant={variant} role="status">
    <p class="fail-head">
      <span class="fail-label">{label}</span>
      {#if classified.empty}
        <span class="fail-text none">no reason recorded</span>
      {:else}
        <span class="cat-tag" data-category={classified.category}>
          <span class="cat-icon" aria-hidden="true">{classified.icon}</span>
          <span class="cat-short">{classified.shortLabel}</span>
        </span>
      {/if}
    </p>
    {#if hasDetail}
      <details class="fail-detail">
        <summary>full details</summary>
        <span class="fail-text">{classified.detail}</span>
      </details>
    {/if}
  </div>
{:else if isAdvisory}
  <div class="fail-reason advisory" data-variant={variant} role="status">
    <p class="fail-head">
      <span class="fail-label advisory-label">{label}</span>
      <span class="cat-tag advisory-tag" data-category={classified.category}>
        <span class="cat-icon" aria-hidden="true">{classified.icon}</span>
        <span class="cat-short">{classified.shortLabel}</span>
      </span>
    </p>
    {#if hasDetail}
      <details class="fail-detail">
        <summary>full details</summary>
        <span class="fail-text">{classified.detail}</span>
      </details>
    {/if}
  </div>
{/if}

<style>
  .fail-reason {
    margin: var(--space-2, 0.5rem) 0 0;
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    background: var(--color-surface-overlay);
    border-left: 3px solid var(--color-error);
    border-radius: var(--radius-sm, 6px);
    font: var(--type-body-sm);
  }
  /* The ONE clean overview line: the label + the category tag (short human reason). */
  .fail-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
    margin: 0;
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
  /* The category tag: a short human label + glyph. Uses the SAME gated on-overlay error token as
     the label so the short reason is BODY-AA on the overlay (the glyph is aria-hidden decoration). */
  .cat-tag {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1, 0.25rem);
    color: var(--color-error-on-overlay);
    font-weight: 600;
  }
  .cat-tag.advisory-tag {
    color: var(--color-warn-on-overlay);
  }
  .cat-icon {
    flex: none;
    font-size: 0.85em;
  }
  .cat-short {
    word-break: break-word;
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
  /* COLLAPSIBLE full detail: collapsed by default so the overview shows one clean line; the full
     (unchanged, screened) note is one click away. Native <details> = keyboard-operable + a11y for
     free; the summary keeps a visible focus ring (focus-visible, never outline:none). */
  .fail-detail {
    margin-top: var(--space-1, 0.25rem);
  }
  .fail-detail > summary {
    cursor: pointer;
    width: fit-content;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    border-radius: var(--radius-sm, 6px);
  }
  .fail-detail > summary:hover {
    color: var(--color-text);
  }
  .fail-detail > summary:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }
  .fail-text {
    display: block;
    margin-top: var(--space-1, 0.25rem);
    color: var(--color-text);
    word-break: break-word;
    white-space: pre-wrap;
  }
  .fail-text.none {
    display: inline;
    margin: 0;
    color: var(--color-text-muted);
    font-style: italic;
  }
</style>
