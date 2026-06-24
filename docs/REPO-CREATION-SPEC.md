# REPO-CREATION-SPEC — create a project repo, private-first (operator or PM-proposed)

**Status**: queued (BL-0, 2026-06-23). Operator directive: the operator can create a repo
for a project, AND a PM can create one when it judges the project needs one — **ALWAYS
private first**. Outward-facing (real GitHub resources) → D-037-class gating.

## Grounded seams (verified — F:\code\ai-playground-v2, branch v2)

REUSE (exists):
- **GitHub auth + `gh` CLI seam**: `src/lib/server/sync/gh-client.ts` — `GitHubClient` wraps
  the `gh` CLI via `runGh([...])` (array args, D-008 no-shell); `isAuthenticated()` →
  `gh auth status` (operator keychain or `GH_TOKEN` env). The release adapter already uses
  `GH_TOKEN` (`src/lib/server/adapters/github-releases/adapter.ts:46`, `GITHUB_SECRET='GH_TOKEN'`).
- **D-037 outward gate pattern**: `src/lib/server/projects/release-gate.ts` — recorded operator
  **consent** (a `pm.*_preauthorized`-style flag) + a **deterministic `confirmTokenFor()`** +
  a gated `runTargetAction()` that validates the token BEFORE the real external call; any RED →
  honest `…: false` + named `failedAt`. Repo-creation MIRRORS this rail.
- **Local git runner**: `src/lib/server/orchestrator/post-task.ts` — `execFileRunner` (shell:false,
  array args) and `assertLocalGit` with `FORBIDDEN_GIT=['push','remote']` + `--force/-f` refused
  (D-018, the post-task loop is purely local).
- **Project row**: `src/lib/server/projects/repo.ts:33-51` — `repo_url?` (optional) ALREADY exists;
  NO `visibility`/`private` field. `git init` + initial commit DO run on Create-with-AI scaffold
  (`src/lib/server/create/execute.ts:1282-1302`), **local only — no remote added**.
- **PM proposal rail (§4.1)**: `proposeTask()` (`pm-proposals.ts:187-259`) enforces the
  objective/purpose/acceptance_criteria/provenance contract → born `proposed`; `runValidationPanel()`
  (`pm-panel.ts`) → operator decides (classification mechanical/taste/operator_challenge).

BUILD NEW (absent — verified by search): no `createRepo`, no `git remote add`/`git push`, no
`gh repo create` anywhere in src/; no `visibility`/`private` project field; OpenClaw gateway is
NOT present in the v2 tree.

## Design

Repo-creation is a **sanctioned, gated OUTWARD action** — the deliberate exception to the
post-task local-only git rule (`FORBIDDEN_GIT`). It has its OWN gated runner; it must NOT route
through `assertLocalGit` (which would refuse `remote`/`push`) and must NOT weaken `assertLocalGit`
(the post-task loop stays local-only). Two trigger paths, one gate:

- **Operator-create** (direct): an operator action on the project page → the gated driver.
- **PM-proposed**: the PM proposes "this project needs a repo" through the §4.1 proposal + panel +
  operator 'act' authority. The PM NEVER creates a real repo unilaterally (B4/D-039 — same rail as
  publish/hire).

Both converge on the **gated driver**, which:
1. asserts **private-first** (hardcoded `--private`; a public repo is NEVER created here — a later
   public flip is a separate, explicit operator-gated action, out of scope);
2. validates recorded operator **consent** + a deterministic **confirm-token** (mirror release-gate);
3. requires `gh` **authenticated** (`isAuthenticated()`); if not → fail closed honestly (no fabrication);
4. `gh repo create <owner>/<name> --private --source <root_path> --remote origin` (or create-then-
   `git remote add origin` + `git push -u origin <branch>` via the dedicated outward runner) so the
   existing local scaffold commits are backed;
5. records the actual remote URL to `project.repo_url` on success;
6. is **idempotent / honest**: repo already exists, permission denied, not-authed, name collision →
   NAMED outcomes (F-008), never a crash, never fabricated success.

### Tasks (each = a wave task)

- **RC-1 — `GitHubClient.createRepo`** (gh-client.ts): `createRepo({name, owner?, private:true})`
  via `runGh(['repo','create', …, '--private'])` (array args, D-008). Private hardcoded — the
  type makes public unrepresentable here. Honest outcomes: created / already-exists / denied /
  unauthed (precheck `isAuthenticated()`). Unit-tested against a stubbed `runGh` (no real network).
- **RC-2 — repo-creation gate** (`src/lib/server/projects/repo-creation-gate.ts`, NEW): mirror
  release-gate's D-037 shape — recorded consent + `confirmTokenFor({projectId, kind:'repo-create', …})`
  + a gated driver that (auth-check → createRepo(private) → remote add + push -u via the dedicated
  OUTWARD runner, NOT assertLocalGit → write `project.repo_url`). Private-first asserted at the gate.
  Honest failure surfacing (named `failedAt`). Additive migration ONLY if a consent/visibility field
  is needed (F-015; prefer reusing an existing consent flag or add one idempotently).
- **RC-3 — PM proposal kind 'repo-create'** + operator-create entrypoint: a PM trigger/proposal
  ("project needs a repo") through `proposeTask` §4.1 + panel + operator gate (never unilateral,
  B4/D-039); and the direct operator-create call into the RC-2 gate.
- **RC-4 — operator UI** (project page): a "Create repo (private)" control + the consent/confirm
  surface (mirror the publish confirm UX), honest states (F-008), surfaces the created `repo_url`.
  Design-system tokens; reuse the SessionFailureReason/confirm patterns.

## Integrity invariants (red-team targets)

- **Private-first, ALWAYS**: no code path creates a public repo; `--private` is non-optional; public
  is unrepresentable in createRepo's type. A red-team task must try to coerce public and fail.
- **D-037 gate holds**: no repo is created without recorded operator consent + a valid confirm-token;
  the PM cannot create unilaterally (proposal→panel→operator 'act' only).
- **Local-only git rule preserved**: `assertLocalGit`/`FORBIDDEN_GIT` UNCHANGED; the outward
  remote/push lives ONLY in the gated repo-creation runner, never in the post-task loop.
- **D-008**: every gh/git call is array-args, no shell; project name/owner/root are inert argv.
- **D-026**: never log/persist/render the `GH_TOKEN` value (env NAME only); screen any operator note.
- **Honest + idempotent (F-008)**: already-exists / denied / unauthed → named outcomes; a second
  create is a no-op, not a crash or a fabricated success; `repo_url` only set on real success.
- **F-013/§6.1**: `repo_url` (and any new field) coerced in the normalizer, omit-when-absent.

## Verification (DoD — D-038)

- Unit: createRepo private-hardcoded + each honest outcome (stubbed runGh); gate refuses without
  consent/token; private-first coercion; idempotent already-exists.
- Integration: the gated driver path (stubbed gh) writes repo_url on success, surfaces named failures.
- Build + test + lint(0) + svelte-check(0). Live-verify the UI control + honest states.
- NO real GitHub repo created in tests (stub the gh seam) — D-037 real outward only behind the
  operator gate at runtime.
