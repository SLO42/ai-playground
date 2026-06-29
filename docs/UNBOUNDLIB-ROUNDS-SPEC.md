# UnboundLib (current ROUNDS) — grounded project spec (2026-06-26)

> The next Atelier project after the BepInExPack_ROUNDS port. Written GROUNDED in
> verified evidence (live game tests + the upstream investigation) to PREVENT the
> kind of misframe that hit the pack project (Create-with-AI built a mod template
> instead of the pack). Every claim here was confirmed this session.

## Deliverable (exact)
A **working build of UnboundLib for the CURRENT ROUNDS** (Unity 2022.3.34f1, public
branch) running on our **BepInExPack_ROUNDS 5.4.23.5** — i.e. the core ROUNDS modding
library, functioning (cards + game-modes init, no error flood), packaged for Thunderstore.
This is the **modding-API layer** the whole ecosystem (incl. PickNCards) depends on.
NOT a mod, NOT a template — a fixed/rebuilt library.

## Why (verified)
- ROUNDS moved to Unity 2022.3 → the old Unity-2019-era UnboundLib breaks. Confirmed live:
  the latest Thunderstore UnboundLib (willis81808 3.2.14) loads but floods NREs
  (`MissingMethod: GM_ArmsRace.Start`, ambiguous `CardBar.OnHover`) — identical under both
  the old 5.4.19 pack and our 5.4.23.5 pack, so it's **mod-vs-game, not pack**.
- Upstream `Rounds-Modding/UnboundLib` is dormant (last code 2023-11).
- **`github.com/Bknibb/UnboundLib` v4.2.4** already ported it to ROUNDS **v1.1.2** (commit
  `68dd6a3`) — source + prebuilt release DLLs. Tested live: its prebuilt **clears the
  GM_ArmsRace/CardBar breaks (0 now)** BUT still ~2953 NREs from a NEWER cause — the
  current build moved PAST v1.1.2. The new NREs route through
  `UnboundLib.ExtensionMethods.ExecuteAfterSeconds/Frames → StartCoroutine` in the
  `CardChoiceVisuals`/`MainMenuHandler`/`CardChoice.Start` hooks (hooks FIRE, but game
  state is null) → **Bknibb's v1.1.2 MMHOOK + patches are stale for the exact current build.**

## The work (grounded build plan)
Start from **Bknibb/UnboundLib source** (fork it; don't re-derive — it already fixed the
v1.1.2 layer). Then adapt to the CURRENT build:
1. **Fork + repo**: fork `Bknibb/UnboundLib` into a SLO42 repo (private-first, D-037 gate).
2. **Regenerate MMHOOK**: regenerate `Assemblies/MMHOOK_Assembly-CSharp.dll` from the LIVE
   game's `Assembly-CSharp.dll` (`E:\SteamLibrary\steamapps\common\ROUNDS\ROUNDS_Data\Managed\`)
   via **MonoMod HookGen** (the `MonoMod.RuntimeDetour.HookGen` tool — BepInEx bundles
   MonoMod). Bknibb's bundled MMHOOK is for v1.1.2 → stale; this is the prime suspect for
   the new NREs.
3. **Build from source** against the current ROUNDS DLLs: set `RoundsFolder` to the install
   (csproj HintPaths use `$(RoundsFolder)\ROUNDS_Data\Managed\…`), `dotnet build` (net472).
4. **Verify in-game** (see below) → if NREs persist, diagnose the remaining stack traces
   (game-API changes since v1.1.2) and re-point the affected Harmony patches (~37 patch
   files under `UnboundLib/Patches/`; the ones touching CardChoice/CardChoiceVisuals/
   MainMenuHandler are the current suspects). Iterate until clean.
5. **Package**: `thunderstore.toml` → `SLO42/UnboundLib` (or chosen name), dep on
   `SLO42/BepInExPack_ROUNDS`. Publish = D-037 gated.

## Verification (CRITICAL — needs a human/operator step)
"Working" = install the built `UnboundLib.dll` + regenerated MMHOOK (+ `Octokit.dll`) into
`<ROUNDS>/BepInEx/plugins/` under our 5.4.23.5 pack, **launch ROUNDS via Steam**
(`steam://rungameid/1557740`), and read `BepInEx/LogOutput.log`:
- `Loading [Rounds Unbound <ver>]` + no `MissingMethod`/`Ambiguous` + **NRE count ≈ 0**
- ideally start a match and confirm a card/game-mode actually works.
**The autonomous code-write sessions CANNOT do this step** (they don't launch games / read
the live log). The build/code work is automatable; the in-game verification is a
human-in-the-loop step (operator or the orchestrating session launches + reads the log and
feeds the stack traces back for the next iteration).

## Environment the build sessions need
- `ROUNDS_DIR` = `E:\SteamLibrary\steamapps\common\ROUNDS` (already wired into the dev server).
- `dotnet` (present), `net472` targeting pack.
- MonoMod HookGen (from BepInEx core `MonoMod.RuntimeDetour.HookGen.exe` / the NuGet tool).
- Reference DLLs resolved from `ROUNDS_DIR\ROUNDS_Data\Managed\` (Assembly-CSharp, Photon*,
  UnityEngine*, TextMeshPro) — never committed (like the pack).

## Dependency chain (build order)
BepInExPack_ROUNDS 5.4.23.5 ✅ → **this (UnboundLib current)** → PickNCards (deps UnboundLib
only, no ModdingUtils — confirmed via its manifest/csproj).

## Anti-misframe checklist (for the project/PM)
- Deliverable is a LIBRARY fix/rebuild (UnboundLib.dll + MMHOOK), NOT a template/mod.
- Source of truth = Bknibb's fork (adapt, don't rewrite).
- The hard part is the in-game verify loop, which is human-in-the-loop — bake that into the
  task flow (build → operator-verify → feed stack traces → fix → repeat).

## Backlog / v2 enhancements (operator-approved, deferred)
- **TODO (v2, post-compat-testing): late-registration handling in UnboundLib's MODS menu.**
  Today a mod's MODS-options entry only appears if it calls `Unbound.RegisterMenu` BEFORE
  `ModOptions.CreateModOptions` builds the menu (modMenus must be populated at build time;
  there is NO rebuild on late registration). On BepInEx 5.4.23.5 + Unity 2022.3, Unity does
  NOT dispatch plugin `Start()` (Awake runs, Start never fires — see PickNCards `d2cbf7d`),
  so any mod registering in `Start()` is absent from MODS. Enhancement: when `RegisterMenu`
  is called AFTER the MODS menu already exists, build that mod's entry immediately (or
  rebuild the menu) so registration order/timing doesn't matter and mods need no Awake
  workaround. **Operator decision (2026-06-29): powerful, but defer to v2** — first test the
  current library + observe real mod compatibility before changing UnboundLib's menu logic.
  HOLD until then. (Per-mod Awake-registration is the current workaround; UnboundLib stays
  byte-identical to the no-regression port.)
