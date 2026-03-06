<script lang="ts">
	import { marked } from 'marked';
	import { browser } from '$app/environment';

	let { content = '' }: { content: string } = $props();

	// Configure marked for chat messages — compact output
	marked.setOptions({
		breaks: true,
		gfm: true
	});

	let rawHtml = $derived(marked.parse(content) as string);

	// DOMPurify only works in browser — skip sanitization during SSR
	let html = $derived.by(() => {
		if (!browser) return rawHtml;
		try {
			const DOMPurify = (globalThis as any).__dompurify;
			if (DOMPurify) return DOMPurify.sanitize(rawHtml);
		} catch { /* fallback */ }
		return rawHtml;
	});

	// Lazy-load DOMPurify in browser
	if (browser) {
		import('dompurify').then(mod => {
			(globalThis as any).__dompurify = mod.default;
		});
	}
</script>

<div class="markdown-content">{@html html}</div>

<style>
	.markdown-content :global(p) {
		margin: 0.25em 0;
	}
	.markdown-content :global(p:first-child) {
		margin-top: 0;
	}
	.markdown-content :global(p:last-child) {
		margin-bottom: 0;
	}
	.markdown-content :global(strong) {
		font-weight: 600;
		color: var(--text-primary);
	}
	.markdown-content :global(em) {
		font-style: italic;
	}
	.markdown-content :global(code) {
		font-family: 'JetBrains Mono', 'Fira Code', monospace;
		font-size: 0.85em;
		padding: 0.15em 0.35em;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.08);
	}
	.markdown-content :global(pre) {
		margin: 0.5em 0;
		padding: 0.6em 0.8em;
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.3);
		border: 1px solid rgba(255, 255, 255, 0.08);
		overflow-x: auto;
	}
	.markdown-content :global(pre code) {
		padding: 0;
		background: none;
		border: none;
		font-size: 0.82em;
	}
	.markdown-content :global(ul),
	.markdown-content :global(ol) {
		margin: 0.25em 0;
		padding-left: 1.4em;
	}
	.markdown-content :global(li) {
		margin: 0.15em 0;
	}
	.markdown-content :global(h1),
	.markdown-content :global(h2),
	.markdown-content :global(h3) {
		font-weight: 600;
		margin: 0.5em 0 0.25em;
		color: var(--text-primary);
	}
	.markdown-content :global(h1) { font-size: 1.1em; }
	.markdown-content :global(h2) { font-size: 1.0em; }
	.markdown-content :global(h3) { font-size: 0.95em; }
	.markdown-content :global(blockquote) {
		margin: 0.4em 0;
		padding: 0.3em 0.8em;
		border-left: 3px solid rgba(255, 255, 255, 0.15);
		color: var(--text-secondary);
	}
	.markdown-content :global(a) {
		color: var(--accent-cyan);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.markdown-content :global(hr) {
		border: none;
		border-top: 1px solid rgba(255, 255, 255, 0.1);
		margin: 0.5em 0;
	}
	.markdown-content :global(table) {
		border-collapse: collapse;
		margin: 0.4em 0;
		font-size: 0.9em;
	}
	.markdown-content :global(th),
	.markdown-content :global(td) {
		border: 1px solid rgba(255, 255, 255, 0.1);
		padding: 0.3em 0.6em;
	}
	.markdown-content :global(th) {
		background: rgba(255, 255, 255, 0.04);
		font-weight: 600;
	}
</style>
