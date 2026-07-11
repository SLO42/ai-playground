# Atelier — Total Status

**The complete picture: everything Atelier is, everything worked on, and everything it will become.**

Date: 2026-07-11 · Code: branch `v2` @ `757f34b` (worktree `F:\code\ai-playground-v2`) · Docs: branch `v2-main`

---

## 1. What Atelier Is

Atelier is a **studio that takes a project across its whole lifecycle** — create → develop → maintain → release — by driving Claude Code sessions as its workforce. A dashboard is the operator's face; an orchestrator/heartbeat engine runs underneath; one SurrealDB datastore owns all product state.

**The vision (operator, authoritative):** support development of personal projects of any size. Automate construction, updates, and modifications from idea conception to final release — hundreds of hours of tasks, refinement, experiments, and learning. Sole developer and sole user: the platform exists to let one person produce many projects effectively. Long-term it replaces the CLI workflow entirely and maintains every future application the operator decides to make.

**The operating philosophy that emerged while building it:**
- **Alive, not idle** — Atelier and its projects must *feel* alive: active development, hire conversations, autonomous purposeful expansion. The keystone is the heartbeat loop (task done → commit → PM informed → next task + roadmap).
- **Honest, always** — no fabricated data, ever. Every page renders live state or an honest loading/empty/error/stale state (F-008). Estimates are labeled; absent is "—".
- **The operator keeps the keys** — publishing, real spend, and hiring are consent-gated (D-037, D-021, D-039). Autonomy is broad *inside* those gates.
- **Analytics first-class** — every agent/orchestrator event logs enough context to explain how and why a decision was made.
- **Learn from every failure** — a formal failure ledger (56 entries) with an escalation ladder: document → skill → hard rule → hook.

---

## 2. The Arc — how we got here

### v1 (the proving ground)
The original dashboard + "Claw" automation engine: 17 heartbeat modules, an agent pool, real-data pages (a 205-commit real-data campaign), PM agents with SQLite memory, OpenClaw gateway integration. It proved the concept and taught most of the early failure lessons — and its architecture accumulated enough debt that a clean rebuild won.

### v2 (the rebuild, current)
Rebuilt from a clean spine on branch `v2`: SvelteKit 2 + Svelte 5 runes, Tailwind v4, SurrealDB 2.x (81 inline migrations, head `m0080`), Claude Code driven by direct subprocess (OpenClaw dropped, D-012), local Ollama model (gpt-oss:20b) behind a provider seam.

**The build method is itself the product's thesis:** v2 is built *by* an agent factory — a workflow-per-wave system (`v2-wave.js`) where each feature gets an Opus builder → independent Definition-of-Done reviewer → bounded fix-loop → adversarial red-team → commit-on-green → push. Deferred red-team findings feed a structured ledger that chains hardening waves. A Fable 5 planning session (this one) authors specs and wave scripts; Opus agents do all building, research, and large-context reading. Model roles are an explicit operator policy.

### Milestones along the way
- **Heartbeat brought alive** — post-task loop wired (was dead in boot); PM informed on every completion.
- **Autonomous-to-v1 model** — Create-with-AI projects may drive hands-off to a published 1.0.0 under recorded consent + objective green checks, then auto-disarm.
- **GAME-VERIFY** — the platform can verify a built game mod by *running the game*: deploy → launch → poll the log for a ready signal → structured verdict → mandatory kill. Built because autonomous sessions can't launch games; this closed the loop.
- **Cognitive architecture (S0–S4)** — extraction → reranking seam → concepts → soul/identity with a maturity ladder and a `/brain` view.
- **Concierge (stages 1–3)** — an always-on brain-grounded advisor: event-triggered recommendations → live LLM turns on the *local* model ($0 idle) → gated skill discovery. PMs consult it autonomously over a non-steering peer bus.
- **The "spec everything" campaign (2026-07-08)** — 10 specs in one stretch, every claim scout-verified to file:line; coverage 15 → 27 FULL.
- **Hardening waves (this week)** — the specs' findings turned into 10 operator-released build waves; 5 landed, 1 running, 4 queued.

---

## 3. Anatomy — everything Atelier is made of

~40 backend subsystems under `src/lib/server/`, grouped:

**Engine (the machine):**
- `orchestrator` — work queue (claim/enqueue with deterministic-id dedup), boot drain, semaphore, reaper, post-task pipeline (commit → test → heartbeat).
- `sessions` / `runtime` / `claude-code` / `harness` — session lifecycle, per-session git worktree isolation with FF-or-preserve merge-back, the Claude Code subprocess backend, per-spawn tool budgets → `--max-turns`, session-keyed run registry.
- `db` — one SurrealDB; migrations inline in schema.ts with an idempotency toolkit; hard-bounded connects; least-privilege runtime user (new this week).
- `events` / `services` / `loops` — the SSE live stream every page reacts to; background services; maintenance/autonomy loops.

**Cognition (the mind):**
- `memory` — append-only knowledge tables, deduplication downstream, 1024-dim embeddings, curator.
- `scene` — the living memory scene (pan/zoom graph of what Atelier knows).
- `concierge` / `atelier` — the apex advisor + the self-hosting seam (D-040).
- `peer` — the conversation layer; cross-project wall (D-041): projects never talk directly; Atelier is the sole broker; agent messages are data, only the operator steers (D-035a).

**Workforce (the people):**
- `workforce` — roles, hires, the HR recruiter certification ceremony (gauntlet → adjudication → hire brief), per-hire souls.
- `agent` / `cc-config` — the agent library and the capability catalog: every spawn's capabilities allow-listed from a synced catalog, unknown ids fail closed (D-036).
- `projects` — the data plane: projects, sprints, tasks, PM briefs, decision handling.

**Lifecycle (the product):**
- `create` — Create-with-AI: prompt → project + PM + founding tasks.
- `release` — adapter framework (Thunderstore live-capable, `verify()` on contract); adapters are code contributions, never runtime-loadable.
- `analytics` — cost metering at the event chokepoint, token budgets, provider usage; the "first-class" mandate.
- `providers` / `routing` — cloud/local model seam (Ollama gpt-oss:20b), routing ladder, model-role policy.
- `scanner` / `sync` / `importer` — bring existing repos in; GitHub round-trips.

**Perimeter (the walls):** loopback-only listeners + per-boot token + anti-CSRF (D-025); untrusted content is data, secrets screened (D-026); origin stamped server-side and immutable (D-035a); security gates fail closed — and *only* security gates (D-024); guardrails seeded per project worktree (permissions.deny wired this week).

**Governance (the memory of judgment):**
- `docs/DECISIONS.md` — 42 locked decisions (D-000..D-041), the constitution.
- `docs/fails.md` — 56 named failures (F-001..F-056), each a mistake → rule; recurring ones escalate to skills → CLAUDE.md hard rules → hooks.
- Definition of Done (D-038) — six checks; "build green" is necessary, never sufficient; every wave ends with a live-verify.
- ~30 specs in `docs/` — coverage tracked in SPEC-COVERAGE.md: **27 FULL / 11 PARTIAL / 1 NONE** (perf, trivial). Devlog per session in `docs/devlog/`.

---

## 4. Everything worked on — the projects Atelier serves

| Project | State |
|---|---|
| **SWIP** (ROUNDS card mod) | The original guinea pig; card catalog + release automation; staged publish parked. |
| **ROUNDS BepInExPack port** | Done — private repo, BepInEx 5.4.23.5 for the current game build. |
| **UnboundLib MP port** | Done — operator's fork fixed for build 21020021; full 2-player modded session verified. Not pushed/published. |
| **CardDrawControl 1.0.0** | Built + multiplayer-verified combined card mod (supersedes PickNCards). Thunderstore publish awaits operator (D-037). |
| **new-mod-test** | *The graduation test, not yet run*: a fresh Create-with-AI mod, hands-off to the platform's **first real publish**. |
| BG3 / Minecraft / others | Registered as managed projects; dormant pending the pipeline's graduation. |
| **Atelier itself** | The ultimate project — self-hosting seam (`atelier_self`) reserved, D-040. |

---

## 5. Where it stands right now (2026-07-11)

**This week = systematic hardening.** The spec campaign found real floor gaps; operator released all fix waves.

| Wave | Status | What it fixed |
|---|---|---|
| security-floor | ✅ | Dev DB ran as **root** → least-priv user defined + confinement tested; Host-header loopback fix |
| db-runtime-hardening | ✅ | Opt-in auth level, byte-identical default |
| orchestrator-hardening | ✅ | Boot re-drain hole (ready tasks stranded at boot) + reap-before-subscribe ordering |
| cc-harness-hardening | ✅ | D-024 guardrail boundary had **no production caller** → wired at registration + boot; session-keyed runs; spawn budgets |
| cost-governance-1a | ✅ | `cost_usd` was **null everywhere** → pricing + metering at the chokepoint; global rolling-24h token budget + operator override |
| **cost-governance-1b** | 🔄 running | Budget-gate race fix, local-$0 concierge exemption, per-project budgets + cost attribution, cost-labeled consent estimates |
| cc-config / projects / adapter-framework / periphery / security-floor-2 | queued | Auto-chain on green (stale-catalog spawn hole, decision-brief handling, scanner lock, sync dryRun, services scheduler, auth-regex + atomic guardrail writes) |

The running wave survived two host-process crashes with zero work lost — the crash-recovery procedure (F-051) held both times, which is itself evidence the factory is robust.

---

## 6. Everything Atelier will be — the road ahead

**Near (days):**
1. Finish the wave chain (4 queued waves auto-chain on green).
2. **`new-mod-test`** — the operator-triggered graduation: fresh Create-with-AI ROUNDS mod → hands-off lifecycle → **first real Thunderstore publish**. This is the moment "built" becomes "works."
3. ANALYTICS-SPEC — the last substantive unspecced subsystem.
4. The local-vs-cloud brain benchmark run (harness ready; needs a cloud key).

**Mid (the self-improving studio):**
5. **Self-hosting (D-040)** — Atelier ingests its own docs, hires its own PM, and maintains itself as one of its projects.
6. **Concierge as apex** — the always-on local brain graduates from event-triggered to persistent if the benchmark supports it; its recommendations wire into real skill acquisition (find-skills, gated) and real hire drafting through HR.
7. **Loops as first-class UI** — visible, inspectable, configurable autonomy loops per project, with a readiness gate.
8. Full command-center project page — one screen: visual status, live PM/HR/agent thinking, controls, honest failure reasons.

**Long (the vision fulfilled):**
9. Template library growth + creating templates from the dashboard; import any non-template project with full feature parity.
10. Many projects running concurrently under one studio — game mods, apps, whatever the operator conceives — each with its PM, workforce, loops, and releases.
11. **Replace the CLI.** Atelier becomes how the operator builds software: idea in, maintained released product out, with human judgment only at the gates that matter.

---

## 7. The honest ledger

**Proven:** the engine (heartbeat, worktrees, queue, recovery), the cognition (brain + concierge live on a $0 local model), the workforce ceremony, GAME-VERIFY, a real mod built and multiplayer-verified end-to-end, and a build factory that survives its own crashes.

**Hardened this week:** database privilege, orchestrator boot recovery, the guardrail boundary, cost visibility and budgets — all found by specs, fixed by waves, each with adversarial review.

**Unproven:** a real publish. Zero releases have shipped through the platform. Everything converges on `new-mod-test`.

**Standing risks:** single-process deployment assumptions (documented, ORH-5), the analytics subsystem outgrowing its spec, and the perpetual one: autonomy is only as trustworthy as its gates — which is why every gate change gets a premise audit (F-055).

---

*Sources: CLAUDE.md (operating manual) · docs/DECISIONS.md (D-000..D-041) · docs/fails.md (F-001..F-056) · docs/SPEC-COVERAGE.md · docs/BUILD-QUEUE.md · docs/devlog/ · session memory.*
