# Loop Engineering — the Atelier operating discipline (2026-06-29)

> Adapted from Addy Osmani / Boris Cherny's **loop engineering**
> (`github.com/cobusgreyling/loop-engineering`). We take the *rubric* — vocabulary,
> the L1→L2→L3 maturity ladder, the Loop Design Checklist, the failure-mode catalog —
> NOT their npm CLIs (loop-audit/init/cost are GitHub-issue-triage flavored; Atelier
> has richer equivalents). This is the process Atelier follows when it runs work
> autonomously. See [[project_loop-engineering-adoption]].

## The thesis
**Stop being the person who prompts the agent — design the system that does it.**
A *loop* is a recursive goal: define a purpose, the system iterates (sub-agents,
verification, external state) until done or it hands off to a human. The leverage
moved from crafting prompts → designing the control systems that orchestrate agents
over time. Atelier already *is* such a system; this doc names the discipline so we
operate it deliberately instead of ad-hoc.

## The 6 primitives → what Atelier already has
| Primitive | Atelier artifact |
|---|---|
| Automations / Scheduling | heartbeat loop · orchestrator drain (event + periodic) · PM cadence `*/10` · gcStale backstop |
| Worktrees | per-session git-worktree isolation (WI-1/2/3, `acquireSessionWorktree`) |
| Skills | `.claude/skills/*` · CLAUDE.md · `docs/fails.md` (pays down "intent debt") |
| Plugins / Connectors (MCP) | OpenClaw gateway · MCP servers |
| Sub-agents (maker / checker) | **v2-wave**: BUILD → D-038 review → A4 red-team (separate agents; maker never grades itself) |
| **Memory / State** | auto-memory · `fails.md` · SurrealDB `work_item`/`project`/`agent_event` |

The gap loop-engineering fills isn't capability — it's **deliberate operation**:
declaring each loop, grading its readiness, and making loops *visible + configurable*.

## The maturity ladder (the autonomy model, sharpened)
Never run a loop at a higher level than its quality has earned. Maps onto and
refines [[project_autonomous-to-v1]] (which is currently binary gated-vs-hands-off).

- **L1 — report-only.** Loop discovers + triages + writes state; a human decides
  actions. (e.g. a PM that proposes but doesn't act.)
- **L2 — assisted.** Loop acts on small, verified wins via a **human-gated** path
  (PR / operator confirm). Maker≠checker enforced. (e.g. armed PM with D-039 hire
  gate + "no publish" D-037.)
- **L3 — auto-act.** Loop acts unattended on an **allowlist only**; denylist paths
  (publish, secrets, hire, infra) always escalate. (e.g. autonomous-to-v1 drive,
  within its double spend cap.)

Rule: **prove L1 quality before enabling L2; prove L2 before L3.** Promotion is an
operator decision, recorded.

## The Loop Design Checklist — Atelier's pre-arm gate
A project/loop may not go autonomous until its loop passes this. We already satisfy
most of it informally; the discipline is to *check it off* before arming.
- [ ] **Single goal** + explicit non-goals + watched scope
- [ ] **Cadence** chosen; durable across restart; off-hours behavior
- [ ] **Maker ≠ checker** — implementer cannot mark its own work done (v2-wave does this)
- [ ] **Attempt cap** → escalate with full context (no infinite fix loop; `maxFixAttempts`)
- [ ] **State** read at start of every run; **prune** resolved items; outcomes written
- [ ] **Handoff triggers** explicit (max attempts, risk paths, ambiguity)
- [ ] **Denylist paths** enforced (D-037 publish · D-039 hire · secrets · D-018 root)
- [ ] **Kill switch** + token budget (re-tick cap + D-021 200/day)
- [ ] **Run log** — history of what the loop did, when, why

## Failure-mode catalog ≈ our fails.md
loop-engineering's catalog is the same bugs we hit independently. Cross-reference so a
recurrence is recognized as a *known loop failure mode*, not a fresh mystery:
| loop-engineering failure mode | our evidence |
|---|---|
| Parallel Collision / No kill switch | **F-014** (orphan dev-server storm) · **F-046** (same-slot config corruption) |
| Escalation Failure (machine flag in prose) | **F-019** (stop-regex false-positive) |
| Token Burn / pipeline retry on transient | **F-048** (uncaught drain crash) |
| State Rot (acting on ghosts) | reaper/`releaseSessionWork` · prune rules |
| Verifier Theater (rubber-stamp) | D-038 DoD review + red-team second pass |
| Over-Reach (wrong scope) | scope-lock in CLAUDE.md · editScope/D-018 |
| Denylist / human gate | D-037 ("no publish") · D-039 (no auto-hire) |
| Comprehension-debt / weekly digest | digest-after-every-autonomous-stretch |

## Loops are first-class in Atelier (operator directive 2026-06-29)
Each loop gets **visuals + a stable identifier** and is **reviewable, modifiable,
configurable in-app** — not just a config file:
- **Identifier**: name · icon · phase badge (L1/L2/L3) · live status (running·idle·paused·escalated).
- **Visual**: a loop card + the cycle motif (discover → triage → make → check → state →),
  showing where the loop is now, last-run, health (readiness/failure-mode flags), token spend.
- **Review**: run history, handoffs/escalations, what it touched.
- **Configure in-UI**: cadence · phase (promote L1→L2→L3) · gates · kill switch —
  persisted to the loop manifest. Lives in the command-center (the "one place").
- Honest states (F-008): surface only loops that **actually run** — no fabricated cards.
  Start with view+identify+basic config; expand iteratively.

## Build order
1. **GAME-VERIFY** — DONE (a new primitive: the verifier for game-mod loops).
2. **Vocabulary** — this doc (adopt names + ladder; cross-ref fails.md). ← here
3. **Loop manifest** — declarative per-loop definition (id·name·cadence·phase·maker/checker·
   state·gate·handoff·kill-switch), the source of truth; grounded in the loops Atelier
   really runs.
4. **Loops UI surface** — visuals/identifiers/review/configure in the command-center (directive above).
5. **Readiness gate** — a loop arms for autonomy only after the Design Checklist passes.
