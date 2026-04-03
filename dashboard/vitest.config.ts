import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [svelte()],
	test: {
		include: ['src/**/*.test.ts', 'src/**/*.test.svelte.ts'],
		exclude: ['src/integration-tests/**'],
		environment: 'jsdom',
		setupFiles: ['src/test-setup.ts'],
		server: {
			deps: {
				inline: ['@testing-library/svelte', '@testing-library/svelte-core']
			}
		},
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary'],
			reportsDirectory: './coverage',
			thresholds: {
				lines: 85,
				functions: 85,
				branches: 85,
				statements: 85
			}
		}
	},
	resolve: {
		alias: {
			$lib: new URL('./src/lib', import.meta.url).pathname
		},
		conditions: ['browser']
	}
});
