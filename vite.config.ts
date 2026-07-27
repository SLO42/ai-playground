import { availableParallelism } from 'node:os';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// ── Test-worker cap — the fix for the ROTATING full-suite failures ──────────────────────
// 191 of the ~330 suites call `startTestDb()`, which spawns a REAL SurrealDB process on its
// own loopback port with its own SurrealKV data dir in tmp, then applies all 86 migrations
// in `beforeAll`. Vitest's default fork count is one-per-core, so on a 24-core box the suite
// tried to run ~23 SurrealDB servers at once. The result was not a clean failure but a
// ROTATING one: whichever real-DB/real-git suites happened to lose the I/O race that run
// blew a timeout, so three consecutive runs produced three different failing sets — which
// trains everyone to ignore red.
//
// Measured on this machine (24 cores), full suite, same commit:
//   default (~23 forks) → 6 failed files / 145s   (freshen.live: beforeAll TIMED OUT at 90s)
//   maxForks = 8        → 2 failed files / 117s   (freshen.live: 2.7s)
// The same suites pass in isolation in seconds (freshen.live 2.7s, orchestrator.test.ts
// 33/33 in 8.7s), which is what identified contention rather than the tests as the cause.
//
// Capping is FASTER as well as stabler: past ~8 workers the extra forks only contend for
// the one disk. This bounds concurrency without pretending any individual suite is flaky.
const TEST_MAX_FORKS = Math.max(2, Math.min(8, availableParallelism()));

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
    hookTimeout: 60_000,
    // See TEST_MAX_FORKS above — bounds concurrent real-SurrealDB servers so the suite's
    // failures stop rotating. `forks` is vitest's default pool; named explicitly so the
    // option is not silently dropped if the default ever changes.
    pool: 'forks',
    poolOptions: { forks: { maxForks: TEST_MAX_FORKS } }
  }
});
