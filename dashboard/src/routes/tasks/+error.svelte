<script lang="ts">
	import { page } from '$app/state';
	import * as Sentry from '@sentry/sveltekit';

	$effect(() => {
		if (page.error) {
			Sentry.captureException(page.error, {
				tags: { route: '/tasks', status: page.status, component: 'tasks-page' }
			});
		}
	});
</script>

<div class="flex items-center justify-center min-h-[60vh]">
	<div class="text-center">
		<p class="text-6xl font-bold font-mono text-accent-red mb-2">{page.status}</p>
		<h1 class="text-xl font-bold text-text-primary mb-2">Tasks Error</h1>
		<p class="text-sm text-text-secondary mb-6">{page.error?.message ?? 'Failed to load tasks.'}</p>
		<div class="flex gap-3 justify-center">
			<button
				onclick={() => location.reload()}
				class="px-4 py-2 text-sm bg-bg-tertiary text-text-primary rounded-lg hover:bg-bg-secondary transition-colors"
			>
				Retry
			</button>
			<a
				href="/"
				class="inline-block px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
			>
				Back to Home
			</a>
		</div>
	</div>
</div>
