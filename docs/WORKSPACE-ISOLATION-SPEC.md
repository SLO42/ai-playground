# WORKSPACE-ISOLATION-SPEC — per-session work-dir isolation for driven sessions

**Status**: queued (2026-06-22). Origin: F-046 incident — concurrent driven sessions
corrupted shared state and would stomp a shared repo. Operator directive: "scoping a
project space could be multi-agent; building stuff could cause issues" → isolate WRITES,
keep READS parallel.

## Problem (grounded)

Every driven session for a project runs in the SAME working dir:

- `src/lib/server/sessions/launch.ts:293` — `const cwd = input.cwd ?? project.root_path;`
  All of a project's sessions spawn at `project.root_path` (D-002 / 1.4a).

So two concurrent code-write sessions in one project edit the SAME files / share ONE git
index → lost edits, half-staged commits, interleaved writes (F-007 class). Today's stopgap
(F-046) is `config/orchestration.yaml` `concurrency.perProject: 1` — only one session per
project at a time. That removes the race but kills per-project parallelism.

The config-dir half of F-046 is already fixed (`runtime/index.ts:304`, dir keyed by
`sessionId ?? agentId`). THIS spec covers the second shared space: the **work tree**.

Locked facts this builds on:
- **F-007 / F-012**: a worktree/dispatched agent MUST commit before finishing or its work
  is lost. Any worktree-per-session design inherits this rule.
- **D-018 / confineToRoot**: tool edits are confined to the session's root; a per-session
  worktree becomes that root.
- **D-002 / 1.4a**: cwd is passed EXPLICITLY into the spawn (`SpawnRequest.cwd`); the
  runtime already threads an arbitrary cwd — `LaunchInput.cwd` override exists
  (launch.ts:78–81, D-013), so a per-session cwd needs NO runtime-core change, only a
  launch-path resolver that produces+passes it.
- Prior art: the v2-wave workflow already runs isolated agents via `isolation:'worktree'`
  (a fresh `git worktree` per agent, auto-removed if unchanged) — same shape, different
  layer (workflow vs platform session). Reuse the pattern, not the code.

## Design — phase-gated isolation

Two session classes, decided by intent (the orchestration bundle already classifies
intent: `code-read`/`deep-explore` vs `code-write`/`code-debug`):

1. **READ / scope sessions** (`code-read`, `deep-explore`, `simple-question`):
   - cwd = `project.root_path` (shared, today's behavior).
   - SAFE to run in parallel — they do not write source. Enforced by the existing
     editScope / D-018 gate (a read-intent session declares no write scope → Edit/Write
     denied). No change needed; document + assert it.

2. **WRITE / build sessions** (`code-write`, `code-debug`):
   - cwd = a **dedicated git worktree per session**, created off the project repo at spawn,
     on a per-session branch `atelier/session/<sessionId-segment>`.
   - The session edits + commits in its OWN worktree (F-007). On clean terminal exit the
     harness **merges the session branch back** to the project's working branch (fast-forward
     when possible; on conflict, leave the branch + surface an honest "merge needed" state —
     never silently drop work, never force).
   - Worktree is **torn down** after merge (or kept on conflict). Mirrors F-014 discipline:
     bound the operation, clean up every tree you create.

### Components (each = a wave task)

- **WI-1 — worktree manager** (`src/lib/server/sessions/worktree.ts`, NEW):
  `acquireSessionWorktree(projectRoot, sessionId)` → `{ cwd, branch, cleanup() }`.
  Uses `git worktree add` on a per-session branch off the repo's current HEAD. Windows-safe
  spawn (F-002: `shell:true` + array args; paths with spaces). Fails CLOSED if the project
  root is not a git repo (honest error, no silent fallback to shared cwd for a write session).
  Idempotent re-acquire for resume (reuse the existing session worktree, never a second one).

- **WI-2 — launch wiring** (`launch.ts`): when the resolved intent is a WRITE class AND the
  project root is a git repo, resolve cwd via WI-1 instead of `project.root_path`; pass the
  worktree cwd onto the SpawnRequest (D-013 path already exists). READ classes unchanged.
  Persist the worktree path + branch on the `session` row (new option fields, additive
  migration per F-015) so resume + merge-back + the fleet UI can find them.

- **WI-3 — merge-back + teardown** (worktree.ts + the session-end path in launch.ts, near
  the existing §3.2 end-of-session handling): on `done`, attempt FF-merge of the session
  branch into the project branch; on success remove the worktree+branch; on conflict or a
  failed/cancelled session, KEEP the branch and stamp a screened (D-026) `note` =
  "work preserved on branch <b>; merge needed" so the operator sees it (extends the MC-4
  honest-failure surface). NEVER force-merge, NEVER discard a branch with unmerged commits.

- **WI-4 — raise the cap + document**: once WI-1..3 land and are live-verified, restore
  `concurrency.perProject` to a safe value (>1) with a comment that per-session worktrees
  now make it safe. Add a fails.md note retiring the F-046 stopgap rationale (mark, per G2 —
  operator retires).

## Integrity invariants (must hold; red-team targets)

- **No lost work** (F-007): a write session that produced commits NEVER loses them — merged
  on success, preserved on a branch otherwise. A red-team task must try to make a session
  exit in each state (done / failed / cancelled / merge-conflict) and prove commits survive.
- **No force / no silent discard**: merge-back is FF-or-surface; a conflict is an honest
  state, never a `-f`.
- **Confinement preserved** (D-018): the worktree IS the confinement root; a write session
  cannot edit outside its worktree. The editScope gate still evaluates.
- **Resume reuses ONE tree**: a resumed session re-acquires its existing worktree, never
  creates a second (idempotency test).
- **Cleanup is mandatory** (F-014): no orphaned worktrees on any exit path; a teardown
  failure is logged, not swallowed into a leak.
- **Read sessions stay parallel + write-denied**: assert the read-intent classes cannot
  write (editScope/D-018), so parallel scope sessions are provably safe.

## Verification (DoD — D-038)

- Unit: worktree acquire/cleanup idempotency; FF-merge; conflict→preserve-branch; non-git
  root → fail closed.
- Integration (live, bounded — F-014): two concurrent write sessions in one project each get
  a distinct worktree, both commit, both merge back with no lost edits; one forced into
  conflict preserves its branch + stamps the honest note.
- Build + test + lint(0) + svelte-check(0). Live-verify the fleet UI shows the per-session
  branch/worktree honestly.
