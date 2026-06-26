# BL-R1 — Crash/Restart Work-Queue Recovery (spec, grounded 2026-06-26)

Surfaced at go-live (2026-06-25, F-048 incident). The F-048 hotfix (`6fb4d3d`)
stopped the dedup-collision CRASH; two deeper recovery gaps remain (hand-recovered
via DB last time). Grounded against worktree `F:\code\ai-playground-v2` (branch v2)
via a read-only map — file:line cited, no guessing.

## Verified current state (file:line)

- **Reaper** `src/lib/server/orchestrator/reaper.ts:47-75` `reapStaleRuns()` — at
  boot, `UPDATE session/workflow_run SET status='failed', ended_at, note=REAPED_NOTE
  WHERE status='running' AND started_at < bootTime RETURN AFTER`. Marks the SESSION
  failed but does **nothing** to that session's claimed `work_item`s or its task.
- **gcStale** `src/lib/server/orchestrator/workqueue.ts:394-422` — resets
  `processing`→`pending` (clears `claim_token`/`claimed_at`) only WHERE
  `claimed_at < now - stuckMaxAgeMs` (default **1h**); deletes aged terminal rows.
  Purely time-based; **no session linkage**.
- **gc wrapper** `src/lib/server/orchestrator/orchestrator.ts:400-412`
  `orchestrator.gc()` wraps `gcStale` — comment says "Call from a SessionStart /
  idle maintenance trigger". **Not wired** into boot or any loop. Available, never invoked.
- **claimNext** `src/lib/server/orchestrator/workqueue.ts:171-275` — selects top-priority
  `pending` + `claim_token IS NONE`, CAS-flips to `processing`. Catch (≈:233) absorbs
  the dedup/conflict class → backoff + `continue`, **re-SELECTs the same top item** each
  retry (up to `maxRetries`=16). An orphaned `processing` twin holds the
  `dedup_key …|processing`; the live re-enqueued pending twin collides at its CAS flip
  → burns all 16 retries → starves the drain.
- **work_item schema** — columns incl. `status` (pending|processing|done|failed),
  `session` (nullable link to session id), `claim_token`, `claimed_at`, `completed_at`,
  `project`, `dedup_scope`. `dedup_key = work_type|<session>|<dedup_scope>|status`.
- **task transitions** — moved `ready→in_progress` before spawn
  (`orchestrator.ts:589-621`); terminal `in_progress|review → done|failed` at
  `post-task.ts:306-310`. **No reset** of a crashed session's `in_progress` task back to `ready`.

## Gaps → fixes

### R1-1 — session death releases its claimed work + resets its task
A reaped/failed session must, for EACH such session: release its claimed
`work_item`s (`processing`→`pending`, clear `claim_token`/`claimed_at`) and reset its
orphaned task (`in_progress`/`review`→`ready`) so Continue re-drives it. Triggered
from the reaper (boot) AND any runtime session-failure path. Guard: release ONLY for
sessions actually in a terminal state (never free a live session's lease).

### R1-2 — gcStale wired (boot + periodic safety-net)
Wire `gc()` into boot (once, after reap) + a bounded periodic trigger (interval,
unref'd, cleared on shutdown — F-014: never crash the drain, no spin). Keeps the
1h stale-`processing` recovery + terminal-row GC running automatically as the
backstop even when R1-1's targeted release is missed.

### (deferred, note only) structural dedup-window collapse
F-048's deferred structural fix — collapse the dedup active-window so
{pending,processing} dedup against each other (prevent the 2nd enqueue entirely)
rather than absorbing at claim. Out of scope for R1; track in the F-048 ledger.

## Verify
build + test + lint(0) + svelte-check(0). Tests seed (F-020 gotchas: SET every
VALUE-referenced column, 1024-dim embeddings, ORDER-BY in SELECT): a failed session
+ its `processing` work_item + `in_progress` task → assert release+reset, run twice
(idempotent). gcStale wiring: assert boot invokes gc + teardown clears the interval.
