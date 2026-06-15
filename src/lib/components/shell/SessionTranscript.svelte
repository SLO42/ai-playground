<script lang="ts">
  /**
   * SessionTranscript — the ONE kind-aware transcript renderer shared by both Sessions
   * surfaces (the /claude-code replay and the projects/[id] live transcript). It takes a
   * normalized `turns: Turn[]` (mapped from persisted rows or live-streamed events via
   * transcript-core) and frames each turn BY KIND so the two pages can never diverge:
   *
   *   • briefing     → an accent-bordered "woke up with" block, fenced recall parsed into
   *                    its distinct items (source · citation · body).
   *   • thinking     → a COLLAPSIBLE turn (default collapsed; thinking is secondary to prose).
   *                    HONEST-EMPTY (F-008): empty thinking shows "(empty)" / "(no thinking
   *                    recorded)" — an elided thinking turn, NEVER blank-as-assistant.
   *   • tool_use     → tool name + compact one-line input (honest — no fabricated "{}").
   *   • tool_result  → result block with an ok/error badge (omitted when the outcome is unknown).
   *   • assistant    → prose (also the honest fallback for result/system/user/legacy rows).
   *
   * Tokens-only; a11y — the thinking toggle is a real <button> with aria-expanded + a
   * focus-visible ring; the log is a role="log" region the parent labels. Reduced-motion safe.
   * Svelte 5 RUNES only.
   */
  import {
    parseBriefing,
    compactToolInput,
    toolName,
    toolOk,
    type Turn
  } from '$lib/client/transcript-core';

  interface Props {
    /** Normalized turns, oldest-first. Empty array → the parent shows its own empty state. */
    turns: Turn[];
  }
  let { turns }: Props = $props();

  // Per-turn collapsible THINKING state, keyed by turn id (default collapsed — thinking is
  // secondary to the prose). Lives here so both host pages get identical behaviour for free.
  let thinkingOpen = $state<Record<string, boolean>>({});
  function toggleThinking(id: string): void {
    thinkingOpen = { ...thinkingOpen, [id]: !thinkingOpen[id] };
  }
</script>

{#each turns as t (t.id)}
  {#if t.kind === 'briefing'}
    {@const items = parseBriefing(t.content)}
    <!-- Wake-up briefing carried in the transcript (recalled context, TASK 8.3). -->
    <div class="tp-briefing" role="note" aria-label="wake-up briefing — recalled context">
      <div class="tp-briefing-lead">
        <span class="tp-briefing-icon" aria-hidden="true">◆</span>
        <span class="tp-briefing-title">woke up with</span>
        <span class="tp-briefing-count mono"
          >{items.length} recalled {items.length === 1 ? 'item' : 'items'}</span
        >
      </div>
      {#if items.length}
        <ul class="tp-briefing-items">
          {#each items as it, j (j)}
            <li class="tp-briefing-item">
              <span class="tp-briefing-tag mono"
                >{it.source}{#if it.citation}&nbsp;[#{it.citation}]{/if}</span
              >
              <span class="tp-briefing-body mono">{it.body}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="tp-empty">(no recalled context recorded for this wake-up)</p>
      {/if}
    </div>
  {:else if t.kind === 'thinking'}
    <!-- Collapsible thinking (default collapsed; honest-empty). -->
    <div class="tp-turn thinking">
      <button
        class="tp-think-toggle"
        type="button"
        aria-expanded={!!thinkingOpen[t.id]}
        onclick={() => toggleThinking(t.id)}
      >
        <span class="tp-tag">thinking</span>
        <span class="tp-caret" aria-hidden="true">{thinkingOpen[t.id] ? '▾' : '▸'}</span>
        {#if !t.content.trim()}<span class="tp-empty">(empty)</span>{/if}
      </button>
      {#if thinkingOpen[t.id]}
        <div class="tp-body mono tp-think-body">
          {#if t.content.trim()}{t.content}{:else}<span class="tp-empty"
              >(no thinking recorded for this turn)</span
            >{/if}
        </div>
      {/if}
    </div>
  {:else if t.kind === 'tool_use'}
    {@const input = compactToolInput(t.toolCall)}
    <div class="tp-turn tool-use">
      <span class="tp-tag tool">tool</span>
      <span class="tp-tool-name mono">{toolName(t.toolCall)}</span>
      {#if input}<span class="tp-tool-input mono">{input}</span>{/if}
    </div>
  {:else if t.kind === 'tool_result'}
    {@const tc = t.toolCall}
    {@const ok = toolOk(tc)}
    <div class="tp-turn tool-result" data-ok={ok === null ? '' : String(ok)}>
      <span class="tp-tag result">result</span>
      {#if tc && typeof tc.name === 'string'}<span class="tp-tool-name mono">{tc.name}</span>{/if}
      {#if ok !== null}
        <span class="tp-ok" data-ok={String(ok)}>{ok ? 'ok' : 'error'}</span>
      {/if}
      {#if t.content.trim()}<span class="tp-body mono">{t.content}</span>{/if}
    </div>
  {:else}
    <!-- assistant prose (also the honest fallback for result/system/user/legacy rows). The
         tag reflects the row role so a user/system row is labelled honestly, not "assistant". -->
    <div class="tp-turn assistant">
      <span class="tp-tag">{t.tag ?? 'assistant'}</span>
      <span class="tp-body">{t.content}</span>
    </div>
  {/if}
{/each}

<style>
  .tp-turn {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.4rem 0.55rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    min-width: 0;
  }
  .tp-tag {
    font-size: 0.64rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    flex: none;
  }
  .tp-turn.assistant .tp-tag {
    color: var(--color-accent);
  }
  .tp-tag.tool,
  .tp-tag.result {
    color: var(--color-tier-sonnet, var(--color-accent));
  }
  .tp-body {
    font: var(--type-body-sm);
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
    min-width: 0;
    flex: 1 1 100%;
  }
  .tp-turn.thinking {
    flex-direction: column;
    align-items: stretch;
    background: var(--color-surface-card);
  }
  .tp-think-toggle {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--color-text-muted);
    text-align: left;
  }
  .tp-think-toggle:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-xs, 3px);
  }
  .tp-caret {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .tp-think-body {
    margin-top: var(--space-2, 0.5rem);
    color: var(--color-text-2);
    font-size: 0.76rem;
  }
  .tp-empty {
    color: var(--color-text-muted);
    font-style: italic;
    font-size: 0.72rem;
  }
  .tp-tool-name {
    font-size: 0.76rem;
    color: var(--color-text);
    font-weight: 600;
    flex: none;
  }
  .tp-tool-input {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1 1 auto;
  }
  .tp-ok {
    font-size: 0.66rem;
    font-weight: 600;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    flex: none;
  }
  .tp-ok[data-ok='true'] {
    color: var(--color-success, var(--color-running));
    background: var(--color-success-bg, transparent);
  }
  .tp-ok[data-ok='false'] {
    color: var(--color-error-on-overlay);
    background: var(--color-error-bg, transparent);
  }

  /* TASK 8.3 — the wake-up briefing: a DISTINCT, accent-bordered "woke up with" block so the
     recalled context the agent started with is unmistakable, never a normal transcript line. */
  .tp-briefing {
    border: var(--border-width, 1px) solid var(--color-accent);
    border-left-width: 3px;
    border-radius: var(--radius-sm, 5px);
    background: var(--color-bg-inset, #03120e);
    padding: var(--space-3, 8px) var(--space-4, 12px);
    margin: var(--space-1, 2px) 0 var(--space-3, 8px);
    animation: tp-briefing-in 0.18s ease-out;
  }
  .tp-briefing-lead {
    display: flex;
    align-items: center;
    gap: var(--space-3, 8px);
    margin-bottom: var(--space-3, 8px);
  }
  .tp-briefing-icon {
    color: var(--color-accent);
    font-size: 0.7rem;
    line-height: 1;
  }
  .tp-briefing-title {
    color: var(--color-accent);
    font-weight: 600;
    font-size: 0.74rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .tp-briefing-count {
    color: var(--color-text-muted);
    font-size: 0.7rem;
    margin-left: auto;
  }
  .tp-briefing-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 8px);
  }
  .tp-briefing-item {
    display: flex;
    gap: var(--space-3, 8px);
    align-items: baseline;
    font-size: 0.76rem;
  }
  .tp-briefing-tag {
    flex: none;
    align-self: flex-start;
    color: var(--color-on-accent, #0a0f0d);
    background: var(--color-accent);
    border-radius: var(--radius-xs, 3px);
    padding: 1px var(--space-3, 8px);
    font-size: 0.66rem;
    white-space: nowrap;
  }
  .tp-briefing-body {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  @keyframes tp-briefing-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tp-briefing {
      animation: none;
    }
  }
</style>
