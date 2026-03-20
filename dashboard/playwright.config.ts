import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	timeout: 15000,
	retries: 0,
	use: {
		baseURL: 'http://localhost:4173',
		headless: true
	},
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		reuseExistingServer: true,
		timeout: 60000
	}
});
