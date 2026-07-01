<script lang="ts">
  /**
   * NodeInspector — the click-to-inspect detail panel for the living scene.
   *
   * Shows a selected node's METADATA only (D-026): for jobs/sessions the status / project /
   * agent / timing / linked task; for projects the status + timing; for agents the slot + live
   * state; for memory/entity the label + kind + project. It NEVER surfaces screened content —
   * the scene's labels are already content-free, and this panel only reads the same derived
   * fields. Honest empty states (F-008): an absent field renders '—', never a fabricated value.
   * Relations are read from the live edge set (1-hop neighbours). Svelte 5 runes only.
   */
  import type { ForceNode, ForceLink } from '$lib/client/scene/scene-graph';

  interface Props {
    /** The selected node (null → the panel is hidden by the parent). */
    node: ForceNode;
    /** The live link set — used to list this node's 1-hop relations. */
    links: ForceLink[];
    /** Whether this node is currently pinned (dragged + fixed in place). */
    pinned?: boolean;
    /** Close the panel. */
    onclose: () => void;
    /** Release a pinned node back into the simulation. */
    onunpin?: () => void;
  }

  let { node, links, pinned = false, onclose, onunpin }: Props = $props();

  function srcId(l: ForceLink): string {
    return typeof l.source === 'string' ? l.source : (l.source as { id: string }).id;
  }
  function tgtId(l: ForceLink): string {
    return typeof l.target === 'string' ? l.target : (l.target as { id: string }).id;
  }
  function shortId(id: string | undefined): string {
    return id ? id.replace(/^[\w-]+:/, '') : '—';
  }
  function tableOf(id: string): string {
    const i = id.indexOf(':');
    return i >= 0 ? id.slice(0, i) : 'node';
  }

  // 1-hop relations off the live link set (both directions), de-duplicated.
  const relations = $derived.by(() => {
    const out: Array<{ kind: string; other: string; dir: 'out' | 'in' }> = [];
    const seen = new Set<string>();
    for (const l of links) {
      const s = srcId(l);
      const t = tgtId(l);
      if (s === node.id || t === node.id) {
        const other = s === node.id ? t : s;
        const dir: 'out' | 'in' = s === node.id ? 'out' : 'in';
        const key = `${l.kind}:${dir}:${other}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: l.kind, other, dir });
      }
    }
    return out;
  });

  /** ISO → an absolute + relative time, or '—' when absent (F-013, never str(NONE)). */
  function when(at: string | undefined): string {
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

  // Within-class kind (e.g. memory: semantic) parsed off the content-free label, never raw content.
  const kindLabel = $derived(
    node.subclass === 'memory' && node.label.includes(':') ? node.label.split(':')[1].trim() : undefined
  );

  // S4 — the SELF node's derived soul detail (only present on the identity node). Metadata only.
  const soul = $derived(node.self);
  /** Competence in [0,1] → a percentage, or an honest 'unknown' when the sample is too small. */
  function competenceLabel(c: number | null | undefined): string {
    return typeof c === 'number' ? `${Math.round(c * 100)}%` : 'unknown';
  }
</script>

<aside class="inspector" aria-label="Node details">
  <header class="ins-head">
    <span class="ins-class" data-class={node.class}>{node.class}</span>
    <button type="button" class="ins-close" onclick={onclose} aria-label="Close details">×</button>
  </header>

  <h3 class="ins-title">{node.label}</h3>
  <p class="ins-id mono">{shortId(node.id)}</p>

  <dl class="ins-fields">
    <div class="ins-row">
      <dt>status</dt>
      <dd><span class="ins-status" data-status={node.status}>{node.status || '—'}</span></dd>
    </div>

    {#if node.subclass === 'session' || node.subclass === 'work_item'}
      <div class="ins-row">
        <dt>type</dt>
        <dd class="mono">{node.subclass}</dd>
      </div>
      <div class="ins-row">
        <dt>project</dt>
        <dd class="mono">{shortId(node.project)}</dd>
      </div>
      <div class="ins-row">
        <dt>agent</dt>
        <dd class="mono">{node.agent ?? '—'}</dd>
      </div>
      <div class="ins-row">
        <dt>task</dt>
        <dd class="mono">{shortId(node.task)}</dd>
      </div>
      <div class="ins-row">
        <dt>started</dt>
        <dd class="mono" title={node.at ?? ''}>{when(node.at)}</dd>
      </div>
    {:else if node.subclass === 'project'}
      <div class="ins-row">
        <dt>created</dt>
        <dd class="mono" title={node.at ?? ''}>{when(node.at)}</dd>
      </div>
    {:else if node.subclass === 'self' && soul}
      <!-- S4 identity — maturity + competence + experience volume (all derived from live rows). -->
      <div class="ins-row">
        <dt>maturity</dt>
        <dd class="mono">{soul.maturityStage}</dd>
      </div>
      <div class="ins-row">
        <dt>competence</dt>
        <dd class="mono">{competenceLabel(soul.competence)}</dd>
      </div>
      <div class="ins-row">
        <dt>concepts</dt>
        <dd class="mono">{soul.experience.concepts}</dd>
      </div>
      <div class="ins-row">
        <dt>corrections</dt>
        <dd class="mono">{soul.experience.corrections}</dd>
      </div>
      <div class="ins-row">
        <dt>sessions</dt>
        <dd class="mono">{soul.experience.sessions}</dd>
      </div>
    {:else if node.subclass === 'agent'}
      <div class="ins-row">
        <dt>slot</dt>
        <dd class="mono">{node.label}</dd>
      </div>
      <div class="ins-row">
        <dt>last active</dt>
        <dd class="mono" title={node.at ?? ''}>{when(node.at)}</dd>
      </div>
    {:else if node.subclass === 'concept'}
      <!-- S3 concept — its summary + provenance. summary was screened before store (clean). -->
      <div class="ins-row">
        <dt>project</dt>
        <dd class="mono">{shortId(node.project)}</dd>
      </div>
      <div class="ins-row">
        <dt>first seen</dt>
        <dd class="mono" title={node.at ?? ''}>{when(node.at)}</dd>
      </div>
    {:else if node.subclass === 'causal' || node.subclass === 'skill' || node.subclass === 'correction'}
      <div class="ins-row">
        <dt>type</dt>
        <dd class="mono">{node.subclass}</dd>
      </div>
      <div class="ins-row">
        <dt>created</dt>
        <dd class="mono" title={node.at ?? ''}>{when(node.at)}</dd>
      </div>
    {:else}
      <!-- memory / entity -->
      {#if kindLabel}
        <div class="ins-row">
          <dt>kind</dt>
          <dd class="mono">{kindLabel}</dd>
        </div>
      {/if}
      <div class="ins-row">
        <dt>project</dt>
        <dd class="mono">{shortId(node.project)}</dd>
      </div>
    {/if}
  </dl>

  {#if node.subclass === 'concept' && node.summary}
    <!-- The concept's screened summary (D-026: screened before store, safe to surface). -->
    <p class="ins-summary">{node.summary}</p>
  {/if}

  {#if node.subclass === 'self' && soul}
    <!-- S4 soul detail — the honest self-model (screened at store time; loadSoul reads clean rows). -->
    <p class="ins-summary">{soul.summary}</p>
    {#if soul.knowsAbout.length}
      <div class="soul-block">
        <span class="eyebrow">knows about</span>
        <ul class="soul-tags">
          {#each soul.knowsAbout as label (label)}
            <li class="soul-tag">{label}</li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if soul.values.length}
      <div class="soul-block">
        <span class="eyebrow">learned values</span>
        <ul class="soul-vals">
          {#each soul.values as v (v)}
            <li>{v}</li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if soul.gates.length}
      <div class="soul-block">
        <span class="eyebrow">
          {#if soul.maturityStage === 'established'}gates met{:else}to graduate next{/if}
        </span>
        <ul class="soul-gates">
          {#each soul.gates as g (g.gate)}
            <li class="soul-gate" data-pass={g.pass}>
              <span class="gate-mark" aria-hidden="true">{g.pass ? '✓' : '○'}</span>
              <span class="gate-detail mono">{g.detail}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}

  {#if pinned && onunpin}
    <button type="button" class="ins-unpin" onclick={onunpin}>Release pin</button>
  {/if}

  <div class="ins-rel">
    <span class="eyebrow">{relations.length} {relations.length === 1 ? 'relation' : 'relations'}</span>
    {#if relations.length}
      <ul class="rel-list">
        {#each relations as r (r.kind + r.dir + r.other)}
          <li class="rel">
            <span class="rel-kind mono">{r.kind}</span>
            <span class="rel-dir" aria-hidden="true">{r.dir === 'out' ? '→' : '←'}</span>
            <span class="rel-other mono" title={r.other}>
              <span class="rel-table">{tableOf(r.other)}</span>{shortId(r.other)}
            </span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="ins-empty">No relations to other nodes in view.</p>
    {/if}
  </div>
</aside>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.75rem);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-card);
    max-height: 100%;
    overflow-y: auto;
  }
  .ins-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .ins-class {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-inverse);
  }
  .ins-class[data-class='memory'] { background: var(--color-accent); }
  .ins-class[data-class='job'] { background: var(--color-running); }
  .ins-class[data-class='project'] { background: var(--color-blocked); }
  .ins-class[data-class='agent'] { background: var(--color-info); }
  .ins-class[data-class='concept'] { background: var(--color-tier-opus); }
  .ins-class[data-class='causal'] { background: var(--color-warn); }
  .ins-class[data-class='skill'] { background: var(--color-success); }
  .ins-class[data-class='correction'] { background: var(--color-error); }
  .ins-class[data-class='self'] { background: var(--color-accent); }
  .ins-summary {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
    padding: var(--space-2, 0.5rem);
    background: var(--color-surface-overlay);
    border-radius: var(--radius-sm, 6px);
    overflow-wrap: anywhere;
  }
  .ins-close {
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .ins-close:hover { color: var(--color-text); }
  .ins-close:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
  .ins-title {
    font: var(--type-body);
    color: var(--color-text);
    margin: 0;
    overflow-wrap: anywhere;
  }
  .ins-id {
    font-size: 0.66rem;
    color: var(--color-text-muted);
    margin: 0;
  }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .ins-fields {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0;
  }
  .ins-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .ins-row dt {
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .ins-row dd {
    margin: 0;
    font-size: 0.72rem;
    color: var(--color-text-2);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 18ch;
  }
  .ins-status {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--color-text-2);
  }
  .ins-status[data-status='running'],
  .ins-status[data-status='active'] { color: var(--color-running); }
  .ins-status[data-status='done'] { color: var(--color-success); }
  .ins-status[data-status='failed'],
  .ins-status[data-status='cancelled'] { color: var(--color-error); }
  .ins-status[data-status='pending'] { color: var(--color-info); }
  .ins-status[data-status='paused'],
  .ins-status[data-status='idle'] { color: var(--color-neutral); }
  .ins-unpin {
    align-self: flex-start;
    font-size: 0.68rem;
    color: var(--color-text-2);
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.2rem 0.55rem;
    cursor: pointer;
  }
  .ins-unpin:hover { border-color: var(--color-accent); }
  .ins-rel {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-2, 0.5rem);
  }
  .rel-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    max-height: 14rem;
    overflow-y: auto;
  }
  .rel {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .rel-kind {
    font-size: 0.64rem;
    color: var(--color-accent);
    min-width: 8ch;
  }
  .rel-dir { color: var(--color-text-muted); }
  .rel-other {
    font-size: 0.7rem;
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rel-table { color: var(--color-text-muted); }
  .ins-empty {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    margin: 0;
  }
  /* S4 soul detail blocks. */
  .soul-block {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .soul-tags {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .soul-tag {
    font-size: 0.66rem;
    color: var(--color-text-2);
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.1rem 0.4rem;
  }
  .soul-vals {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .soul-vals li {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    padding-left: 0.6rem;
    border-left: 2px solid var(--color-error);
    overflow-wrap: anywhere;
  }
  .soul-gates {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .soul-gate {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .gate-mark { color: var(--color-neutral); font-size: 0.7rem; }
  .soul-gate[data-pass='true'] .gate-mark { color: var(--color-success); }
  .gate-detail {
    font-size: 0.68rem;
    color: var(--color-text-2);
  }
</style>
