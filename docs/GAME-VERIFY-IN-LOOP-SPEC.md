# GAME-VERIFY-IN-LOOP-SPEC — close the verify → auto-fix → re-verify arc

**Status:** DRAFT (2026-07-07) · extends GAME-VERIFY-SPEC · queued `game-verify-in-loop` (gate:operator)
**One-liner:** the game-verify runner, gate, persist, surface, and `follow_up` enqueue are all BUILT and live — the missing piece is a **consumer** that turns a non-pass verdict into the next bounded build iteration. Wire it (and fix the same dead-end that silently swallows test-fail follow-ups).

## 1. Current state (verified seams)

BUILT + wired in the develop loop (boot enables it, `boot.ts:436 gameVerify:{enabled:true}`):
- Runner `runGameVerify` (`orchestrator/game-verify.ts`): deploy → launch (detached, arg-arrays) → poll `log_path` for `ready_pattern` (wall-clock bounded, no spin) → count success/error patterns + capture stacks → **kill in try/finally** (`taskkill /F /IM`, F-014) → verdict. Never throws.
- Verdict: `GameVerifyOutcome = pass | errors | not_ready | crashed | timeout`; screened (D-026) stacks/logTail before they enter the verdict.
- Step `runGameVerifyStep` (`game-verify-step.ts`): gate (absent config ⇒ OFF) → per-`process_name` async lock (one game at a time) → persist verdict as `agent_event`/`completion` → **enqueue a `follow_up`** on non-pass (`:193`).
- Loop position (`orchestrator.ts:885`): AFTER build/test, on a clean-done session, BEFORE the task settles; `.catch`-wrapped (never crashes drain, F-014).
- Config: `project.game_verify` (opt-in, `m0068`, `parseGameVerifyConfig` fail-safe null). Surfaced in the command-center.

## 2. The gap (Iron-Law traced)

A `follow_up` is enqueued but **nothing consumes it into a build**:
- `CWD_SPAWNING_WORK_TYPES = ['task_run','review']` (`workqueue.ts:44`) — `follow_up` is not spawn-handled.
- `#runItem`'s default branch reads `payload.taskId` then `if (!taskId||!projectId) return` (`orchestrator.ts:709`). The follow_up payload carries **`parentTaskId`, not `taskId`** → empty → **the branch returns, spawning nothing.** `grep parentTaskId` = only the 2 enqueue sites + 1 test; **no consumer.**
- **Same dead-end for test-fail**: `post-task.ts:414` enqueues an identical `parentTaskId` follow_up on test failure — also dropped. This is a platform-wide shape, not game-specific.
- **Suspected leak** (confirm in build): on the early empty-taskId `return`, does `complete()`/permit-release fire? A claimed-but-abandoned `follow_up` may leak a claim token/permit. Reproduce before fixing (Iron Law).

So today: build → test → game-verify → **verdict persisted + visible + follow_up queued**, but the next iteration needs an operator/PM to act. The designed arc is unwired.

## 3. Design — the `follow_up` consumer

A first-class, **bounded**, screened consumer that re-drives a build from a verdict.

### 3.1 Consume the follow_up
- Add `follow_up` handling in `#runItem` (a dedicated branch, like `memory_review`/`hire_request`), reading **`parentTaskId`** (fix the payload-key mismatch — or normalize both enqueue sites to `taskId`; pick one and make it the contract).
- Resolve the parent task; spawn a new **build** session for it, injecting the screened fix-signal (§3.3). This is a cwd-spawning work type → it needs worktree isolation like `task_run` (add `follow_up` to `CWD_SPAWNING_WORK_TYPES`, or route it through the task_run path with an `iteration` marker).

### 3.2 Bound the iteration (LOAD-BEARING — the RH-1/BL-R4 lesson)
- A verify→fix→re-verify loop that never bounds is an **infinite re-drive** (exactly why RH-1 lands failed work on `failed`, not `ready`, and why BL-R4's `failed→ready` is operator-manual). So: a **max iterations per task** (`game_verify.max_iterations`, default 2; also applies to test-fail follow-ups). Track attempts on the task (or a per-task counter); on exhaustion, STOP re-driving, mark the task `failed` (or a distinct `needs_operator` state), surface the honest verdict + the operator re-run path (BL-R4). Never loop forever, never silently drop.
- Dedup already gives "one open follow-up per task" (`dedupScope:${taskId}|game-verify`) — keep it; the counter is the second guard.

### 3.3 Feed the fix-signal into the build
- The next build session's prompt gets the **screened** verdict context: `outcome`, `byPattern` error counts, `stackTraces`, `logTail`, `note` — already D-026-screened in the runner. Frame it as DATA ("the last build failed game-verify with these errors; fix them"), never as unfenced instruction.

### 3.4 Fix the leak
- On any early `return` from a claimed work_item, ensure `complete()`/permit-release fires (no claim-token/permit leak). Add a regression test claiming a malformed follow_up and asserting the permit is released + the item terminal.

## 4. Authorization

Re-driving spends tokens (a new build session). Bounded by the D-021 daily cap + the per-task iteration cap. **Fork (§7):** under autonomous-to-v1 the re-drive is authorized (the project is armed hands-off to v1); outside it, the consumer should PROPOSE (surface the follow_up as an actionable verdict) rather than auto-spawn. Recommend: gate auto-re-drive on the same armed/autonomous flag the orchestrator already reads; else propose-only.

## 5. Safety invariants (mostly already held)
- **Kill discipline (F-014):** runner already kills in try/finally — unchanged.
- **Never crash the drain (F-048):** consumer is best-effort; a spawn fault marks the follow_up terminal, never propagates.
- **Bounded loop:** §3.2 — no infinite re-drive.
- **Screened fix-signal (D-026):** reuse the runner's screened stacks/logTail — never inject a raw log.
- **Honest (F-008):** on iteration-exhaustion, the task shows the real last verdict + a real recovery path, not a fake pass.

## 6. Build tasks
- **GV-1** Reproduce the `follow_up` dead-end + the suspected claim/permit leak (Iron Law): a test that enqueues a `parentTaskId` follow_up, drains, asserts it currently spawns nothing + check permit release.
- **GV-2** The consumer: `#runItem` `follow_up` branch reads `parentTaskId`, spawns a bounded build iteration with the screened fix-signal; worktree-isolated. Fix the leak (GV-1).
- **GV-3** Iteration bound: `max_iterations` (config default 2) + per-task attempt tracking; on exhaustion → `failed`/`needs_operator` + honest surface + BL-R4 re-run path. Covers BOTH game-verify and test-fail follow-ups.
- **GV-4** Auth gate (§4): auto-re-drive only when armed/autonomous; else propose-only.
- **GV-5** Command-center: show the iteration count + "verify → fix → re-verify" chain on the task; honest exhausted state.

**Verify:** real-surreal tests (drain a follow_up → spawns a bounded build; exhaustion stops + marks honest); `npm run db:up` if a field is added for attempt-tracking; redTeam GV-2/GV-3 (prove no infinite re-drive, no leak, fix-signal can't steer). No live game needed for the consumer logic (mock the verdict).

## 7. Open forks
1. **Auth**: auto-re-drive under autonomous-to-v1 vs propose-only otherwise (recommend the armed-flag gate).
2. **Exhaustion state**: reuse `failed` (+ BL-R4 operator re-run) vs a new `needs_operator` status (recommend reuse `failed` — one fewer status, BL-R4 already gives the re-run path).
3. **Scope**: fix the consumer for `follow_up` generally (closes test-fail auto-iteration too) — recommend YES, it's the same dead-end.
