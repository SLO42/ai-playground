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
