<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import * as Sentry from '@sentry/sveltekit';

	let eventId = $state<string | undefined>(undefined);

	let title = $derived(
		page.status === 404
			? 'Page Not Found'
			: page.status === 500
				? 'Something Went Wrong'
				: 'Error'
	);

	$effect(() => {
		if (page.error) {
			const id = Sentry.captureException(page.error, {
				tags: { route: page.url?.pathname, status: page.status }
			});
			eventId = id;
		}
	});

	function retry() {
		window.location.reload();
	}

	function goBack() {
		if (window.history.length > 1) {
			window.history.back();
		} else {
			goto('/');
		}
	}
</script>

<svelte:head>
	<title>{page.status} — {title} | OpenClaw</title>
	<meta name="description" content="{title}. The page you were looking for could not be loaded." />
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="flex items-center justify-center min-h-[60vh]">
	<div class="text-center max-w-md mx-auto px-4">
		<p class="text-6xl font-bold font-mono text-accent-blue mb-2">{page.status}</p>

		{#if page.status === 500}
			<h1 class="text-xl font-bold text-text-primary mb-2">Something went wrong on our end</h1>
			<p class="text-sm text-text-secondary mb-2">
				An unexpected server error occurred. The issue has been automatically reported and we'll look into it.
			</p>
			{#if eventId}
				<p class="text-xs text-text-secondary/60 font-mono mb-6">Reference: {eventId}</p>
			{:else}
				<div class="mb-6"></div>
			{/if}
			<div class="flex flex-col sm:flex-row items-center justify-center gap-3">
				<button
					onclick={retry}
					class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
				>
					Try Again
				</button>
				<button
					onclick={goBack}
					class="px-4 py-2 text-sm bg-bg-secondary text-text-primary rounded-lg hover:bg-bg-secondary/80 transition-colors"
				>
					Go Back
				</button>
				<a
					href="/"
					class="px-4 py-2 text-sm text-accent-blue hover:underline transition-colors"
				>
					Dashboard
				</a>
			</div>
		{:else if page.status === 404}
			<h1 class="text-xl font-bold text-text-primary mb-2">{title}</h1>
			<p class="text-sm text-text-secondary mb-2">{page.error?.message ?? 'An unexpected error occurred.'}</p>
			<p class="text-sm text-text-secondary mb-6">
				The page <code class="px-1.5 py-0.5 bg-bg-secondary rounded text-text-primary text-xs">{page.url?.pathname}</code> doesn't exist.
			</p>
			<div class="flex flex-col sm:flex-row items-center justify-center gap-3">
				<a
					href="/"
					class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
				>
					Back to Dashboard
				</a>
				<button
					onclick={goBack}
					class="px-4 py-2 text-sm bg-bg-secondary text-text-primary rounded-lg hover:bg-bg-secondary/80 transition-colors"
				>
					Go Back
				</button>
			</div>
		{:else}
			<h1 class="text-xl font-bold text-text-primary mb-2">{title}</h1>
			<p class="text-sm text-text-secondary mb-6">{page.error?.message ?? 'An unexpected error occurred.'}</p>
			<a
				href="/"
				class="inline-block px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
			>
				Back to Dashboard
			</a>
		{/if}
	</div>
</div>
