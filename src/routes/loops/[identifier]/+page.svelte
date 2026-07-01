<script lang="ts">
  /**
   * Loop detail — the per-loop REVIEW + CONFIGURE page (/loops/[identifier]; operator directive 2026-06-29
   * "Loops = first-class · visuals · review/modify/configure"). Surfaces ONE loop in depth: the loop-shape
   * VISUAL (primitives strip + L1→L2→L3 ladder), the running snapshot, the declared metadata (enabled /
   * override / timestamps / full checklist), the DEEP run history, and the controls — phase promote/demote +
   * enabled toggle (LoopManageControls), the readiness checklist (LoopReadiness), and arm/cadence
   * (LoopControls, for pm loops). ALL live from the DB (F-008): honest disconnected / declared-not-running /
   * running-undeclared / empty-history states, never fabricated. Live by default (§1.2). Svelte 5 runes;
   * design tokens only; a11y.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import LiveBadge from '$lib/components/shell/LiveBadge.svelte';
  import LoopShape from '$lib/components/loops/LoopShape.svelte';
  import LoopManageControls from '$lib/components/loops/LoopManageControls.svelte';
  import LoopReadiness from '$lib/components/loops/LoopReadiness.svelte';
  import LoopControls from '$lib/components/loops/LoopControls.svelte';
  import {
    phaseMeta,
    lastRunLabel,
    nextFireLabel,
    ticksLabel,
    relativeTime,
    orchConfigView
  } from '$lib/components/loops/loop-card-core';
  import { evaluateReadiness } from '$lib/components/loops/readiness-core';
  import type { ShapeSource } from '$lib/components/loops/loop-shape-core';
  import type { LoopView, LoopPhase } from '$lib/server/loops/read';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const loop = $derived<LoopView | null>(data.loop);
  const manifest = $derived(data.manifest);
  const runs = $derived(data.runs ?? []);
  const identifier = $derived(data.identifier);

  // Honest identity from whichever layer exists (running view preferred, manifest fallback).
  const title = $derived(loop?.name ?? manifest?.label ?? identifier);
  const kind = $derived(loop?.kind ?? manifest?.kind ?? 'orchestrator');
  const projectId = $derived(loop?.projectId ?? manifest?.projectId ?? null);
  const derivedPhase = $derived<LoopPhase>(loop?.phase ?? manifest?.phase ?? 'unknown');
  const phase = $derived(phaseMeta(derivedPhase));
  const declaredPhase = $derived(manifest?.phase ?? 'L1');
  const enabled = $derived(manifest?.enabled ?? true);
  const readiness = $derived(evaluateReadiness(manifest?.checklist));
  const orch = $derived(loop ? orchConfigView(loop) : null);
  const ticks = $derived(loop ? ticksLabel(loop) : null);

  const status = $derived(
    loop && manifest ? 'declared · running' : loop ? 'running · undeclared' : 'declared · not running'
  );

  // The shape visual's honest inputs — running view preferred, manifest fallback; never fabricated.
  const shapeSource = $derived<ShapeSource>({
    phase: derivedPhase,
    cadenceLabel: loop?.cadenceLabel ?? manifest?.cadence ?? null,
    stateLabel: loop?.stateLabel ?? (manifest ? 'declared · not currently running' : null),
    ticksUsed: loop?.ticksUsed ?? null,
    ticksMax: loop?.ticksMax ?? null
  });

  const activityLiveness = $derived(stream.tableLiveness('agent_event'));

  $effect(() => {
    const offs = [
      stream.onDbChange('agent_event', () => void invalidate('app:analytics')),
      stream.onDbChange('pm', () => void invalidate('app:pm')),
      stream.onDbChange('session', () => void invalidate('app:fleet')),
      stream.onDbChange('project', () => void invalidate('app:projects')),
      stream.onDbChange('loop', () => void invalidate('app:loops-manifest'))
    ];
    return () => offs.forEach((off) => off());
  });
</script>

<svelte:head>
  <title>{title} — Loops — Atelier</title>
</svelte:head>

<section class="detail">
  <header class="page-head">
    <a class="back" href="/loops">← Loops</a>
    <div class="head-row">
      <div class="head-titles">
        <span class="eyebrow">loop · {status}</span>
        <h1 class="title">{title}</h1>
        <span class="ident mono">{identifier}</span>
      </div>
      <div class="head-side">
        <span class="phase-badge" data-phase={derivedPhase} title={phase.title}>{phase.text}</span>
        <LiveBadge phase={activityLiveness} />
      </div>
    </div>
  </header>

  {#if !connected}
    <div class="card state" role="status">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — this loop cannot be read, so nothing is shown instead of a
        fabricated view. Start SurrealDB and reload.
      </p>
    </div>
  {:else}
    <LoopShape source={shapeSource} checklist={manifest?.checklist ?? null} />

    <div class="card">
      <h2 class="card-h">Snapshot</h2>
      {#if loop}
        <div class="lc-status">
          <span class="dot" data-tone={loop.tone} aria-hidden="true"></span>
          <span class="state-label" data-tone={loop.tone}>{loop.stateLabel}</span>
        </div>
        <dl class="facts">
          <div class="fact"><dt>cadence</dt><dd>{loop.cadenceLabel}</dd></div>
          <div class="fact"><dt>last run</dt><dd data-muted={!loop.lastRunAt}>{lastRunLabel(loop)}</dd></div>
          {#if loop.nextFireAt}
            <div class="fact"><dt>next fire</dt><dd title={loop.nextFireAt}>{nextFireLabel(loop.nextFireAt)}</dd></div>
          {/if}
          {#if ticks}
            <div class="fact"><dt>re-ticks</dt><dd class="mono">{ticks}<span class="unit"> this window</span></dd></div>
          {/if}
        </dl>
      {:else}
        <p class="state-body">
          Declared in the manifest but not currently running — its readiness is still reviewable and
          configurable below. It will surface a live snapshot once the loop is active.
        </p>
      {/if}

      {#if orch}
        <div class="orch">
          <dl class="facts">
            <div class="fact"><dt>configured mode</dt><dd>{orch.configured}</dd></div>
            <div class="fact"><dt>running mode</dt><dd data-muted={orch.running === 'not running'}>{orch.running}</dd></div>
            {#if orch.interval}<div class="fact"><dt>sweep interval</dt><dd>{orch.interval}</dd></div>{/if}
          </dl>
          <div class="orch-foot">
            <span class="sync" data-tone={orch.status.tone}>{orch.status.text}</span>
            <a class="link" href="/settings">Configure in Settings →</a>
          </div>
        </div>
      {/if}
    </div>

    <div class="card">
      <h2 class="card-h">Declaration</h2>
      <dl class="facts">
        <div class="fact"><dt>declared</dt><dd>{manifest ? 'yes' : 'no'}</dd></div>
        <div class="fact"><dt>enabled</dt><dd>{manifest ? (enabled ? 'enabled' : 'disabled') : '—'}</dd></div>
        <div class="fact"><dt>declared phase</dt><dd>{manifest ? declaredPhase : '—'}</dd></div>
        <div class="fact"><dt>readiness</dt><dd>{readiness.checked}/{readiness.total}{readiness.green ? ' · ready' : ''}</dd></div>
        <div class="fact"><dt>created</dt><dd data-muted={!manifest?.createdAt}>{manifest?.createdAt ? relativeTime(manifest.createdAt) : '—'}</dd></div>
        <div class="fact"><dt>updated</dt><dd data-muted={!manifest?.updatedAt}>{manifest?.updatedAt ? relativeTime(manifest.updatedAt) : '—'}</dd></div>
      </dl>
      {#if manifest?.override}
        <p class="override" role="note">
          <strong>Override recorded</strong> — the readiness gate was overridden{manifest.overrideReason ? `: "${manifest.overrideReason}"` : ''}
          {#if manifest.overrideAt}<span class="override-when"> ({relativeTime(manifest.overrideAt)})</span>{/if}.
        </p>
      {/if}

      <LoopManageControls
        {identifier}
        {kind}
        label={title}
        {projectId}
        phase={declaredPhase}
        {enabled}
      />
    </div>

    <div class="card">
      <LoopReadiness {identifier} {kind} label={title} {projectId} {manifest} />
    </div>

    {#if loop && (loop.kind === 'pm-cadence' || loop.kind === 'pm-autonomous')}
      <div class="card">
        <h2 class="card-h">Arm &amp; schedule</h2>
        <LoopControls {loop} {readiness} override={manifest?.override === true} />
      </div>
    {/if}

    <div class="card">
      <h2 class="card-h">
        Run history
        <span class="count mono" aria-hidden="true">{runs.length}{runs.length >= data.runLimit ? '+' : ''}</span>
      </h2>
      {#if runs.length === 0}
        <p class="state-body">
          {#if data.tracksHistory}No runs recorded yet — this loop has not fired.{:else}This loop keeps no per-run history by design (it writes no run events).{/if}
        </p>
      {:else}
        <ul class="runs">
          {#each runs as run, i (i)}
            <li class="run">
              <span class="run-outcome" data-outcome={run.outcome}>{run.outcome}</span>
              <span class="run-detail" title={run.detailScreened || undefined}>
                {#if run.detailScreened}{run.detailScreened}{:else}<span class="run-none">no detail</span>{/if}
              </span>
              <span class="run-when">{relativeTime(run.at)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    width: 100%;
  }
  .page-head { display: flex; flex-direction: column; gap: var(--space-2); }
  .back {
    font-size: var(--text-sm, 0.82rem);
    color: var(--color-text-link);
    text-decoration: none;
    width: fit-content;
  }
  .back:hover { text-decoration: underline; }
  .back:focus-visible { outline: 2px solid var(--color-text-link); outline-offset: 2px; border-radius: var(--radius-sm); }
  .head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
  .head-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .head-side { display: flex; align-items: center; gap: var(--space-3); flex: 0 0 auto; }
  .eyebrow {
    font-size: var(--text-xs, 0.72rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .title { font: var(--type-h1); color: var(--color-text); }
  .ident { font-size: var(--text-xs, 0.72rem); color: var(--color-text-muted); }
  .mono { font-family: var(--font-mono); }
  .phase-badge {
    font-size: var(--text-xs, 0.72rem);
    font-weight: var(--weight-semibold, 600);
    padding: 0 var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
  }
  .phase-badge[data-phase='L3'] { color: var(--color-text-accent, var(--color-accent)); border-color: var(--color-accent); }
  .phase-badge[data-phase='L2'] { color: var(--color-text); }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card);
  }
  .card-h {
    font: var(--type-h3);
    color: var(--color-text);
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .count { font-size: var(--text-sm, 0.82rem); color: var(--color-text-muted); font-weight: var(--weight-regular, 400); }
  .state { display: flex; flex-direction: column; gap: var(--space-2); }
  .state-body { font: var(--type-body-sm); color: var(--color-text-2); max-width: 72ch; }

  .lc-status { display: inline-flex; align-items: center; gap: var(--space-2); }
  .dot { width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--color-neutral); flex: 0 0 auto; }
  .dot[data-tone='running'] { background: var(--color-running); animation: dot-pulse var(--motion-slow, 1.6s) ease-in-out infinite; }
  .dot[data-tone='done'] { background: var(--color-success); }
  .dot[data-tone='blocked'] { background: var(--color-blocked); }
  .dot[data-tone='warning'] { background: var(--color-warn); }
  @keyframes dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  .state-label { font-size: var(--text-sm, 0.82rem); color: var(--color-text-2); }

  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--space-3); margin: 0; }
  .fact { display: flex; flex-direction: column; gap: 2px; }
  .fact dt { font-size: var(--text-xs, 0.68rem); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-muted); }
  .fact dd { margin: 0; font-size: var(--text-sm, 0.82rem); color: var(--color-text); }
  .fact dd[data-muted='true'] { color: var(--color-text-muted); }
  .unit { color: var(--color-text-muted); font-size: var(--text-xs, 0.7rem); }

  .orch { display: flex; flex-direction: column; gap: var(--space-2); border-top: 1px solid var(--color-border-faint, var(--color-border)); padding-top: var(--space-3); }
  .orch-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .sync {
    font-size: var(--text-xs, 0.7rem);
    font-weight: var(--weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0 var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
  }
  .sync[data-tone='warning'] { color: var(--color-warn); border-color: var(--color-warn); }
  .sync[data-tone='done'] { color: var(--color-success); border-color: var(--color-success); }
  .link { font-size: var(--text-sm, 0.82rem); color: var(--color-text-link); text-decoration: none; white-space: nowrap; }
  .link:hover { text-decoration: underline; }
  .link:focus-visible { outline: 2px solid var(--color-text-link); outline-offset: 2px; border-radius: var(--radius-sm); }

  .override { margin: 0; font-size: var(--text-xs, 0.72rem); color: var(--color-text-2); }
  .override strong { color: var(--color-text); font-weight: var(--weight-semibold, 600); }
  .override-when { color: var(--color-text-muted); }

  .runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .run { display: flex; align-items: baseline; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border-faint, var(--color-border)); }
  .run:last-child { border-bottom: none; }
  .run-outcome { font-size: var(--text-xs, 0.68rem); font-weight: var(--weight-semibold, 600); color: var(--color-text-muted); min-width: 5.5rem; }
  .run-outcome[data-outcome='completion'] { color: var(--color-success); }
  .run-outcome[data-outcome='spawn'] { color: var(--color-running); }
  .run-outcome[data-outcome='error'],
  .run-outcome[data-outcome='escalation'] { color: var(--color-error); }
  .run-detail { flex: 1; min-width: 0; font-size: var(--text-xs, 0.74rem); color: var(--color-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-none { color: var(--color-text-muted); font-style: italic; }
  .run-when { font-size: var(--text-xs, 0.7rem); color: var(--color-text-muted); margin-left: auto; white-space: nowrap; }
</style>
