# GAME-VERIFY — live game-mod verification capability (spec, 2026-06-26)

> The platform capability that lets Atelier **verify a built mod by running the game**:
> launch the target game (mod deployed), wait for a readiness signal in its log, capture
> a structured verdict (loaded? errors? stack traces?), kill the game, feed the result back
> into the build loop. This closes the loop the autonomous code-write sessions CANNOT close
> alone (they don't launch games / read live logs) — the bottleneck found while building the
> ROUNDS BepInExPack + UnboundLib. **Prerequisite for hands-off game-mod projects**
> (UnboundLib, PickNCards, and every future mod). See [[project_rounds-hands-off-to-working]],
> `docs/UNBOUNDLIB-ROUNDS-SPEC.md`.

## Proven mechanism (grounded — done live ~6× this session)
The exact recipe, validated repeatedly against ROUNDS this session:
```
deploy:  copy built artifact -> <game>/BepInEx/plugins/<id>/
launch:  Start-Process "steam://rungameid/1557740"        # or an exe + args
wait:    poll <game>/BepInEx/LogOutput.log until /Chainloader startup complete/  (bounded)
read:    grep the log -> mod-load line, error count, NRE count, MissingMethod/Ambiguous,
         + the first N stack-trace blocks after each error class
kill:    Stop-Process ROUNDS.exe   (ALWAYS — even on timeout)
verdict: { ready, loaded, errorCount, byPattern:{...}, newStackTraces:[...], logTail }
```
Evidence it works + discriminates: under 5.4.19 vs 5.4.23.5 packs, and under
broken-UnboundLib vs Bknibb-fixed, this recipe produced clean, comparable verdicts
(`GM_ArmsRace.Start MissingMethod: 0/1`, `NRE: 0/2953/5000`, `startup complete`, `SignIn`).

## Capability shape

### 1. Per-project verify config (new project-level block — opt-in, operator-set)
A project declares a `game_verify` harness (absent ⇒ capability disabled; like `test_command`):
- `launch_command` — `steam://rungameid/<appid>` OR `{ exe, args }`.
- `process_name` — for the mandatory kill (e.g. `ROUNDS.exe`).
- `deploy` — `[ { source: <built-artifact-glob>, target: <abs path under the game> } ]`
  (e.g. `BepInEx/plugins/<modid>/`). Deploy is the ONLY write outside the project root,
  to explicitly-configured paths.
- `log_path` — abs path to the log to read (`<game>/BepInEx/LogOutput.log`).
- `ready_pattern` — regex signalling load finished (`Chainloader startup complete`).
- `success_patterns` / `error_patterns` — regexes for the verdict
  (load line; `MissingMethod|AmbiguousMatch|Exception|NullReference`).
- `timeout_ms` — wall-clock cap (game boot can be 30–60s; default ~120s).
- optional `pre_launch` / `post_kill` (cleanup), `stack_capture_lines` (N after each error).

### 2. Verify flow (the runner)
Mirror the existing exec-runner discipline (`post-task.ts` execFileRunner / `test_command`):
1. Deploy built artifact(s) to the configured target path(s).
2. Launch the game (detached); record the PID/process name.
3. Poll `log_path` until `ready_pattern` matches OR `timeout_ms` (no spin; bounded backoff).
   The log is typically OVERWRITTEN per boot (BepInEx) — a fresh boot ⇒ a fresh log.
4. Capture: counts per success/error pattern + the first `stack_capture_lines` after each
   error class. SCREEN the captured lines (D-026) before surfacing (game logs hold
   usernames/paths).
5. **KILL the process unconditionally** (success, fail, OR timeout) — no orphan game
   process EVER (F-014; I leaked node dev-servers earlier this session — same discipline).
6. Return the structured verdict.

### 3. Verdict (honest states — F-008)
`{ outcome: 'pass' | 'errors' | 'not_ready' | 'crashed' | 'timeout', ready: bool,
   loaded: bool, errorCount, byPattern: { <name>: count }, stackTraces: [...], logTail }`
- `not_ready`/`timeout` = game never hit `ready_pattern` (don't fabricate a pass).
- `crashed` = process died before ready.
- `errors` = loaded but error/NRE patterns matched (the UnboundLib case).
- `pass` = ready + load line + zero error-pattern matches.

## Orchestrator integration
- A **`game_verify` step** in the task lifecycle — runs AFTER the build/test gate, BEFORE
  marking a mod task done (analogous to how `post-task` runs `test_command`). A non-pass
  verdict is NOT a hard fail: it's fed back as the next iteration's input (the stack traces
  the code-write session needs to fix the next break) — the human-in-the-loop, automated.
- Runs on the dev HOST (where the game + Steam live) — host-side, like the dev server.
- Surfaced in the project command-center: the verdict + screened log tail (operator visibility).
- Serialize: ONE game-verify at a time per game (never launch concurrently).

## Security / containment rails
- **Opt-in, operator-configured** per project — no `game_verify` block ⇒ no game launch.
  This is an EXEC capability (launches a real process) — treat like `test_command` +
  D-037-class deliberateness: the operator sets the launch command + paths; the agent never
  invents them.
- **Bounded + mandatory kill** (F-014): wall-clock timeout; process ALWAYS killed; no orphans.
- **Deploy + log paths are explicit + operator-set** — they point OUTSIDE the project root
  (the game install). D-018 confineToRoot governs the agent's edit scope; this harness is a
  separate, configured verify surface with named paths, not arbitrary FS access.
- **Read-only log**; **screen captured lines** (D-026) before surfacing/feeding back.
- **No secrets** flow through; the launch carries no credentials (Steam handles game auth).

## Generalization
NOT ROUNDS-specific. Any game-mod project (Steam or standalone exe; BepInEx or other loader)
configures its own launch/log/patterns. ROUNDS is the **reference config** (below). The
capability is generic: deploy → launch → poll-log → capture → kill → verdict.

## ROUNDS reference config (all values proven this session)
```
launch_command = "steam://rungameid/1557740"
process_name   = "ROUNDS.exe"
log_path       = "E:\\SteamLibrary\\steamapps\\common\\ROUNDS\\BepInEx\\LogOutput.log"
deploy         = [{ source: "**/bin/**/UnboundLib.dll" + MMHOOK + Octokit,
                    target: "E:\\...\\ROUNDS\\BepInEx\\plugins\\<modid>\\" }]
ready_pattern  = "Chainloader startup complete"
success_pattern= "Loading \\[Rounds Unbound|loaded\\."
error_patterns = ["MissingMethodException","AmbiguousMatch","NullReferenceException","Fatal"]
timeout_ms     = 120000
```

## Build tasks (grounded; verify integration points before coding — no-guessing)
1. **Schema**: add the `game_verify` config block to the project table (additive,
   idempotent migration — F-015). Confirm the project schema + normalizer pattern first.
2. **Runner** (`game-verify.ts`): deploy → launch → bounded poll → capture+screen → kill →
   verdict. Reuse the execFile/runner + screen/fence helpers (find them; don't reinvent).
3. **Orchestrator step**: wire `game_verify` after the build/test gate for projects that
   declare it; feed a non-pass verdict back into the task's next iteration. Confirm the
   post-task / verify-gate seam (`post-task.ts`).
4. **Command-center surface**: show the verdict + screened log tail.
5. **Tests**: a fake-game harness (a scripted process that writes a canned log) to exercise
   pass/errors/timeout/crashed deterministically — NEVER launch a real game in the test
   suite (F-010/F-014 discipline). Assert the kill-after on every path (no orphan).

## Anti-misframe note
This is an INFRASTRUCTURE capability (a verify runner + config + orchestrator step), NOT a
mod and NOT game-specific code. The deliverable is the generic game-verify harness; ROUNDS
is just its first config. (Guard against the Create-with-AI misframe class.)
