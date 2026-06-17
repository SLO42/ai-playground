<script lang="ts">
  /**
   * /agents/staffing — the CAPABILITY-MATCH-SPEC (BL-3) PROJECT STAFFING decision board.
   * Per project: its declared capability needs, the data-driven matcher recommendations
   * (REUSE / EXTEND / HIRE, evidence-cited from PROVEN coverage), the open staffing proposals,
   * and the operator-gated controls:
   *   • propose  — open a staffing proposal for a REUSE candidate (PROPOSE-ONLY)
   *   • confirm  — the D-039 confirm that writes the project_staff row (the only staff path)
   *   • reject   — close a staffing proposal
   *   • unstaff  — soft un-staff an enabled role
   * NO auto-staff: every staffing act needs an explicit operator confirm. Honest empties
   * (a project with no declared needs, a need no role proves → a HIRE gap). Live off the ONE
   * app:workforce SSE stream (D-035). Svelte 5 runes; design tokens; a11y (focus-visible,
   * reduced-motion respected by the global tokens; confirm controls gate the buttons).
   */
  import { invalidate } from '$app/navigation';
  import { enhance } from '$app/forms';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const connected = $derived(data.connected);
  const views = $derived(data.views ?? []);
  const vocabulary = $derived(data.vocabulary ?? []);
  const loadError = $derived('error' in data ? (data.error as string | undefined) : undefined);

  const fb = $derived(
    form && 'staffing' in form ? (form.staffing as Record<string, unknown>) : undefined
  );
  /** Feedback scoped to a candidate (project+role) or a proposal id. */
  function fbForRole(project: string, role: string): Record<string, unknown> | undefined {
    return fb && fb.project === project && fb.role === role ? fb : undefined;
  }
  function fbForProposal(proposal: string): Record<string, unknown> | undefined {
    return fb && fb.proposal === proposal ? fb : undefined;
  }

  // Live re-derive off the ONE SSE stream (D-035): a propose/confirm/reject/unstaff writes
  // review_proposal / project_staff / role_event rows — re-invalidate in place.
  $effect(() => {
    const offs = ['review_proposal', 'project_staff', 'role_event', 'role', 'project'].map((t) =>
      stream.onDbChange(t, () => void invalidate('app:workforce'))
    );
    return () => offs.forEach((off) => off());
  });

  // Per-action confirm ticks (the click IS the gate — buttons stay disabled until ticked).
  let confirmTick = $state<Record<string, boolean>>({});
  let unstaffTick = $state<Record<string, boolean>>({});
  let busy = $state<Record<string, boolean>>({});

  function tick(map: 'confirm' | 'unstaff', key: string, v: boolean) {
    if (map === 'confirm') confirmTick = { ...confirmTick, [key]: v };
    else unstaffTick = { ...unstaffTick, [key]: v };
  }
  function busyEnhance(key: string) {
    return () => {
      busy = { ...busy, [key]: true };
      return async ({ update }: { update: () => Promise<void> }) => {
        await update();
        busy = { ...busy, [key]: false };
      };
    };
  }

  /** The open staffing proposal for a candidate role on a project, or null. */
  function openProposalFor(view: PageData['views'][number], role: string) {
    return view.openProposals.find((p) => p.role === role) ?? null;
  }
  function isStaffed(view: PageData['views'][number], role: string): boolean {
    return view.staffedRoles.includes(role);
  }

  function matchLabel(m: string): string {
    return m === 'reuse' ? 'REUSE' : m === 'extend' ? 'EXTEND' : 'HIRE';
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">workforce · BL-3 capability matching</span>
    <h1 class="title">Project staffing</h1>
    <p class="lede">
      Data-driven staffing: for each project's declared capability needs, the matcher scores every
      catalog role's <strong>proven</strong> defect-class coverage and recommends REUSE (covers all),
      EXTEND (covers some), or HIRE (a gap). Nothing auto-staffs — a REUSE candidate is proposed, and
      the operator confirms (D-039) to write the staffing row.
    </p>
    {#if vocabulary.length}
      <p class="vocab" role="note">
        Operator-confirmed defect-class vocabulary:
        {#each vocabulary as cls (cls)}<code class="cls">{cls}</code>{/each}
      </p>
    {/if}
  </header>

  {#if !connected}
    <p class="empty" role="status">
      Database not connected{loadError ? ` — ${loadError}` : ''}. Start SurrealDB and retry.
    </p>
  {:else if views.length === 0}
    <p class="empty" role="status">
      No project has declared capability needs yet. Declare a project's needs (languages, frameworks,
      defect classes from the confirmed vocabulary) to see staffing recommendations here.
    </p>
  {:else}
    <ul class="projects" aria-label="project staffing views">
      {#each views as view (view.project)}
        {@const needs = view.match.needs}
        <li class="project card">
          <div class="p-head">
            <span class="proj-name">{view.projectName}</span>
            <span class="p-meta mono">
              {#if view.match.fullyCovered}<span class="ok-mark">fully covered</span>{:else}<span class="gap-mark">{view.match.gaps.length} gap(s)</span>{/if}
            </span>
          </div>

          <dl class="needs">
            <div><dt>languages</dt><dd>{needs.languages.length ? needs.languages.join(', ') : '—'}</dd></div>
            <div><dt>frameworks</dt><dd>{needs.frameworks.length ? needs.frameworks.join(', ') : '—'}</dd></div>
            <div>
              <dt>defect classes</dt>
              <dd>
                {#if needs.defect_classes.length}
                  {#each needs.defect_classes as c (c)}<code class="cls">{c}</code>{/each}
                {:else}—{/if}
              </dd>
            </div>
          </dl>

          {#if view.match.candidates.length === 0 && view.match.gaps.length === 0}
            <p class="muted" role="status">No defect-class needs declared — nothing to match.</p>
          {/if}

          {#if view.match.candidates.length}
            <ul class="candidates" aria-label="role recommendations">
              {#each view.match.candidates as c (c.role)}
                {@const open = openProposalFor(view, c.role)}
                {@const staffed = isStaffed(view, c.role)}
                {@const rfb = fbForRole(view.project, c.role)}
                <li class="candidate" data-match={c.match}>
                  <div class="c-head">
                    <span class="role-name">{c.roleName}</span>
                    <span class="match-tag" data-match={c.match}>{matchLabel(c.match)}</span>
                    {#if c.tier}<span class="tier-tag mono">{c.tier}</span>{/if}
                    {#if staffed}<span class="staffed-tag">staffed</span>{/if}
                  </div>
                  <p class="evidence">{c.evidence}</p>

                  {#if staffed}
                    <!-- Already staffed — offer the operator-gated soft un-staff. -->
                    <form method="POST" action="?/unstaff" use:enhance={busyEnhance(`unstaff:${view.project}:${c.role}`)} class="row">
                      <input type="hidden" name="project" value={view.project} />
                      <input type="hidden" name="role" value={c.role} />
                      <label class="confirm">
                        <input
                          type="checkbox" name="operatorConfirmed"
                          checked={unstaffTick[`${view.project}:${c.role}`] ?? false}
                          onchange={(e) => tick('unstaff', `${view.project}:${c.role}`, e.currentTarget.checked)}
                        />
                        <span>confirm un-staff</span>
                      </label>
                      <button class="btn ghost danger" type="submit"
                        disabled={!(unstaffTick[`${view.project}:${c.role}`]) || busy[`unstaff:${view.project}:${c.role}`]}>Un-staff</button>
                    </form>
                  {:else if open}
                    <!-- An open staffing proposal exists — the D-039 confirm / reject controls. -->
                    {@const pfb = fbForProposal(open.proposal)}
                    <div class="proposal-open" data-status={open.status}>
                      <span class="open-tag mono">proposal {open.status}</span>
                      <form method="POST" action="?/confirm" use:enhance={busyEnhance(`confirm:${open.proposal}`)} class="row">
                        <input type="hidden" name="proposal" value={open.proposal} />
                        <input class="note" type="text" name="charterNote" placeholder="charter note (optional)" maxlength="2000" />
                        <label class="confirm">
                          <input
                            type="checkbox" name="operatorConfirmed"
                            checked={confirmTick[open.proposal] ?? false}
                            onchange={(e) => tick('confirm', open.proposal, e.currentTarget.checked)}
                          />
                          <span>confirm staffing (D-039)</span>
                        </label>
                        <button class="btn primary" type="submit"
                          disabled={!(confirmTick[open.proposal]) || busy[`confirm:${open.proposal}`]}>Staff this role</button>
                      </form>
                      <form method="POST" action="?/reject" use:enhance={busyEnhance(`reject:${open.proposal}`)} class="row">
                        <input type="hidden" name="proposal" value={open.proposal} />
                        <input class="note" type="text" name="reason" placeholder="reason (optional)" maxlength="2000" />
                        <button class="btn ghost" type="submit" disabled={busy[`reject:${open.proposal}`]}>Reject</button>
                      </form>
                      {#if pfb?.error}<p class="warn" role="alert">{pfb.error}</p>{/if}
                    </div>
                  {:else if c.match === 'reuse'}
                    <!-- A REUSE candidate with no open proposal — the one-click PROPOSE. -->
                    <form method="POST" action="?/propose" use:enhance={busyEnhance(`propose:${view.project}:${c.role}`)} class="row">
                      <input type="hidden" name="project" value={view.project} />
                      <input type="hidden" name="role" value={c.role} />
                      <button class="btn ghost" type="submit" disabled={busy[`propose:${view.project}:${c.role}`]}>Propose staffing</button>
                    </form>
                  {:else}
                    <p class="muted">EXTEND — grow this role with domain fixtures + re-certify (operator-authored) before it can be staffed.</p>
                  {/if}
                  {#if rfb?.error}<p class="warn" role="alert">{rfb.error}</p>{/if}
                </li>
              {/each}
            </ul>
          {/if}

          {#if view.match.gaps.length}
            <div class="gaps">
              <span class="gaps-label">HIRE gaps — no catalog role proves these:</span>
              <ul class="gap-list">
                {#each view.match.gaps as g (g.defectClass)}
                  <li class="gap"><code class="cls">{g.defectClass}</code> <span class="gap-ev">{g.evidence}</span></li>
                {/each}
              </ul>
            </div>
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
    gap: var(--gap-stack, 1.5rem);
    padding: var(--space-5, 1.25rem);
    max-width: 64rem;
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .eyebrow {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-accent);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
    margin: 0;
  }
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    margin: 0;
    max-width: 52rem;
  }
  .vocab {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1, 0.25rem);
  }
  .cls {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xs);
    background: var(--color-surface-sunken, var(--color-surface-card));
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.05rem var(--space-1, 0.25rem);
    color: var(--color-text);
  }
  .empty,
  .muted {
    font: var(--type-body);
    color: var(--color-text-muted);
    margin: 0;
  }
  .empty {
    padding: var(--space-5);
    border: var(--border-width, 1px) dashed var(--color-border);
    border-radius: var(--radius-md, 10px);
  }
  .muted {
    font: var(--type-body-sm);
  }
  .warn {
    font: var(--type-body-sm);
    color: var(--color-warn);
    margin: var(--space-1, 0.25rem) 0 0;
  }
  .projects,
  .candidates,
  .gap-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .gap-list {
    gap: var(--space-2, 0.5rem);
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    padding: var(--space-4, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .p-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .proj-name {
    font: var(--weight-medium) var(--text-md, 1rem) / 1.2 var(--font-body, inherit);
    color: var(--color-text);
  }
  .mono {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .ok-mark {
    color: var(--color-success, var(--color-accent));
  }
  .gap-mark {
    color: var(--color-warn);
  }
  .needs {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1, 0.25rem) var(--space-3, 0.75rem);
    margin: 0;
    font: var(--type-body-sm);
  }
  .needs > div {
    display: contents;
  }
  .needs dt {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .needs dd {
    margin: 0;
    color: var(--color-text);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1, 0.25rem);
    align-items: center;
  }
  .candidate {
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-3, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .candidate[data-match='reuse'] {
    border-left: 3px solid var(--color-success, var(--color-accent));
  }
  .candidate[data-match='extend'] {
    border-left: 3px solid var(--color-warn);
  }
  .c-head {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .role-name {
    font: var(--weight-medium) var(--text-sm) / 1.2 var(--font-body, inherit);
    color: var(--color-text);
  }
  .match-tag,
  .tier-tag,
  .staffed-tag,
  .open-tag {
    font-size: var(--text-xs);
    padding: var(--space-1, 0.2rem) var(--space-2, 0.5rem);
    border-radius: var(--radius-sm, 6px);
    border: var(--border-width, 1px) solid var(--color-border);
    color: var(--color-text-muted);
  }
  .match-tag[data-match='reuse'] {
    color: var(--color-success, var(--color-accent));
    border-color: var(--color-success, var(--color-accent));
  }
  .match-tag[data-match='extend'] {
    color: var(--color-warn);
    border-color: var(--color-warn);
  }
  .staffed-tag {
    color: var(--color-success, var(--color-accent));
    border-color: var(--color-success, var(--color-accent));
  }
  .evidence {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .note {
    flex: 1 1 12rem;
    min-width: 8rem;
    padding: var(--space-1, 0.3rem) var(--space-2, 0.5rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-sunken, var(--color-surface-card));
    color: var(--color-text);
    font: var(--type-body-sm);
  }
  .confirm {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 0.3rem);
    font: var(--type-body-sm);
    color: var(--color-text);
  }
  .proposal-open {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-2, 0.5rem);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-sunken, var(--color-surface-card));
  }
  .btn {
    font: var(--type-body-sm);
    padding: var(--space-1, 0.35rem) var(--space-3, 0.75rem);
    border-radius: var(--radius-sm, 6px);
    border: var(--border-width, 1px) solid var(--color-border);
    background: var(--color-surface-card);
    color: var(--color-text);
    cursor: pointer;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.primary {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-on-accent, var(--color-bg, #fff));
  }
  .btn.ghost {
    background: transparent;
  }
  .btn.danger {
    color: var(--color-warn);
    border-color: var(--color-warn);
  }
  .gaps {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding-top: var(--space-2, 0.5rem);
    border-top: var(--border-width, 1px) dashed var(--color-border);
  }
  .gaps-label {
    font: var(--type-body-sm);
    color: var(--color-warn);
  }
  .gap {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    display: flex;
    gap: var(--space-2, 0.5rem);
    align-items: baseline;
    flex-wrap: wrap;
  }
  .gap-ev {
    color: var(--color-text-muted);
  }
</style>
