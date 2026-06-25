<script lang="ts">
  /**
   * /skills — the operator REVIEW surface for harvested skill proposals (SH-4 / SKILL-HARVEST-SPEC §4).
   *
   * Lists OPEN proposals (highest-occurrence first), each with three operator actions:
   *   • Approve            → promote as-is (SH-3: confined SKILL.md on disk + cc_skill row).
   *   • Edit then approve  → tweak name/description/body (the operator's edit, screened) then promote.
   *   • Reject             → MARK rejected (G2 mark-don't-delete; retained for audit).
   *
   * Operator identity is SERVER-resolved (the action records it; the form never carries an approver).
   * Honest states (F-008): loading is the SSR-resolved snapshot; a disconnected DB / read fault shows
   * the reason; an empty open list shows the honest "no proposals yet". The body rendered is the
   * SCREENED body (never raw). Design tokens only; a11y (labels, focus-visible); Svelte 5 runes.
   */
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const proposals = $derived(data.proposals ?? []);
  const connected = $derived(data.connected);
  const loadError = $derived(data.error);

  interface ReviewResult {
    ok?: true;
    action?: 'approve' | 'editApprove' | 'reject';
    name?: string;
    filePath?: string;
    wroteFile?: boolean;
    renamed?: boolean;
    error?: string;
  }
  const review = $derived((form?.review ?? null) as ReviewResult | null);

  // Which card has its EDIT form open, and which has its full body expanded.
  let editingId = $state<string | null>(null);
  let expandedId = $state<string | null>(null);

  function fmtDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }
</script>

<svelte:head>
  <title>Skills — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">knowledge & system</span>
    <h1 class="title">Skill proposals</h1>
    <p class="lede">
      Reusable procedures harvested from sessions, awaiting your review. Approve to write the skill to
      disk and the live catalog, edit then approve to refine it first, or reject to set it aside (kept
      for audit). Agents propose; you decide.
    </p>
  </header>

  {#if review?.error}
    <p class="form-error" role="alert">{review.error}</p>
  {/if}
  {#if review?.ok && review.action === 'approve'}
    <p class="form-ok" role="status">
      Approved — <b class="mono">{review.name}</b>
      {review.wroteFile ? 'written to disk' : 'already on disk'} and is now a referenceable capability.
    </p>
  {/if}
  {#if review?.ok && review.action === 'editApprove'}
    <p class="form-ok" role="status">
      Edited and approved — <b class="mono">{review.name}</b> is now in the catalog.{#if review.renamed}
        The original draft was a different name and remains open.{/if}
    </p>
  {/if}
  {#if review?.ok && review.action === 'reject'}
    <p class="form-ok" role="status">
      Rejected <b class="mono">{review.name}</b> — kept for audit, removed from the review list.
    </p>
  {/if}

  {#if !connected}
    <div class="card warn-card" role="alert">
      <span class="eyebrow">offline</span>
      <p class="card-body">
        {loadError ?? 'Database not connected.'} The review list falls back to an honest empty state.
      </p>
    </div>
  {:else if proposals.length === 0}
    <div class="card empty-card">
      <span class="eyebrow">all clear</span>
      <p class="card-body">
        No proposals yet. When a session establishes a reusable procedure, its harvested proposal will
        appear here for your review.
      </p>
    </div>
  {:else}
    <ul class="proposal-list">
      {#each proposals as p (p.id)}
        <li class="card proposal">
          <div class="proposal-head">
            <div class="proposal-id">
              <h2 class="proposal-name">{p.name}</h2>
              <span class="occ-badge" title="{p.occurrences} session(s) surfaced this pattern">
                ×{p.occurrences}
              </span>
            </div>
            <span class="proposal-date mono">{fmtDate(p.createdAt)}</span>
          </div>

          <p class="proposal-desc">{p.description}</p>

          <dl class="meta-grid">
            <div class="meta-cell">
              <dt class="meta-label">Trigger</dt>
              <dd class="meta-val">{p.triggerContext || '—'}</dd>
            </div>
            <div class="meta-cell">
              <dt class="meta-label">Evidence</dt>
              <dd class="meta-val">
                {#if p.evidence.length}
                  <ul class="evidence">
                    {#each p.evidence as e (e)}<li class="mono">{e}</li>{/each}
                  </ul>
                {:else}<span class="muted">—</span>{/if}
              </dd>
            </div>
          </dl>

          <!-- Screened body preview (never raw). -->
          <div class="body-block">
            <span class="meta-label">Skill body (screened)</span>
            <pre class="body-pre">{expandedId === p.id ? p.body : p.bodyPreview}</pre>
            {#if p.bodyTruncated}
              <button
                class="link-btn"
                type="button"
                aria-expanded={expandedId === p.id}
                onclick={() => (expandedId = expandedId === p.id ? null : p.id)}
              >{expandedId === p.id ? 'Show less' : 'Show full body'}</button>
            {/if}
          </div>

          <!-- Operator actions. The approver is server-resolved — no actor field in any form. -->
          <div class="actions">
            <form method="POST" action="?/approve" use:enhance class="inline-form">
              <input type="hidden" name="proposalId" value={p.id} />
              <button class="btn primary" type="submit">Approve</button>
            </form>

            <button
              class="btn"
              type="button"
              aria-expanded={editingId === p.id}
              onclick={() => (editingId = editingId === p.id ? null : p.id)}
            >{editingId === p.id ? 'Cancel edit' : 'Edit then approve'}</button>

            <form method="POST" action="?/reject" use:enhance class="inline-form">
              <input type="hidden" name="proposalId" value={p.id} />
              <button class="btn danger" type="submit">Reject</button>
            </form>
          </div>

          {#if editingId === p.id}
            <form
              method="POST"
              action="?/editApprove"
              use:enhance={() =>
                async ({ update }) => {
                  editingId = null;
                  await update();
                }}
              class="edit-form"
            >
              <input type="hidden" name="proposalId" value={p.id} />
              <label class="field">
                <span class="field-label">Name (kebab-case skill id)</span>
                <input class="field-input mono" type="text" name="name" value={p.name} required />
              </label>
              <label class="field">
                <span class="field-label">Description</span>
                <input class="field-input" type="text" name="description" value={p.description} required />
              </label>
              <label class="field">
                <span class="field-label">Trigger context</span>
                <input
                  class="field-input"
                  type="text"
                  name="triggerContext"
                  value={p.triggerContext}
                  required
                />
              </label>
              <label class="field">
                <span class="field-label">Skill body (Markdown)</span>
                <textarea class="field-input body-edit mono" name="body" rows="10" required>{p.body}</textarea>
              </label>
              <p class="edit-hint">
                Your edit is recorded as your authorship (screened for secrets) and promoted. Renaming
                creates a new skill id; the original draft stays open.
              </p>
              <div class="actions">
                <button class="btn primary" type="submit">Save edit & approve</button>
              </div>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    width: 100%;
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
  .muted {
    color: var(--color-text-muted);
    font-style: italic;
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
  .warn-card {
    border-color: var(--color-warn, orange);
  }
  .empty-card {
    border-style: dashed;
  }
  .card-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    max-width: 70ch;
  }

  .proposal-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .proposal-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .proposal-id {
    display: flex;
    align-items: baseline;
    gap: var(--space-2, 0.5rem);
  }
  .proposal-name {
    font: var(--type-h2, var(--type-h1));
    color: var(--color-text);
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .occ-badge {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--color-accent);
    background: var(--color-accent-muted, transparent);
    border: var(--border-width, 1px) solid var(--color-accent);
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
  }
  .proposal-date {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .proposal-desc {
    font: var(--type-body-sm);
    color: var(--color-text);
    max-width: 80ch;
    margin: 0;
  }

  .meta-grid {
    display: flex;
    gap: var(--space-4, 1rem);
    flex-wrap: wrap;
    margin: 0;
  }
  .meta-cell {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    flex: 1 1 16rem;
    min-width: 0;
  }
  .meta-label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .meta-val {
    font-size: 0.8rem;
    color: var(--color-text-2);
    margin: 0;
  }
  .evidence {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.74rem;
    color: var(--color-text-2);
  }

  .body-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .body-pre {
    margin: 0;
    padding: 0.6rem 0.7rem;
    font-size: 0.76rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--color-bg, #03120e);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-2);
    max-height: 24rem;
    overflow: auto;
  }
  .link-btn {
    align-self: flex-start;
    appearance: none;
    background: none;
    border: 0;
    padding: 0;
    color: var(--color-accent);
    font-size: 0.74rem;
    cursor: pointer;
    text-decoration: underline;
  }
  .link-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .actions {
    display: flex;
    gap: var(--space-2, 0.5rem);
    align-items: center;
    flex-wrap: wrap;
  }
  .inline-form {
    margin: 0;
    display: inline-flex;
  }
  .btn {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.35rem 0.85rem;
    cursor: pointer;
    min-height: 30px;
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
    background: var(--color-accent);
    color: var(--color-text-inverse, var(--color-bg, #03120e));
    border-color: var(--color-accent);
  }
  .btn.danger {
    color: var(--color-error);
    border-color: var(--color-error);
  }
  .btn.danger:hover:not(:disabled) {
    background: var(--color-error);
    color: var(--color-text-inverse, var(--color-bg, #03120e));
  }

  .edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    border-top: 1px solid var(--color-border-faint, var(--color-border));
    padding-top: var(--space-3, 0.75rem);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .field-label {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .field-input {
    appearance: none;
    background: var(--color-bg, #03120e);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.4rem 0.6rem;
    font-size: 0.8rem;
    width: 100%;
    box-sizing: border-box;
  }
  .field-input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .body-edit {
    resize: vertical;
    line-height: 1.5;
  }
  .edit-hint {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    margin: 0;
    max-width: 70ch;
  }

  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error);
    margin: 0;
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success, var(--color-running, var(--color-accent)));
    margin: 0;
  }
</style>
