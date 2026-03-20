# Failure Log

Append new entries at the bottom. Each failure becomes a prevention rule.
If a pattern recurs 3+ times, escalate to a skill rule or CLAUDE.md.

---

## F-001: process.kill(pid, 0) unreliable on Windows/MINGW
- **Date**: 2026-03-01
- **What**: Health checks using `process.kill(pid, 0)` returned false positives on MINGW
- **Why**: POSIX signal semantics don't map to Windows process model
- **Fix**: Use `tasklist /FI "PID eq <pid>"` on Windows instead
- **Prevention**: On Windows, never use `process.kill(pid, 0)` for process liveness checks. Use `tasklist` via shell.

## F-002: Node spawn() with detached:true breaks on paths with spaces (Windows)
- **Date**: 2026-03-02
- **What**: `child_process.spawn()` with `detached: true` failed when Node was in `C:\Program Files\nodejs`
- **Why**: Windows cmd.exe can't handle unquoted spaces in detached mode
- **Fix**: Use `shell: true` option on Windows
- **Prevention**: Always set `shell: true` when using `spawn()` with `detached: true` on Windows.

## F-003: Deleted module without tracing all imports
- **Date**: 2026-03-17
- **What**: Removed art feature files but left orphaned imports in other modules
- **Why**: Jumped to file deletion without checking import chains
- **Fix**: Ran `grep -r "from.*<module>"` to find and clean all dependents
- **Prevention**: Before deleting ANY file, run `grep -r "from.*<filename>"` and `grep -r "import.*<filename>"` to find all dependents. Remove/update dependents first.

## F-004: Daemon --quiet flag causes silent crash
- **Date**: 2026-03-04
- **What**: Daemon process silently failed to start when `--quiet` flag was used
- **Why**: Flag suppressed error output, masking the actual failure
- **Fix**: Removed `--quiet` flag from daemon start commands
- **Prevention**: Never use `--quiet` or `--silent` flags on daemon/service commands. Always preserve stderr output.

## F-005: resolveRoute() ignored explicit provider selection
- **Date**: 2026-03-10
- **What**: Chat routing ignored user's explicit provider choice, always using default strategy
- **Why**: Route resolution only checked strategy mode, not the explicit provider field
- **Fix**: Added provider field check before strategy-based routing
- **Prevention**: When implementing routing/strategy patterns, always check explicit overrides before falling through to automatic selection.

## F-007: Worktree agents lose uncommitted changes on cleanup
- **Date**: 2026-03-17
- **What**: Agents running in isolated worktrees had their changes lost when worktrees auto-cleaned
- **Why**: Agents edited files but didn't commit. Worktree cleanup removed the directory, and uncommitted changes vanished. Only agents whose edits overlapped with the main tree's dirty files survived.
- **Fix**: Re-ran the affected agents without worktree isolation to re-apply changes
- **Prevention**: When launching agents with `isolation: "worktree"`, ALWAYS instruct them to commit their changes before finishing. Include this in the prompt: "After all changes, commit with: `git add -A && git commit -m 'fix: <description>'`". Then merge the worktree branch back to the development branch.

## F-006: AgentDB dist/controllers/ missing after install
- **Date**: 2026-03-03
- **What**: AgentDB package missing `dist/controllers/` directory, causing runtime import failures
- **Why**: Package build output structure differs from import paths
- **Fix**: Added `scripts/patch-agentdb.sh` postinstall script to create symlink
- **Prevention**: After installing packages with custom build outputs, verify import paths resolve. Add postinstall patches if needed.

## F-008: Worktree agent replaced real health checks with hardcoded mock data
- **Date**: 2026-03-20
- **What**: S1-04 agent created `services.ts` with hardcoded PIDs, RAM values, uptime strings, and a fake "CRASHED" status. Replaced the original `+page.server.ts` that did real health checks via fetch + netstat + tasklist.
- **Why**: Agent was told to "wire service detail pages" but instead of using the existing `SERVICES` constant from `constants.ts`, it created a new file with static data that looked correct in Playwright snapshots but was entirely fake.
- **Fix**: Restored original `+page.server.ts` from git, updated config/logs sub-pages to import from `SERVICES` instead of the hardcoded module.
- **Prevention**: When an agent creates a shared data module, verify it uses LIVE data sources (health checks, PID detection, file reads) — not hardcoded values. Playwright snapshots that show "Running" don't prove the data is real. Always cross-reference displayed values against expected live state (e.g., PID should match actual process).

## F-009: $state rune in plain .ts file crashes all pages with 500
- **Date**: 2026-03-20
- **What**: S4-02 agent created `live-updates.ts` with `$state()` rune. Every page returned 500: `The $state rune is only available inside .svelte and .svelte.js/ts files`
- **Why**: Svelte 5 runes (`$state`, `$derived`, `$effect`) are compiler macros — they only work in `.svelte` and `.svelte.js/.svelte.ts` files, NOT plain `.ts` files
- **Fix**: Renamed `live-updates.ts` → `live-updates.svelte.ts`, updated import to `.svelte.js`
- **Prevention**: Files using Svelte 5 runes MUST have `.svelte.ts` or `.svelte.js` extension. When creating stores or modules that use `$state`/`$derived`/`$effect`, always use the `.svelte.ts` extension.

## F-010: SSE endpoint causes Playwright networkidle timeout
- **Date**: 2026-03-20
- **What**: All 42 Playwright smoke tests timed out after adding SSE `/api/events` endpoint
- **Why**: `waitUntil: 'networkidle'` requires all network connections to settle. SSE keeps a persistent open connection, so "network idle" is never reached
- **Fix**: Changed `smokeCheck()` to use `waitUntil: 'load'` instead of `'networkidle'`
- **Prevention**: When a page has SSE or WebSocket connections, NEVER use `waitUntil: 'networkidle'` in Playwright. Use `'load'` or `'domcontentloaded'` instead.
