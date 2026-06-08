<script lang="ts">
  import '$lib/styles/app.css';
  import Sidebar from '$lib/components/shell/Sidebar.svelte';
  import Topbar from '$lib/components/shell/Topbar.svelte';
  import Statusbar from '$lib/components/shell/Statusbar.svelte';
  import { page } from '$app/state';

  let { children } = $props();
  const pathname = $derived(page.url.pathname);
</script>

<div class="shell">
  <Sidebar {pathname} />
  <div class="shell-main">
    <Topbar />
    <main class="content">
      {@render children?.()}
    </main>
    <Statusbar />
  </div>
</div>

<style>
  .shell {
    display: flex;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .shell-main {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .content {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: var(--pad-panel);
  }
</style>
