# Backend Architecture Audit

> Generated: 2026-03-09

---

## Executive Summary

**8 critical issues**, **19 high priority**, **16 medium**, across 21 modules. The three most impactful:

1. **File concurrency races everywhere** — task-store, notifications, session-pool, pid-registry, analytics all do load-then-write with no locking. Concurrent operations silently lose data.
2. **Shell injection in git/gh commands** — post-task.ts and github-sync.ts interpolate user-controlled strings (task titles, filenames) into shell commands without escaping.
3. **Gateway client single-handler bug** — two concurrent `chat()` calls cause the first to hang forever (memory leak + hung promise).

---

## Part 1: Server Modules + APIs

### constants.ts
- **HIGH**: `isPathAllowed` doesn't normalize case on Windows — `C:\Config` vs `c:\config` bypasses prefix check
- **MEDIUM**: No startup assertion that `PROJECT_ROOT` points to the right directory

### task-store.ts
- **CRITICAL**: TOCTOU race in all index read-modify-write operations (`createTask`, `updateTask`, `deleteTask`, `putTask`). Concurrent calls lose entries. Need AsyncMutex.
- **HIGH**: `taskFilePath` — no ID sanitization for path traversal. `putTask` accepts arbitrary Task objects.
- **MEDIUM**: `replaceAllTasks` writes sequentially instead of `Promise.all`
- **LOW**: `crypto.randomUUID().slice(0, 8)` — 32 bits, collision risk at scale

### notifications.ts
- **HIGH**: Same read-modify-write race on `notifications.json` across all mutation functions
- **MEDIUM**: `getStats` iterates the list 5 times — consolidate to single pass

### session-manager.ts
- **CRITICAL**: Tool execution bypass — tools marked as requiring confirmation execute without waiting for approval
- **HIGH**: Write lock needed on chat index in `saveSession`
- **HIGH**: Silent error swallowing on streaming failures
- **MEDIUM**: `loadGeneralSettings()` called per-stream — cache with short TTL

### github-sync.ts
- **HIGH**: `task.title` interpolated into `gh` command without escaping — injection risk
- **HIGH**: Sequential label creation — batch or skip
- **MEDIUM**: Timeout handler doesn't clean up listeners
- **MEDIUM**: Parallelize push/pull loops with bounded concurrency

### memory-bridge.ts
- **HIGH**: `syncProjectMap` reads legacy `tasks.json` directly, bypassing v2 task store
- **MEDIUM**: `scanKeyFilesAsync` can block event loop for large directories

### providers/openclaw.ts
- **CRITICAL**: Tool messages (`role: 'tool'`) silently dropped from prompt — breaks tool conversations
- **HIGH**: Health check on every `stream()` call with 3s timeout — cache for 10-30s
- **HIGH**: Gateway fallback to Ollama swallows error silently
- **MEDIUM**: Health check accepts 4xx as "online" — tighten to 2xx only

---

## Part 2: Heartbeat + Spawn System

### heartbeat/index.ts
- **CRITICAL**: Task description mutated in-place for `openclaw-context` route — injected context gets persisted, growing on each cycle. Must clone task before mutation.
- **HIGH**: Stale `in_progress` reset only checks root project, not sub-projects
- **HIGH**: `child.pid` can be `undefined` — creates ghost agent entry with pid 0
- **MEDIUM**: Dynamic `import('./auto-restart.js')` inside hot loop — hoist to module scope
- **MEDIUM**: `isDaemonRunning` uses synchronous `execSync` — blocks event loop up to 5s
- **LOW**: `scanTasks` outer catch swallows all errors silently

### heartbeat/shared.ts
- **HIGH**: `maxConcurrentAgents` exported as mutable `let` — closures capture stale value. Convert to getter function.
- **HIGH**: `isPidAlive` uses synchronous `execSync` — blocks event loop per PID check
- **MEDIUM**: `enqueueSpawn` / `spawnQueue` is defined but never used — dead code
- **LOW**: `upsertSessionMeta` lock chain grows indefinitely under rapid calls

### heartbeat/agent-spawn.ts
- **CRITICAL**: File descriptor leak if `spawn()` throws — `stdinFd`/`outFd` opened but never closed in error path. Wrap in try/finally.
- **HIGH**: Prompt file uses `Date.now()` suffix — collisions on rapid spawns (15ms resolution on Windows). Use UUID.
- **MEDIUM**: `child.unref()` means orphaned agents on process exit — graceful shutdown should kill active agents
- **LOW**: Hardcoded claude binary path fragile — add `which`/`where` check at startup

### heartbeat/post-task.ts
- **CRITICAL**: Shell injection in `git add` and `git commit` — filenames/titles with `"`, `$`, backticks can inject commands. Use `execFile` with argument arrays.
- **HIGH**: `planFollowUps` checks `commitResult.message` string (like `"abc123 — 3 file(s)"`) instead of actual file paths — `touchedServer`/`touchedTypes` are effectively always false.
- **HIGH**: `git diff --name-only` misses staged files — add `--cached` or use `git status --porcelain`
- **MEDIUM**: All git calls use synchronous `execSync` — blocks event loop

### heartbeat/session-pool.ts
- **CRITICAL**: No concurrency protection on pool state — `loadPool`/`savePool` called from multiple async contexts without locking. Concurrent `releaseSession` calls lose updates.
- **HIGH**: `maxSlots` only ratchets up, never down — unbounded slot growth over time
- **HIGH**: Redundant `loadPool()` on every operation — use in-memory state, load from disk only at startup
- **MEDIUM**: `existsSync` in async context — use `fs/promises` `access()` instead
- **LOW**: Temp-slot creation never tracked — no visibility into pool contention

### heartbeat/pid-registry.ts
- **HIGH**: `isPidAlive` uses synchronous `execSync` — blocks event loop 3s per PID. With 10+ orphans at startup, 30+ seconds of blocking.
- **HIGH**: No file locking on registry writes — concurrent `registerPid`/`unregisterPid` race
- **MEDIUM**: PID reuse risk on Windows — should validate process start time against `spawnedAt`
- **MEDIUM**: `killAll` doesn't await SIGKILL timeouts before clearing registry
- **LOW**: `saveRegistry` on every register/unregister — debounce with 500ms window

---

## Part 3: Agent Lifecycle + Analytics

### heartbeat/agent-tracking.ts
- **CRITICAL**: Synchronous `readFileSync` in `parseStreamJsonLog` — blocks event loop for large log files
- **HIGH**: Race condition in `recordUsage` — concurrent completions lose entries
- **HIGH**: Shell injection in `getGitDiffStats` — file paths interpolated into shell command
- **MEDIUM**: `tailAgentLogs` re-reads entire log files each tick — use file descriptor at offset

### heartbeat/agent-analytics.ts
- **HIGH**: Race condition in `recordEvent` — concurrent calls lose events (same load-then-write pattern)
- **MEDIUM**: `eventCounter` resets on HMR — IDs can collide
- **MEDIUM**: `getAgentAnalytics` iterates event list 6 times — refactor to single pass
- **LOW**: Full `events` array returned from API — redundant with `recentEvents`

### heartbeat/review-agent.ts
- **HIGH**: `ensureReviewSession` overwrites all history on each call
- **HIGH**: Runs full `npm run build` on every review prompt generation — 30-60s of CPU
- **MEDIUM**: `collectReviewContext` has no size cap — can exceed model context limits
- **LOW**: Missing `await` on second `logAgentCompletion`

### heartbeat/ux-inspector.ts
- **HIGH**: `distillOptimizationsLocally` re-reads state from disk after in-memory modifications — reads stale state
- **MEDIUM**: Playwright JSON output parsing can corrupt if stderr interleaves with stdout
- **MEDIUM**: `collectRoutes` reads project configs sequentially — parallelize with `Promise.all`
- **LOW**: No abort mechanism for spawned discovery inspections

### heartbeat/openclaw-agent.ts
- **HIGH**: `queryOllamaFallback` has no fetch timeout — can hang indefinitely
- **MEDIUM**: Agent registered with `logFile: ''` and `pid: 0` — causes `tailAgentLogs` ENOENT errors
- **LOW**: Keyword classification uses substring matching — risk of false positives

### heartbeat/gateway-client.ts
- **CRITICAL**: Single event handler per event type — two concurrent `chat()` calls cause first to hang forever (memory leak). Use per-request event keys.
- **HIGH**: SDK import uses hardcoded Vite hash (`client-CuIxivDk.js`) — breaks silently on package updates. Use glob pattern.
- **MEDIUM**: No automatic WebSocket reconnection on disconnect
- **MEDIUM**: Dynamic `import('ws')` on every connect — cache at module level
- **LOW**: Auth token sent over unencrypted WS (loopback only, but fragile)

### heartbeat/discussion.ts
- **CRITICAL**: Discussion reply dropped when agents are full — entry deleted from map even when `spawnAgentWithContext` returns false. Reply is permanently lost.
- **HIGH**: `getAllTasks` called inside per-discussion loop — hoist outside for single read
- **MEDIUM**: Empty/whitespace user replies trigger agent spawn — add validation
- **LOW**: Session index scan runs every heartbeat — add cooldown

### heartbeat/auto-restart.ts
- **HIGH**: Spawned restart processes have no PID tracking — can't detect duplicates or diagnostics
- **MEDIUM**: No health verification after restart — fire-and-forget with no feedback
- **MEDIUM**: Sync `loadRestartConfig` returns defaults if async version never ran
- **LOW**: No guard against concurrent restarts for the same service

---

## Cross-Cutting Concerns

### 1. File Concurrency (CRITICAL)
Every module doing JSON read-modify-write has race conditions: task-store, notifications, session-pool, pid-registry, agent-tracking, agent-analytics. **Fix**: Create a shared `AsyncMutex` utility keyed by file path.

### 2. Synchronous I/O Blocking (HIGH)
`execSync`, `readFileSync`, `existsSync` in async contexts across: shared.ts, pid-registry.ts, agent-tracking.ts, index.ts, post-task.ts. **Fix**: Migrate to async `execFile`/`readFile`/`access` throughout.

### 3. Shell Injection (CRITICAL)
User-controlled strings (task titles, filenames) interpolated into shell commands in: post-task.ts, agent-tracking.ts, github-sync.ts. **Fix**: Use `execFile` with argument arrays instead of shell string interpolation.

### 4. Silent Error Swallowing (HIGH)
Empty `catch {}` blocks across: session-manager, openclaw provider, github-sync, shared.ts. **Fix**: At minimum log errors; for critical paths, surface them.

### 5. Missing Input Validation (HIGH)
`putTask` accepts arbitrary objects, `gh()` doesn't sanitize titles, discussion replies aren't validated. **Fix**: Validate at system boundaries.

---

## Priority Action Items

| # | Priority | Issue | Files |
|---|----------|-------|-------|
| 1 | CRITICAL | Create shared AsyncMutex for file operations | task-store, notifications, session-pool, pid-registry, analytics |
| 2 | CRITICAL | Fix shell injection in git/gh commands | post-task.ts, agent-tracking.ts, github-sync.ts |
| 3 | CRITICAL | Fix gateway client concurrent chat() hang | gateway-client.ts |
| 4 | CRITICAL | Fix discussion reply dropped when agents full | discussion.ts |
| 5 | CRITICAL | Clone task before mutating description | heartbeat/index.ts |
| 6 | CRITICAL | Fix FD leak in agent-spawn.ts | agent-spawn.ts |
| 7 | CRITICAL | Include tool messages in OpenClaw prompt | providers/openclaw.ts |
| 8 | CRITICAL | Fix tool confirmation bypass | session-manager.ts |
| 9 | HIGH | Migrate all `execSync` to async `execFile` | 6+ files |
| 10 | HIGH | Fix `maxConcurrentAgents` stale binding | shared.ts |
| 11 | HIGH | Fix `planFollowUps` checking wrong data | post-task.ts |
| 12 | HIGH | Add fetch timeout to Ollama fallback | openclaw-agent.ts |
| 13 | HIGH | Fix memory-bridge reading legacy tasks.json | memory-bridge.ts |
| 14 | HIGH | Fix review-agent running full build per prompt | review-agent.ts |
| 15 | HIGH | Fix `isPathAllowed` case sensitivity on Windows | constants.ts |
| 16 | HIGH | Cache OpenClaw health check result | providers/openclaw.ts |
| 17 | HIGH | Fix session-pool maxSlots unbounded growth | session-pool.ts |
| 18 | HIGH | Replace hardcoded Vite hash in SDK import | gateway-client.ts |
| 19 | HIGH | Sanitize task IDs for path traversal | task-store.ts |
