# RELEASE-SPEC — the versioned release/publish pipeline (last mile)

**Status:** DRAFT (2026-07-07) · implements D-037 · gates D-039 · queued `release-pipeline` (gate:operator)
**One-liner:** the D-037 adapter framework, the release pipeline, and the release-readiness gate are all BUILT — but there is **no operator-reachable release surface**, every real external publish is **deferred** ("prepared but NOT executed"), and `verify()` isn't on the contract. This spec is the last mile: wire the surface, flip the deferral, add verify. It closes the RELEASE half of the lifecycle and powers `new-mod-test`'s first real publish.

> STALE-PROPOSED (2026-07-08, adapter-framework scout — codebase wins): **two of the three one-liner gaps have since been BUILT (TASK 14.7).** `verify()` IS on the `PublisherAdapter` contract (`types.ts:178`, driven by `runTargetVerify` `driver.ts:269`) — §2.3/§3.3/RL-3 are done. And the deferral is only PARTIAL: **Thunderstore executes its REAL gated 4-step upload when `THUNDERSTORE_TOKEN` is present and implements verify()** (`builtins.ts:3-5`, `thunderstore/api.ts executeUploadPlan`, `adapter.ts:372-399`); GitHub sync pushes real via `runGh` behind `!dryRun` (`sync/github.ts:388/415/485`). Still deferred: npm / github-releases / static-host (§2.2 holds for those only). **§2.1 (no operator-reachable release surface) remains TRUE and is the live delta.** See `ADAPTER-FRAMEWORK-SPEC.md` for the current contract. Mark, not delete — operator retires.

## 1. What's already BUILT (the substrate)

- **Adapter contract** — `adapters/types.ts`: `AdapterKind = 'publish'|'deploy'|'sync'`; `BaseAdapter {id, kind, secrets()}`; `PublisherAdapter` = `probe() · validate() · package() · publish({dryRun})`; `SecretResolver`/`SecretRequirement` — **named-secret indirection, presence-only, fail-closed on an undeclared name** (D-026).
- **Registry (pluggable, NOT hardcoded)** — `adapters/registry.ts` (`AdapterRegistry`, `UnknownAdapterError` fail-closed), unified `adapters/catalog.ts` across publish/deploy/sync.
- **Gate driver** — `adapters/driver.ts`: `confirmTokenFor({projectId,kind,adapterId,config})` (deterministic token) → `runTargetAction()` re-derives + throws `GateConfirmError` on missing/stale token BEFORE the real call → records a `target_run` ledger row.
- **Release-readiness gate** — `projects/release-gate.ts`: `runReleaseReadinessGate` — objective machine-checked chain `consent | target | token | build | pack | validate | publish` with honest `failedAt`; consent = `pm.auto_publish_preauthorized`; on green calls `runTargetAction(dryRun:false)`.
- **Pipeline** — `release/pipeline.ts`: `RELEASE_STAGES = ['dry-run','test','changelog','version','tag','publish','verify']`; `buildReleaseSteps()` → sequential `WorkflowStep[]`, each stage a **headless-session prompt** (agent-driven, not library code — see fork §7.1).
- **Adapters** — publishers `npm/`, `thunderstore/`, `github-releases/` (+ real `changelog.ts`); deploy `StaticHostDeployTarget`; sync `github`/`github-board`.
- **Outward auth** — `sync/gh-client.ts` (`GitHubClient`, `runGh` array-arg no-shell, private-first `createRepo`); `project.repo_url` (`schema.ts:36`). Secrets = names only (`GH_TOKEN`/`THUNDERSTORE_TOKEN`/`DEPLOY_TOKEN`), never logged.

## 2. The gaps (the actual delta)

1. **No release route / operator UI.** Grep `src/routes` for `runReleaseReadinessGate | runTargetAction | buildReleaseSteps` → **zero hits.** The whole pipeline+gate+adapters are server-lib only, unreachable. (Contrast: `repoCreate` IS wired at `routes/projects/[id]/+page.server.ts:1610`.)
2. **Real external publish DEFERRED in every adapter.** Thunderstore `publish(dryRun=false)` returns `ok:false "prepared but NOT executed in this track"` (`thunderstore/adapter.ts:358`); StaticHost/npm/github-releases same. The plan/validate/package are real; the upload is stubbed.
3. **`verify()` not on the `PublisherAdapter` contract** — only a `verify` *stage prompt* exists. Post-publish verification has no adapter method.

## 3. Design — close the last mile

### 3.1 Release surface (route + UI)
Mirror the built `repoCreate` wiring (`+page.server.ts:1610`): a release action + a project **Release** control that drives `runReleaseReadinessGate`. Honest states (idle / checking / dry-run-ready / gated-confirm / publishing / published / failed-at-`<stage>`). ONE human pause: the publish confirm (D-018 token). Surfaces `failedAt` verbatim.

### 3.2 Flip the deferral (per adapter, gated)
Turn each adapter's `publish(dryRun:false)` from "prepared but not executed" into the real upload — behind `runTargetAction`'s confirm-token so it can only fire post-gate. Start with **Thunderstore** (ROUNDS is the first customer); npm/github-releases follow. Keep dry-run first-class + free.

### 3.3 Add `verify()`
Add `verify()` to `PublisherAdapter` (`types.ts:156-170`) + wire the `verify` stage after `publish` (post-publish: confirm the artifact is live/fetchable). Honest — a failed verify is a real failed state, not a silent pass (F-008).

### 3.4 Version / changelog / tag
Today these are **agent-executed** (headless-session prompts), not library functions (only `github-releases/changelog.ts` is real code). Fork §7.1: keep agent-driven, OR make version-bump + tag deterministic library steps (safer, reproducible) and leave changelog *prose* to the agent. Recommend: **deterministic version-bump + git-tag** (semver is mechanical; TS rejects a reused version — a wrong bump is a hard failure), agent-authored changelog body.

## 4. The gate (unchanged pattern, preserved)
- Consent = `pm.auto_publish_preauthorized` (D-039 — PM proposes a release, operator pre-authorizes or confirms).
- Confirm token via `confirmTokenFor` → `runTargetAction` (D-018) — the real upload cannot fire without it.
- **Publish stays operator-gated even under autonomous-to-v1** (D-037): the v1.0.0 publish is the ONE thing that gate protects; autonomous drives everything up to it, the human confirms the upload.

## 5. Runbook rules to encode (RUNBOOK-thunderstore-first-publish §8)
- **Bump-don't-retry**: if a submit SUCCEEDED, never retry the same version — bump (TS/most registries reject a reused semver). A failed *verify* after a *successful* submit means bump next, not re-submit.
- **Token 401/403 → rotate + restart** (env read at boot, F-029 sibling).
- Artifacts in project root: strict 3-part semver `manifest.json`, 256×256 `icon.png`, `README.md`, built payload under `payloadDir`.

## 6. Safety invariants (already honored — preserve)
- **D-037**: pluggable registry, named-secret presence-only, operator-gated publish. Cloud secret managers stay deferred (resolver is the seam).
- **Local-only-git**: outward `remote`/`push` lives ONLY in the gated release/repo-creation runners (`assertLocalGit FORBIDDEN_GIT`), never the post-task loop.
- **D-026**: tokens are names only, never logged/persisted; changelog/artifact content screened.
- **F-008 / F-014**: honest per-stage states; bounded external calls; no fabricated "published".

## 7. Build tasks
- **RL-1** Release route + project Release control wiring `runReleaseReadinessGate`/`buildReleaseSteps` (mirror repoCreate); honest states + `failedAt`.
- **RL-2** Flip the Thunderstore adapter's real upload behind the confirm token (real `publish(dryRun:false)`); dry-run unchanged.
- **RL-3** Add `verify()` to `PublisherAdapter` + the `verify` stage (post-publish liveness); honest fail.
- **RL-4** Deterministic version-bump + git-tag steps (fork §7.1) OR keep agent-driven — decide, then implement; changelog body stays agent-authored.
- **RL-5** npm + github-releases real-upload flips (after Thunderstore proves the path).

**Verify:** real-surreal + adapter unit tests (dry-run plan correct; gate blocks without token; `runTargetAction` records the ledger row); **NO real external upload in tests** (stub the registry API, assert the call shape). redTeam RL-2 (prove the real upload cannot fire without the confirm token + consent; no token leak). The live first-publish is operator-driven (`new-mod-test`).

## 8. Open forks
1. **Stage execution**: agent-driven headless-session stages (built) vs deterministic library steps for version/tag. Recommend deterministic version+tag, agent changelog.
2. **First adapter**: Thunderstore (ROUNDS) first — recommend yes.
3. **`verify()` shape**: fetch-the-published-artifact vs registry-status query — per adapter.
