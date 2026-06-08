import { defineConfig, devices } from '@playwright/test';

// TASK 1.5 e2e config. globalSetup spins up a throwaway SurrealDB + the BUILT
// dashboard pointed at it; tests load pages serving LIVE DB data (F-008). Loads use
// waitUntil:'load' (NOT networkidle) — the dashboard holds an open SSE stream, so
// networkidle NEVER settles (F-010). Single Chromium project, headless, serial.

const PORT = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: '**/*.spec.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	globalSetup: './tests/e2e/global-setup.ts',
	globalTeardown: './tests/e2e/global-teardown.ts',
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		// F-010: never 'networkidle' — the open SSE stream keeps the network busy.
		navigationTimeout: 30_000
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
