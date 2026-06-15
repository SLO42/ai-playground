import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // Bind the dev server to IPv4 loopback (127.0.0.1), NOT vite's default `localhost`
  // which resolves to IPv6 `::1`. The whole loopback control plane — HOOK_URL (built
  // from HOST default 127.0.0.1), the gate hook POST, SurrealDB, and the D-024/D-025
  // loopback assertions — speaks 127.0.0.1. A `::1`-only dev server makes every driven
  // session's gate hook POST to http://127.0.0.1:PORT fail connection-refused → tools
  // deny closed → a real CLI spawn can never use a tool (the live-gauntlet gap, F-030).
  server: { host: '127.0.0.1' },
  test: {
    // scripts/** added in 15.2: the browser-verify daemon (dev/verify tooling,
    // not product runtime) lives in scripts/ and carries its own unit + live suites.
    // tests/verify-flows/** added in 15.3: the verify-flow runner's own unit suite
    // (the flows themselves are NOT vitest — they run via `npm run verify:flows`).
    include: [
      'src/**/*.{test,spec}.{js,ts}',
      'scripts/**/*.{test,spec}.{js,ts}',
      'tests/verify-flows/**/*.{test,spec}.{js,ts}'
    ],
    environment: 'node',
    // Suite-wide teardown bound (14.6): under full-suite concurrency the per-file
    // SurrealDB testserver teardown (deleteProject + db.close + process kill) can
    // exceed the 10s default and fail a file whose every TEST passed — the documented
    // full-suite flake. 60s keeps teardown bounded without false suite failures.
    hookTimeout: 60_000
  }
});
