# RUNBOOK — first real Thunderstore publish (SWIP / ROUNDS)

> Operational checklist for the FIRST credentialed publish through the D-037 adapter framework. Follow in order; do not skip the rehearsal. After one verified manual run, this graduates into a one-button workflow (§9). All file refs = branch `v2`, worktree `F:\code\ai-playground-v2`.

## 0. Build prerequisite (one-time, BEFORE this runbook is usable)

The adapter currently **defers the real upload by design**: `publish(dryRun=false)` returns ok:false "prepared but NOT executed in this track" (`adapters/thunderstore/adapter.ts:358-368`). A small build task must land first:

- [ ] **Flip the deferral**: execute the already-planned 4-step upload (initiate-upload → upload-parts → finish-upload → submit, `api.ts:82-139`) when the gate confirm + `THUNDERSTORE_TOKEN` are present. Keep dry-run-by-default.
- [ ] **Add `verify()`** to the adapter (and the `PublisherAdapter` contract, `types.ts:156-170`): after submit, poll the Thunderstore package page/API until the new version is visible; honest timeout → incident.
- [ ] Both through the normal BUILD → DoD-review pipeline.

## 1. Secret (D-026)

- [ ] Put `THUNDERSTORE_TOKEN=<service-account token>` in `F:\code\ai-playground-v2\.env` (NEVER committed; create the token in Thunderstore team settings → service accounts).
- [ ] `/projects/swip/targets` shows `THUNDERSTORE_TOKEN` as **set** (name + presence dot only — the value never renders anywhere; if you ever see the value in any UI/log, STOP and report it as a security defect).

## 2. Target config

- [ ] Declare (or verify) the publish target on the SWIP project — adapter `thunderstore`, config JSON like:
  `{ "namespace": "<your Thunderstore team>", "communities": ["rounds"], "categories": { "rounds": ["..."] }, "hasNsfwContent": false, "payloadDir": "<where the built dll lands>" }`
  — `namespace` is REQUIRED for a real submit; `payloadDir` defaults to `plugins/`.
- [ ] Mark it the default `publish` target (one default per kind).

## 3. Release artifacts in the project root

- [ ] `manifest.json`: `name` (`[A-Za-z0-9_]`, ≤128), `version_number` strict 3-part semver (**bump it** — Thunderstore permanently rejects re-used version numbers), `description` (≤250), `website_url` (http(s) or `""`), `dependencies` array (`Team-Package-1.2.3` format).
- [ ] `icon.png` — valid PNG, **exactly 256×256**.
- [ ] `README.md` — present, non-empty.
- [ ] Built mod dll(s) under `payloadDir`.

## 4. Preflight (no upload, free)

- [ ] Targets tab → package preview: blockers list MUST be empty; read every warning. The zip contents listing must show manifest/README/icon + your payload files.

## 5. Dry-run (no upload, free)

- [ ] Run the dry-run. Read the rendered 4-step request plan — confirm namespace, package name, version, communities are exactly right. Auth line should read "Auth via THUNDERSTORE_TOKEN (present)".

## 6. The gated real publish (D-018)

- [ ] Confirm using the token from THIS dry-run. The confirm token is bound to a hash of the target config — **if you edit the config after the dry-run, the confirm fails closed (HTTP 403)**: re-dry-run, re-read, re-confirm. That is the gate working, not a bug.
- [ ] The publish fires the 4-step upload. Every attempt is ledgered to `target_run` regardless of outcome; a failed real publish raises an incident (RightTray/notifications) — never silent.

## 7. Verify after

- [ ] Adapter `verify()` (post-§0) confirms the version is live; manually: thunderstore.io package page shows the new `version_number`, download works, icon/README render.
- [ ] `target_run` row: ok:true, correct target_ref. No incident fired.
- [ ] Leave `.env` as-is; nothing to clean.

## 8. When it fails

- **Preflight/validate blocker** → fix the artifact, re-run §4. Free, safe, repeat at will.
- **Gate 403 "token does not match"** → config changed since dry-run; re-run §5→§6.
- **Upload step fails mid-flight** → read the incident + `target_run.steps`. SAFE to retry the whole publish with the SAME version **only if submit never succeeded**; if submit succeeded (version exists on Thunderstore) → **bump the version, never retry the same one**.
- **Token rejected (401/403 from Thunderstore)** → token expired/wrong team; rotate in Thunderstore, update `.env`, restart the dev server (env is read at boot).

## 9. Graduation path — automate after the first verified run

The first manual run is the rehearsal; the `target_run` ledger is the recording. Once §1–§7 has succeeded ONCE:

1. Add a `verify` stage after `publish` in `RELEASE_STAGES` (`release/pipeline.ts:48-55`) calling the adapter's `verify()`.
2. The release pipeline (dry-run → test → changelog → version → tag → publish → verify) already drives the chosen adapter — future releases become **one button on the release tab with exactly ONE human pause** (the publish gate confirm).
3. Failure handling stays honest: any red stage aborts downstream, raises an incident; the "bump-don't-retry" rule from §8 is encoded in the publish step.
4. This document remains the fallback for when the automation itself is suspect.
