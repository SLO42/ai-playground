import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    // scripts/** added in 15.2: the browser-verify daemon (dev/verify tooling,
    // not product runtime) lives in scripts/ and carries its own unit + live suites.
    include: ['src/**/*.{test,spec}.{js,ts}', 'scripts/**/*.{test,spec}.{js,ts}'],
    environment: 'node',
    // Suite-wide teardown bound (14.6): under full-suite concurrency the per-file
    // SurrealDB testserver teardown (deleteProject + db.close + process kill) can
    // exceed the 10s default and fail a file whose every TEST passed — the documented
    // full-suite flake. 60s keeps teardown bounded without false suite failures.
    hookTimeout: 60_000
  }
});
