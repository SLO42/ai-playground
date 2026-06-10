<script lang="ts">
  /**
   * Root error boundary (14.3 DoD-review fix — WCAG 2.4.2 Level A).
   *
   * 14.3 removed the static <title> from app.html so per-route titles could own
   * the head — but no +error.svelte existed, so SvelteKit's built-in default
   * error component rendered 404/500 responses with NO <title> at all. Every
   * edge state ships a unique, status-aware title (D-038), and the page itself
   * is an honest error surface: real status + message, tokens only, no chrome
   * loss (it renders inside the shell so navigation stays available).
   */
  import { page } from '$app/state';

  const status = $derived(page.status);
  const heading = $derived(status === 404 ? 'Not found' : `Error ${status}`);
  const detail = $derived(
    status === 404
      ? 'No page lives at this address — the link may be stale or the resource was removed.'
      : (page.error?.message ?? 'Something went wrong while rendering this page.')
  );
</script>

<svelte:head>
  <title>{heading} — Atelier</title>
</svelte:head>

<section class="error-page" aria-labelledby="error-heading">
  <p class="status-code" aria-hidden="true">{status}</p>
  <h1 id="error-heading">{heading}</h1>
  <p class="detail">{detail}</p>
  <a class="home-link" href="/">Back to overview</a>
</section>

<style>
  .error-page {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    text-align: center;
    padding: var(--space-10) var(--page-gutter);
  }
  .status-code {
    margin: 0;
    font: var(--type-mono);
    color: var(--color-text-muted);
    letter-spacing: var(--tracking-caps);
  }
  h1 {
    margin: 0;
  }
  .detail {
    margin: 0;
    font: var(--type-body);
    color: var(--color-text-2);
    max-width: 60ch;
  }
  .home-link {
    margin-top: var(--space-2);
    font: var(--type-body-sm);
    color: var(--color-text-link);
  }
</style>
