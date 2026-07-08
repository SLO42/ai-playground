# CLAUDE-CODE-HARNESS-SPEC — spawn · isolated config · session control · the two-layer gate

**Status:** DRAFT (2026-07-08) · implements D-002/D-011/D-024/D-025/D-026/D-035a/D-036 · carries F-001/F-002/F-007/F-008/F-014/F-029/F-045/F-046/F-053 · queued `cc-harness-hardening` (gate:operator)
**One-liner:** the runtime that drives every Claude Code session — isolated session-keyed config, direct .exe spawn, origin-stamped interject, per-session worktrees, capability fail-closed composition, and the two-layer gate — is BUILT and densely tested. What was never written down is the security contract that holds it together. This spec states it, and scopes a small hardening wave: the in-memory run registry still keys by SLOT (the F-046 class, one layer up), the guardrails-writer's production caller is unverified, and tool budgets never reach `--max-turns`.

Grounding: opus scout pass 2026-07-08 over `src/lib/server/{runtime,claude-code,harness,sessions}/` + `config/agent-pool.yaml` (file:line verified). Code on branch `v2`, worktree `F:\code\ai-playground-v2`.

## 0. Scope & boundary

- **In scope:** `runtime/index.ts` (contract + `isolatedConfigFor` + `ClaudeCodeRuntime`), `runtime/capabilities.ts` (D-036 composer), `claude-code/` (cli-backend, gates, guardrails, gate-transport, channel, ollama-backend, slots), `harness/` (wiring, hooks-wiring), `sessions/` (launch, worktree, merge-back, messages), `config/agent-pool.yaml`.
- **Out of scope:** routing/intent classification (routing); the orchestrator drain that calls `launchSession` (ORCHESTRATOR-SPEC); cc-config catalog sync (CC-CONFIG-SPEC, forthcoming); memory recall content (MEMORY-SPEC).

## 1. What's already BUILT (the substrate)

### 1.1 The contract (`runtime/index.ts`)
`AgentRuntime` (:205) is the narrow seam everything codes against: `SpawnRequest` (:98), `RuntimeEvent` union (:181 — log/thinking/tool_call/tool_result/token_usage/done/error), `CcBackend` (:437) with `capabilities()` honesty flags. `ClaudeCodeRuntime` (:520): `plan()` (:547) → `spawn()` (:614) → `consume()` (:600); `resume()` (:650), `interject()` (:674), `cancel()` (:698), `failClosed()` (:710).

### 1.2 Isolated config (D-002/F-046) — `isolatedConfigFor` (:310)
- **Session-keyed dir (VERIFIED :315–322):** `${root}/${safeSegment(req.sessionId ?? req.agentId)}` — sessionId primary; slot fallback only for legacy no-sessionId spawns. Resume reuses the same sessionId → CLI transcript reuse intact.
- `env`: `CLAUDE_CONFIG_DIR` pinned; `ATELIER_SESSION_ID` iff sessionId (:331). Settings: catalog present → `composeCapabilities`; else legacy harness bundle. **`plugins`/`marketplaces` ALWAYS empty** (capabilities.ts:238–239, index.ts:355) — the S1 determinism guard.
- `HARNESS_ONLY_SETTINGS_KEYS` (cli-backend.ts:67) stripped from the `--settings` file (emitting plugins even empty silently disables the file's hooks); `mcpServers` delivered via `--mcp-config <.mcp.json> --strict-mcp-config` (:163) — strict = ignores operator/project MCP sources.
- `seedHookTrust` (cli-backend.ts:174): pre-accepts hook trust for THIS session's cwd only; synthetic identity only-if-absent (never the operator's); best-effort (hooks are analytics, never a gate).
- Sterile interview rail: `sessionKind==='interview'` forces sterile; any MEMORY_PULL id → `SterileCompositionError` (capabilities.ts:221–227). Note: the reserved-id set must be extended if a future pull-tool lands under new ids (:80–82).

### 1.3 Spawn (`launchSession` sessions/launch.ts:450 → `ClaudeCliBackend.start` cli-backend.ts:482)
Order: project root → prompt (task) → editScope merge with `config/gates.yaml` (**missing/malformed gates.yaml fails the launch closed** :485–490) → session row 'running' (:532) → WRITE intent ⇒ `acquireSessionWorktree` (:554–597, failure fails closed with screened note + row 'failed') → peer drain (seq −2) + briefing (seq −1) → `runtime.spawn` (:861).
- **Env:** `CLAUDE_CODE_OAUTH_TOKEN` rides env only (cli-backend.ts:555), never logged/persisted. F-029: gates run token-UNSET; non-zero exits surface the stdout tail (:701–709).
- **Windows:** `claude` spawned DIRECTLY, `shell:false` (:558–564) — the deliberate exception to the shell:true daemon rule (that rule is for detached daemons; Node escapes args here, settings ride a temp FILE). Kill = `treeKillChild` → `taskkill /F /T` (F-001); `liveChildren` swept at teardown (:240); `child.once('error')` captures spawn ENOENT as an honest error event instead of killing the server (:575).

### 1.4 Session lifecycle & control (`channel.ts` — D-011/D-025/D-035a)
- `session` table (schema.ts:121–155 + later migrations): status ASSERT [running,done,failed,cancelled], `cc_session_id` (:135) = resume/interject handle (written from the CLI's done event, launch.ts:1096), worktree cols (m0059), granted_* capability stamps, `dedup_key VALUE (cc_session_id OR id)` (:152).
- **Origin stamping (THE invariant):** `resolveOrigin` (channel.ts:207) — `origin='operator', steer=true` IFF `viaControlEndpoint===true` AND `tokenMatches` (constant-time, :190); everything else fail-closed `agent`/non-steering/`fence()`d as DATA (:318–322). The boot token lives ONLY in the channel closure (:277) — the runtime is NEVER handed it. Origin persisted immutable on the message row (:361).
- Interject: fail-closed prechecks (capabilities + cc_session_id) BEFORE any write; CLI delivery via stream-json stdin with bounded ack (10s) — resolves only on real replay ack, else honest throw (cli-backend.ts:418–427, F-008).
- Resume (:417): prechecks incl. root_path-on-disk (:449); WRITE resume re-acquires the SAME worktree (idempotent); transcript continues at MAX(seq)+1 (m0037); reconciles a forked cc_session_id (:598–608). Stop (:386): cancel → 'cancelled' + agent_event. Fleet (:620) = projection over running rows (no daemon, no pid-liveness — D-035 anti-rules).
- **Terminal-status guarantee (TASK 13.2, launch.ts:1044–1135):** every exit path lands a terminal status + honest screened `note` (precedence streamError→lastErrorEvent→done(ok=false)→"failed before producing any output"); boot reaper backstops pre-boot 'running' rows.
- Transcript: every event through `eventToMessage` (:402) — the single D-026 screen chokepoint; persistence fail-open (F-014, :911); one bus, topic=sessionId (§2.11), no polling.

### 1.5 Worktree isolation (WI-1..3; `worktree.ts` / `merge-back.ts`)
- `acquireSessionWorktree` (:278): non-git root → `NotAGitRepoError` fail-closed (never falls back to the shared root); branch `atelier/session/<seg>`; tree at sibling `.atelier-worktrees/` (outside project globs); idempotent re-acquire (:310); F-007 orphan handling — empty→rm, NON-EMPTY→rename `.orphaned-<seg>` never blind rm (:317–335); `didCreate` guard so failure cleanup never removes a concurrent winner's tree (:305/:369); `assertLocalGit` forbids push/remote/fetch/pull/--force (:108).
- `mergeBackWorktree` (:261): non-done exits PRESERVE branch+tree with honest note; clean done under per-root `withMergeLock` (:125) → `git merge --ff-only` — abort → preserved-conflict distinguishing DIVERGED vs DIRTY-TREE (:342–353); branch delete `-d` only (`-D` forbidden :98). Composition: post-task commits IN the worktree (session branch) THEN merge-back (boot.ts:399–425).

### 1.6 The two-layer gate (D-024)
1. **PRIMARY — `permissions.deny`** (guardrails.ts `buildGuardrailSettings`:104, written to the PROJECT `.claude/settings.json` via `writeProjectGuardrails`): CONFIG_PROTECTION_DENY (.env*/.pem/.key/.claude/**/.mcp.json across the code root) ∪ DANGEROUS_BASH_DENY (rm -rf/git push/git remote/--force/reset --hard) + `additionalDirectories` confinement + `disableBypassPermissionsMode:'disable'`. Locally enforced by Claude Code — holds with the server DOWN.
2. **DEFENSE-IN-DEPTH — the gate layer** (gates.ts): one pure `evaluateGate` (:817, any throw → DENY :820–827) consulted by BOTH paths — SDK `canUseTool` (plan-time; malformed gate/scope config THROWS in plan() so the spawn fails closed) and CLI `PreToolUse` hook → `scripts/gate-hook.mjs` → `/api/gates/pretooluse` (D-025 auth; unreachable/unauthorized → deny). Six families; all but read-before-edit are SAFETY_CRITICAL and never downgrade to warn (:800).
- **Capability fail-closed (F-045/D-036):** `validateDimension` (capabilities.ts:179) throws on the FIRST unknown catalog id → error RuntimeEvent, backend never reached. Reserved `peer-send` is the ONLY catalog-bypass, granted on WRITE intents only at the wiring seam (wiring.ts:286/:306).

### 1.7 Provider seam (F-053) & slots
- `OllamaBackend` (ollama-backend.ts:48): Stage-1 single-turn, `supportsInterject/Resume=false`, honest throws — the exact capability delta the benchmark measures. **Opt-in branch VERIFIED byte-identical when unwired** (index.ts:630–631); production wires it (wiring.ts:135/:181); `ollama-branch.test.ts` locks the fall-through.
- Slots (`slots.ts`): a config/stat MIRROR of agent-pool.yaml, NOT allocation — `busy` is a non-authoritative snapshot (:6–8); slot id = `SpawnRequest.agentId` = `session.agent` label. Tiers local/haiku/sonnet/opus; escalation ladder local→haiku→sonnet→opus.
- `getRuntime` (wiring.ts:111): cached per-process singleton (catalog re-sync applies next boot — documented :108); `maxTurns:80` (:128) — the CLI default of 1 is fatal for agentic runs.

## 2. Normative invariants

1. **Every spawn gets an ISOLATED config keyed by SESSION id** — never slot (F-046); `plugins`/`marketplaces` always empty (D-002); operator config never inherited.
2. **Two tokens, two fates:** the OAuth token rides env only, never logged/persisted; the D-025 control token is compared constant-time inside the channel seam ONLY and is never handed to the runtime (agent holding it == agent is operator).
3. **`origin` is server-stamped, immutable, content-independent** — operator IFF control endpoint + valid token; all else fail-closed agent/non-steering/fenced (D-035a/D-026).
4. **Two gate layers, both fail-closed:** local `permissions.deny` is the PRIMARY boundary (server-down-safe); the gate layer is defense-in-depth on BOTH the SDK and CLI paths; safety-critical families never downgrade; evaluator throw = DENY; malformed config fails the spawn at plan().
5. **Unknown capability id fails the spawn closed** (never silently dropped); reserved peer-send is the sole bypass, WRITE intents only.
6. **WRITE sessions run in a dedicated per-session worktree; non-git fails closed.** Committed work is never lost: FF-only merge on clean done, preserve-with-honest-note otherwise; never --force/--no-ff/-D; per-root merge lock.
7. **Every session reaches a terminal status with an honest screened note on every exit path** (reaper backstop included); no phantom running, no null-note failure.
8. **Honest capability matrix (F-008):** backends declare supportsInterject/supportsResume; controls refuse up front rather than stub success; interject resolves only on real ack.
9. **Provider branches are additive/opt-in** (F-053): engage only when wired, else byte-identical fall-through. A local backend gaining a tool loop MUST extend the gate wiring first (today: no tools ⇒ no gate need).
10. **Windows discipline:** direct .exe spawn shell:false with arg arrays; taskkill tree for liveness/kill; spawn-error listener prevents server death; transcript writes fail-open (F-014); D-016 param binding + D-026 screening at the eventToMessage chokepoint.

## 3. Config surface

`config/agent-pool.yaml` — tiers {local:ollama/gpt-oss:20b, haiku, sonnet, opus:claude-opus-4-8}, slots (opus-1/sonnet-1/haiku-1/local-1), escalation order. `config/gates.yaml` — destructiveBash merge (missing ⇒ launch fails closed). `config/orchestration.yaml bundles.<intent>.capabilities` — catalog-validated (F-045: only declare ids present in a SYNCED scope). Env: `CLAUDE_CODE_OAUTH_TOKEN` (claude health), `OLLAMA_HOST`, `HOOK_TOKEN` (boot token).

## 4. Events / analytics

All through `writeAgentEvent` (the one chokepoint): `spawn` (intent+reason+parentEventId → m0067 lifecycle graph), `error` (per error event, stream throw, worktree fail, reaped), `completion` (tokens/duration/summary), `cancel` (by/reason). Live render via the ONE bus (transcript/token_usage/interject/session_status), topic=sessionId.

## 5. Gaps → the hardening wave (`cc-harness-hardening`, gate:operator)

| id | gap (verified) | required behavior | shape |
|---|---|---|---|
| **CCH-1** | **In-memory run registry keyed by SLOT.** `ClaudeCodeRuntime.running` Map keys on `agentId` (index.ts:532; `cancel` :698); channel.stop passes agentId (channel.ts:108). Two concurrent same-slot sessions (manual launches all default 'opus-1', wiring.ts:325) collide — second overwrites the handle; cancel reaches only the latest. Same F-046 class as the config-dir bug, one layer up. | Key the registry by `sessionId ?? agentId` (mirror the config-dir fix); thread sessionId through cancel/stop; legacy fallback byte-identical. Real test: two concurrent mock runs on one slot, cancel each independently. | build (red-team; the mirror of the F-046 fix) |
| **CCH-2** | **`writeProjectGuardrails` production caller NOT FOUND in scouted scope** (guardrails.ts:1 says "before ANY agent can spawn"). If nothing invokes it on project registration/boot, the PRIMARY D-024 boundary may be absent on new projects. | VERIFY first (Iron Law — instrument, don't assume): find the caller across routes/boot/create; if absent, wire it at project registration + boot reconcile, idempotent, diff-and-confirm on hand-edited files (D-010). | verify → build if confirmed |
| **CCH-3** | `SpawnBudgets.toolCalls` (index.ts:81) never maps to the CLI — fixed `maxTurns:80` for all driven sessions (wiring.ts:128). | Thread `budgets.toolCalls` → `--max-turns` when declared; default stays 80. D-020 adaptive budgets become real at the CLI boundary. | build (small) |
| **CCH-4** | Server-down residual: edit-scope + fetch-allowlist exist ONLY in the gate layer — not expressible in local `permissions.deny`. With the server down, those two families are unenforced (config-protection/dangerous-bash/path-confinement ARE in the local deny). | Documented constraint (D-024 fine-print): the local deny is the primary boundary for its three families; edit-scope/fetch-allowlist are defense-in-depth only. CLI-path hook transport already fails closed when the endpoint is unreachable — which covers the running-server-crashed case; the residual is a session spawned while the server is down (impossible today: the server does the spawning). State it; no build. | documented |
| **CCH-5** | Catalog cached per-process (wiring.ts:112); interview sterile reserved-set future-id note (capabilities.ts:80–82). | Documented constraints; re-assert in CC-CONFIG-SPEC. | documented |

## 6. Test coverage map

Live/real-path: cli-backend.live/proto/kill, gate-live, edit-scope-live, gate-hook-roundtrip, capability-wiring.live, launch.live, memory-loop.live. Unit: channel (981 ln), gates, edit-scope, guardrails, gate-transport, runtime contract (mock backend by design), gate-wiring, ollama-branch (F-053 fall-through), capabilities, slots, launch (1204 ln), worktree, merge-back, fast-tier-enqueue. **New tests required:** CCH-1 concurrent same-slot cancel independence; CCH-2 guardrails-written-on-registration (if build confirmed); CCH-3 budget→max-turns mapping.

## 7. DoD (D-038) for the hardening wave

- [ ] CCH-1 lands with the concurrent-cancel test; no behavior change for legacy no-sessionId spawns; red-team pass (control-plane surface).
- [ ] CCH-2 verdict recorded (caller found ⇒ cite + close; absent ⇒ wired + idempotency test + D-010 diff-confirm honored).
- [ ] CCH-3 mapping covered by a plan()-level unit test; default unchanged.
- [ ] No migration; gates green token-unset (F-029); one builder per worktree (F-052); devlog row.
