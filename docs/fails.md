# Failure log — ai-playground v2

Carried-forward failure patterns + prevention rules. Scan this BEFORE starting a
task (error-learning protocol). Append a new `F-NNN` entry whenever build/test
did not pass on the first try; escalate recurrences per the protocol.

The F-001..F-012 entries below are **carried from v1** (IMPLEMENTATION-PLAN §6)
— the prevention rules apply to v2 from day 0.

## F-001: process.kill(pid, 0) unreliable on Windows/MINGW
- **What**: liveness checks via `process.kill(pid, 0)` give wrong answers on
  Windows.
- **Why**: MINGW signal emulation doesn't map to Windows process semantics.
- **Fix**: use `tasklist /FI "PID eq <pid>"` to check liveness.
- **Prevention**: never `process.kill(pid, 0)` on Windows — `tasklist` only.

## F-002: detached spawn breaks on paths with spaces
- **What**: `spawn(..., { detached: true })` fails for `C:\Program Files\...`.
- **Why**: Node argv quoting on Windows.
- **Fix/Prevention**: pass `shell: true` on Windows for detached spawn; still
  pass args as an array (no string concatenation) to avoid shell injection.

## F-005: routing fallback must be explicit
- **What**: a route with no match silently dropped the task.
- **Prevention**: `resolveRoute` always ends in an explicit fallback branch.

## F-006: native/provisioned binaries run unverified
- **What**: a provisioned binary (SurrealDB) ran without integrity check.
- **Why**: no checksum gate before spawn.
- **Prevention**: SHA-256-verify every provisioned binary before spawn; fail
  hard on mismatch (SEC-009 / D-006).

## F-007: worktree agents lose work if they don't commit
- **What**: a worktree agent finished without committing — changes lost.
- **Prevention**: worktree/dispatched agents MUST commit before finishing.

## F-008: fake/hardcoded runtime data
- **What**: UI showed plausible-looking numbers not backed by a live source.
- **Prevention**: runtime data ALWAYS from live sources; honest states
  (loading/empty/error/stale/unknown) instead of fabricated values. Fixtures
  allowed only in tests.

## F-009: runes require .svelte.ts (not .ts)
- **What**: `$state`/`$derived` in a plain `.ts` module didn't compile as runes.
- **Prevention**: reactive runes live in `.svelte.ts` (or `.svelte`); plain
  `.ts` modules stay rune-free.

## F-010: Playwright networkidle hangs with SSE
- **What**: `waitUntil: 'networkidle'` never settles when an SSE stream is open.
- **Prevention**: use `waitUntil: 'load'` for pages with a live SSE stream.

## F-011: {@const} placement
- **What**: `{@const}` outside an allowed block was a compile error.
- **Prevention**: `{@const}` only as an immediate child of `{#each}`/`{#if}`/
  `{#await}`/`{#snippet}`/`<svelte:boundary>` etc.

## F-012: worktree agents MUST commit (recurrence of F-007)
- **What**: repeat of F-007 in a different wave.
- **Prevention**: bake "commit before finishing, then merge back" into every
  dispatched implementation agent's prompt.
