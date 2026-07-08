# SYNC-SPEC — task↔issue/board sync over the single gh boundary

**Status:** DRAFT (2026-07-08) · implements D-037 (SyncAdapter) · carries D-008/D-016/D-026/F-008/F-050 · queued in `periphery-hardening` (gate:operator)
**One-liner:** the GitHub sync family is built on one execFile chokepoint (`runGh` — array args, stdin bodies, no creds handled), a dual-UNIQUE `task_sync` ledger that makes concurrent double-creates collide instead of duplicate, lossless status labels, and honest skips everywhere. Operator-form-driven only. The footgun: sync adapters default `dryRun:false` — safety lives at the caller.

Grounding: opus scout pass 2026-07-08 over `src/lib/server/sync/` (file:line verified).

## 1. Substrate
- **Framework:** `adapter.ts` — `SyncAdapter` (:103), `SyncRegistry` (:137, dup-register throws, `resolve` throws UnknownAdapterError), direction push/pull/both (:26).
- **The gh boundary:** `gh.ts` `runGh` — execFile ARRAY args, body via `--body-file -` over STDIN (never an argv token), 30s/10MiB caps, direct binary on Windows; `assertRepoSlug`; creds NEVER read/stored/logged (gh keychain or operator env). `gh-client.ts`: typed `GitHubClient`, `assertRepoName`:79 / `assertBranchName`:102 (rejects leading `-`), `CreateRepoInput`:52 has NO visibility field — **public repos are unrepresentable**; `createRepo`:393 hardcodes `--private`; named outcomes only.
- **Issue sync** (`github.ts`): status rides `status:<s>`+`priority:<p>` labels (lossless 7-state↔binary round-trip); PULL applies the task state machine — illegal transition = honest skip, never forced; existing same-title issue LINKED not duplicated. **Ledger `task_sync`** (m0024): dual UNIQUE VALUE keys — issue-key `provider|repo|external_id` + task-key `provider|repo|task` — concurrent double-create COLLIDES (D-008).
- **Board sync** (`github-board.ts`): one-way push, composes on the issue mapping (issue sync must precede), honest skips (no mapping/no column-map), missing column throws. `board-repo.ts`: config MERGE-preserve, incidents, F-013 ISO norms.
- **Triggers:** the operator form at `/projects/[id]/sync` (`dryRun = checkbox`, +page.server.ts:175); real PULL arrivals feed the PM trigger engine under its own D-004 gates. `createRepo`'s caller is the repo-creation gate (PROJECTS-SPEC §3), not sync. Scaffold births `main` (create/execute.ts:1287–1294, F-050).
- **Tests:** gh (128), gh-client (236), github (451 — fake client vs real SurrealDB ledger), github-board (269). Live GitHub round-trip = documented deferred proof (fake-asserted, never CI-run).

## 2. Normative invariants
1. ALL gh access through the single `runGh` array-arg boundary; bodies over stdin; credentials never handled by our code; unauthed degrades honestly (F-008), distinguishing not-installed from not-authenticated.
2. Public repo creation is unrepresentable at the seam AND re-refused at the gate; real creation only behind the D-037 operator gate; birth branch is `main` (F-050).
3. Sync idempotency = the dual-UNIQUE `task_sync` ledger; re-sync UPDATES, never re-creates; a collision is absorbed, never duplicated.
4. PULL never forces an illegal task transition — the tasks/repo.ts state machine wins; skips are honest and reported per item.
5. **Every call site passes `dryRun` EXPLICITLY** — the adapter default is false and must never be relied on (see SYN-1).
6. Board sync is opt-in, one-way push, anchored on the issue mapping; probe() honesty everywhere.
7. New external targets = a registered SyncAdapter id (code contribution, ADAPTER-FRAMEWORK-SPEC §2 constraint applies); unknown id fails loud.

## 3. Gaps → items (in `periphery-hardening`)
| id | gap | required behavior | shape |
|---|---|---|---|
| **SYN-1** | Adapters default `dryRun:false`; a future non-route caller (PM engine, analytics) doing a bare `sync()` performs REAL GitHub mutations. | Make `dryRun` REQUIRED on `SyncRunOptions` (compile-time force at every call site); route passes its checkbox value unchanged. | build (small type change + call-site sweep; red-team the no-explicit-dryRun path) |
| **SYN-2** | `SyncRegistry` + `board-repo.ts` have no direct tests. | Add unit suites (register/resolve/dup-throw; config MERGE-preserve + incident rows). | build (small) |
| **SYN-3** | Live GitHub round-trip is a deferred proof. | Stays deferred; proven live during `new-mod-test` (operator-driven) — record the proof in the ledger/devlog when it happens. | parked (operator) |
| **SYN-4** | No autonomous/scheduled sync. | Deliberate; a future PM-proposed sync would ride D-039 validation. Documented. | documented |
