# ROUNDS Modding — Session Handoff

You are picking up ROUNDS mod development (CURRENT game build, not the old Thunderstore ecosystem). Read this fully before touching anything.

## The immediate task

I hit an error and want it root-caused and fixed:

```
When playing in multiplayer, the draw cards never left player 2's screen, they stay present even when the round started and we spawned into the field.
```

Debug per the Iron Law: no fix without an instrumented root cause — form a testable hypothesis, confirm it with a log/diagnostic at the suspected cause plus a deterministic repro, THEN fix. 3 failed hypotheses = stop and present options. Scope-lock edits to the affected module.

## Logs & install paths (verified on disk 2026-07-11)

- **Game install**: `E:\SteamLibrary\steamapps\common\ROUNDS`
- **BepInEx log (read this FIRST — it has the `[UnboundLib DIAG]` lines)**: `E:\SteamLibrary\steamapps\common\ROUNDS\BepInEx\LogOutput.log` — last modified TODAY 14:05, so it very likely still contains the error this handoff is about. It is overwritten on every game launch; copy it aside before relaunching.
- **Operator-saved log captures of the failing runs (start with these — two runs from today)**: `C:\Users\11sos\OneDrive\Desktop\LogOutput.log` (14:04) and `C:\Users\11sos\OneDrive\Desktop\LogOutput-2.log` (14:06). These are the preserved evidence even after the game relaunches; diff them against each other and the live log.
- **Unity player log**: `C:\Users\11sos\AppData\LocalLow\Landfall Games\ROUNDS\Player.log` (previous run: `Player-prev.log`, plus `output_log.txt` in the same dir) — check here for engine-level exceptions BepInEx doesn't capture.
- **Deployed plugins**: `E:\SteamLibrary\steamapps\common\ROUNDS\BepInEx\plugins\CardDrawControl\` and `...\plugins\UnboundLib\` (deploy target for builds). Note `BepInEx\_stash_PickNCards\` — old PickNCards is stashed, NOT loaded; don't resurrect it.

## Ground truth (verified 2026-07-03, full map in `F:\code\UnboundLib\PORTING-NOTES.md`)

- **Game**: ROUNDS, Steam buildid **21020021**, Unity 2022.3.34f1, Mono x64. The old modding ecosystem (Thunderstore-published UnboundLib/PickNCards etc.) targets the PRE-update build and **silently no-ops or breaks** on this one — that's the defect class that dominates this work: "old-build setup silently no-ops on new build." Never assume a published mod/dll works; verify against our ported forks.
- **BepInEx**: 5.4.23.5, our port at repo `SLO42/BepInExPack_ROUNDS_Port` (branch `main`).
- **UnboundLib**: the operator's FIXED fork — `F:\code\UnboundLib`, branch `main`, tip `cd7d141`. Boot emits `[UnboundLib DIAG]` lines — read them first when anything misbehaves; they are the fastest signal for load-order/patch failures.
- **CardDrawControl** (our mod, supersedes PickNCards): `F:\code\CardDrawControl`, branch `master`, tip `4db59e6`. Combined mod: PickNCards-style draw-count fan + SelectAnyNumber pick-many + a Continue card. 1.0.0 built, boot-verified, and **full 2-player modded multiplayer verified clean with default settings**.

## Iron rules for this codebase

1. **Never throw on the Photon dispatch thread.** An exception inside a Photon event/RPC handler kills networking silently for the session. Wrap handlers; log and degrade.
2. Harmony/HarmonyX patches against the new build: verify the target method still exists with the same signature before patching (the update renamed/reshaped things — this is where silent no-ops come from). MMHOOK needs regeneration after any game update.
3. After any change: build → deploy to the BepInEx plugins dir → launch the game → read the boot log (`[UnboundLib DIAG]` + BepInEx `LogOutput.log`) for a clean load BEFORE testing behavior. A green compile means nothing here.
4. Kill the game process when a verify run is done (Windows: `tasklist /FI "PID eq <pid>"` to check, `taskkill //F //PID <pid>` — bash `kill` can't reach Windows PIDs).
5. Commit working states before experimenting further — split commits by logical group.

## Known-latent (untested) areas — likely suspects if the error is sync/settings related

- **Settings-sync (CardManager path)**: non-default CardDrawControl settings were NEVER tested in multiplayer. If the error involves non-default draw counts / pick counts in MP, suspect the settings sync first.
- Neither UnboundLib fork fixes nor CardDrawControl are pushed to a remote — local repos are the only copies. Don't rebase/rewrite; commit forward.

## Boundaries

- **Thunderstore publish is operator-gated (D-037)** — never publish, package for publish only if asked.
- If a fix requires touching the UnboundLib fork, keep the fix minimal and note it in `PORTING-NOTES.md` (that file is the porting source of truth).
- There is a specialized agent available: `rounds-mod-developer` (C#/BepInEx/Unity, current-build aware) — use it for the heavy build/verify loops.

## Wider context (one line)

These repos are also managed inside Atelier (the ai-playground v2 platform) as the ROUNDS project; platform work is paused — this session is pure mod development, don't start platform waves.
