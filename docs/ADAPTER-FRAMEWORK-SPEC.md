# ADAPTER-FRAMEWORK-SPEC — the D-037 contract (publish · deploy · sync) and its gate driver

**Status:** DRAFT (2026-07-08) · implements D-037 (+D-016/D-018/D-026) · carries F-008/F-020/F-045(spirit)/F-055(family) · queued `adapter-framework-hardening` (gate:operator)
**One-liner:** the pluggable adapter framework is BUILT and further along than RELEASE-SPEC recorded — `verify()` is on the contract, Thunderstore's real gated upload and GitHub sync are live-capable; only npm/github-releases/static-host still defer. This spec states the framework CONTRACT (typed interfaces, fail-closed registries, named-secret confinement, deterministic confirm tokens, the target_run ledger) and corrects one over-claim: custom per-project adapters are code-contributions, not runtime-loadable.

Grounding: opus scout pass 2026-07-08 over `src/lib/server/adapters/` + the `sync/` boundary (file:line verified). RELEASE-SPEC carries a dated STALE-PROPOSED note for its superseded claims. Code on branch `v2`.

## 0. Scope & boundary

- **In scope:** `adapters/` (types, secrets, registry, driver, contract, catalog, builtins, npm/, thunderstore/, github-releases/), the `SyncAdapter` boundary (`sync/adapter.ts`, registry shape only), tables `project_target` + `target_run`.
- **Out of scope:** the release pipeline stages + operator release surface (RELEASE-SPEC — its §2.1 "no surface" gap remains the live delta); GitHub sync internals (SYNC-SPEC, forthcoming); repo-creation gate (PROJECTS-SPEC §3, same token machinery).

## 1. The typed contract (`adapters/types.ts`)

- `AdapterKind = 'publish' | 'deploy' | 'sync'` (:119). `BaseAdapter` (:122): `readonly id/label/kind`, `secrets(): SecretRequirement[]` (:130).
- `PublisherAdapter` (:156): `probe()` (:159 — **NEVER throws**; degraded → honest reason), `validate()` (:161), `package()` (:163), `publish({dryRun})` (:169), **`verify?()` (:178, OPTIONAL — TASK 14.7)**.
- `DeployTarget` (:199): `probe`/`deploy`/`status→DeployStatus`. `ActionAdapter = PublisherAdapter | DeployTarget` (:255) — the two confirm-token-gated families. `SyncAdapter` mirrors the shape in `sync/adapter.ts` with its own registry.
- Errors: `UnknownAdapterError` (:230), `SecretConfinementError` (:244).

## 2. Registries — fail-closed, per-project resolution via rows

- `AdapterRegistry` (registry.ts:39): `register()` throws on duplicate id (:47/:52); `getPublisher`/`getDeployer`/`get` throw `UnknownAdapterError` on miss (:62/:69/:77). `SyncRegistry` mirrors this (sync/adapter.ts).
- Per-project resolution is DATA: a `project_target` row (`declareTarget` :157, `getTarget` :221, `resolveDefaultTarget` :232) names `adapter_id`; the driver resolves it against the registry — unknown id fails closed.
- Process-wide seeding: `getAdapterRegistry()` (index.ts:52) registers the 4 built-ins (Npm, Thunderstore, GitHubReleases, StaticHost).
- **Constraint (corrects index.ts:6's over-claim):** a NOVEL adapter is a **code contribution** — implement the interface + `register()` it. There is deliberately NO config/runtime path that loads adapter code: adapters run with secrets and outward network access, so runtime-loadable adapters would be arbitrary-code-execution behind a config row (D-026/D-018 violation). "Per-project custom target" means a per-project `project_target` row selecting any REGISTERED adapter with custom config — not per-project code.

## 3. Secret confinement (D-026 named-secret indirection)

- Adapters declare env-var NAMES only (`secrets()`); `makeSecretResolver(env, requirements)` (secrets.ts:36) scopes resolution to the declared set — **any undeclared name throws `SecretConfinementError`** (:40/:44). `describeSecrets` (:56) is presence-only for the UI. Raw values are read at call time inside the adapter (e.g. thunderstore/adapter.ts:372), sent only where needed (Authorization header), never returned, logged, or persisted.

## 4. The gate driver (`adapters/driver.ts`) — deterministic confirm tokens + honest ledger

- `confirmTokenFor({projectId, kind, adapterId, config})` (:76): sha256 over key-sorted `canonicalJson(config)` (:50) then the tuple — ANY config change ⇒ new token; a publish token cannot confirm a repo-create (`GatedActionKind` :67 hashes kind in).
- `runTargetAction` (:158): resolve target (belongs-to-project + kind asserts :128–136) → for `!dryRun`: missing token → `GateConfirmError` "run a dry-run first… (D-018)" (:178); stale token → "re-review… confirm again" (:183). Adapter throw ⇒ failed `target_run` + `recordIncident` + rethrow (:200–213) — never silent (F-008).
- `runTargetVerify` (:269): drives optional `verify()`; adapter without verify ⇒ honest throw (:~273). `runSyncTarget` (:~366): same registry + same ledger; never token-gated (sync self-degrades honestly).
- **Ledger `target_run`** (registry.ts:251): project/target?/kind/adapter_id/dry_run/ok/target_ref?/summary/steps[]/at; `recordTargetRun` (:294) param-bound CONTENT (D-016); `listTargetRuns` (:326) projects `at` (F-020 fix); `lastRunFor` (:321) matches STRICTLY on the target link — no cross-attribution when two targets share an adapter id (13.4a).

## 5. Built-in adapters — live vs deferred (the honest matrix, 2026-07-08)

| adapter | probe/validate/package | real action | verify() |
|---|---|---|---|
| **Thunderstore** | real | **LIVE** — real gated 4-POST upload (`api.ts executeUploadPlan`, injectable fetch) when `THUNDERSTORE_TOKEN` present; missing token → honest deferral (:378–386); missing namespace → honest fail BEFORE any external call (:388–399) | **implemented** |
| npm | real | DEFERRED — `ok:false "prepared but NOT executed…"` (:230–236) | no |
| GitHub releases | real (probe degrades honestly unauth :125) | DEFERRED (:20) | no |
| StaticHost deploy | real | DEFERRED (`deferReal()` builtins.ts:36; `status()` → 'unknown' :97) | n/a |
| GitHub sync | — | **LIVE-capable** — real `runGh` behind `!dryRun` (sync/github.ts:388/:415/:485; dryRun defaults FALSE :235) | n/a |

Flipping a deferral = mirror Thunderstore's shape (real executor + injectable client + honest pre-call failures), always behind `runTargetAction`'s token. Operator-gated (D-037), tracked in RELEASE-SPEC.

## 6. Error convention (D-037 additive note) & contract harness

- Every adapter/driver error names the failing input, the cause, and the NEXT ACTION — verified adhered (driver.ts:136/:179/:183; thunderstore/adapter.ts:383/:397; UnknownAdapterError names the id). No violations found; new adapters are held to it by review.
- `contract.ts` is the credential-free contract harness (not a vitest file): `runPublisherContract` (:118) asserts probe-never-throws + honest reasons + dry-runs non-mutating (`checkDryRunResult` :98); `runDeployContract` (:168) mirrors. **Every new adapter must pass the harness** — it is the executable form of this spec's §1.

## 7. Normative invariants

1. Every gated external action routes through `runTargetAction`/`runTargetVerify`/`runSyncTarget`; a real action requires the config-bound confirm token, fail-closed (the F-055 family rule applied outward).
2. Unknown adapter id fails closed in EVERY registry; duplicate registration throws.
3. Secrets are names in DB/UI (presence-only); values resolve call-time through the scoped resolver; undeclared names throw (D-026).
4. Every attempt — dry or real, pass or fail — writes exactly one `target_run` row; failures also raise an incident; nothing external happens silently (F-008).
5. `probe()` never throws; deferral/missing-credential is an honest `ok:false` with a named recovery, never fabricated success.
6. Errors name their recovery action (D-037 additive note) — consumed by agents, not humans.
7. Novel adapters are code contributions passing the contract harness; no runtime code loading (§2).
8. Dry-run is first-class and free; a succeeded submit is never retried on the same version (bump-don't-retry, RELEASE-SPEC).
9. The ledger's `lastRunFor` attribution is per-target, never per-adapter-id.
10. Sync adapters share the ledger + registry discipline but are never token-gated — they must self-degrade honestly instead.

## 8. Gaps → hardening items (`adapter-framework-hardening`, gate:operator)

| id | gap (verified) | required behavior | shape |
|---|---|---|---|
| **ADF-1** | `adapters/index.ts:6` claims a project can declare a custom adapter "WITHOUT touching any caller" — false; registration is code-only (correct per §2, wrong as documented). | Fix the comment to state the §2 constraint verbatim. | build (comment-only, haiku-tier; fold into any nearby wave) |
| **ADF-2** | Two duplicate `UnknownAdapterError` classes (types.ts:230 and sync/adapter.ts) — same name, different identities; a catch on one misses the other. | Consolidate: sync re-exports the types.ts class (or a shared base). Byte-identical messages. | build (small) |
| **ADF-3** | npm / github-releases / static-host real executors still deferred. | Stays deferred until a real customer needs them (Thunderstore is the graduation path). When flipped: mirror Thunderstore's executor shape + contract-harness + red-team (token-bypass probes). NOT this wave. | parked (operator) |
| **ADF-4** | RELEASE-SPEC §2.1 — no operator release surface — remains the live delta. | Owned by RELEASE-SPEC's `release-pipeline` queue item; not duplicated here. | cross-ref |

## 9. DoD (D-038)

- [ ] ADF-1/2 land; contract-harness + registry/secrets/catalog suites green; no migration.
- [ ] No change to any live adapter behavior (Thunderstore upload path untouched byte-identical).
- [ ] Gates green token-unset (F-029); devlog row.
