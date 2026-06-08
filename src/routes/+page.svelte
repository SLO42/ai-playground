<script lang="ts">
  /**
   * Home — minimal scaffold so the design-system tokens visibly resolve.
   * Honest states: no fabricated metrics (F-008). Real data lands at 1.5.
   */
</script>

<section class="home">
  <header class="page-head">
    <span class="eyebrow">portfolio</span>
    <h1 class="title">Dashboard</h1>
    <p class="lede">
      Scaffold online. Design-system tokens resolved — sidebar, top bar, and
      status bar shells render. Live data wires in at task 1.5.
    </p>
  </header>

  <div class="card">
    <div class="card-head">
      <span class="eyebrow">status</span>
    </div>
    <p class="card-body">
      No projects yet — register one. <span class="mono">CODE_ROOT</span> scan
      and the SSE stream are not wired in this foundation scaffold.
    </p>
  </div>
</section>

<style>
  .home {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    max-width: 760px;
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
    max-width: 60ch;
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .card-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
</style>
