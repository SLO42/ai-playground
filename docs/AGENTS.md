# AGENTS — ai-playground v2

Authoring conventions for the **agents and skills** v2 manages and runs. How to *write* them — not how the harness executes them. Planning-level: a guide someone could author v2's agent definitions and skills from.

> **Provenance.** Each convention is a **candidate** harvested from studied skills, carrying its source — *(kongcode)* (a friend's plugin: ideas/conventions are fine to adopt; lifting his *code* needs consent — everything here is an authoring convention, safe) or *(hermes)* (Nous Research, **MIT** — liftable). Adapt, don't follow blindly; verify against v2's constraints before locking. Source: `docs/CANNIBALIZE-BRIEF.md` §5.

---

## 1. Purpose

v2 is a **Claude Code harness** (D-002): Claude Code is the execution backend, and the harness *manages* the agent definitions (`.claude/agents/*.md`) and skills (`.claude/skills/*/SKILL.md`) that Claude Code reads — with the **filesystem as the source of truth** and SurrealDB as a synced mirror (D-010). These conventions therefore govern **authored content** Claude Code consumes, so they must align with Claude Code's agent/skill format (YAML frontmatter + Markdown body), not with v2's internal data model.

This doc is the authoring standard. It does **not** describe the runtime (session orchestration → D-011; gates → D-018/D-024; hook transport → D-019). Where a convention touches an open decision it is flagged inline — most importantly the skill-files-vs-DB question (D-032), which the agentskills.io convention partially pre-commits.

---

## 2. Skill descriptions are classifiers *(kongcode)*

A skill's `description` **is its router**. Claude Code selects skills by matching the description against the user's intent — so the description does classification work with **no code behind it**. Write every description to that shape:

> `Activate when <intent>. Triggers include "<verbatim user phrases>".`

Two parts, both load-bearing:
- **Intent** — the situation, in the harness's own words.
- **Verbatim triggers** — the *actual phrases a user types*, quoted. These are the matchable surface; paraphrase loses recall. Quote real phrasing, including sloppy/partial wording.

**Example** (a release-notes skill):

```
Activate when the user wants to summarize what changed for a release or
cut release notes from merged work. Triggers include "draft the release
notes", "what changed since the last release", "changelog for v…",
"summarize the merged PRs".
```

No logic decides whether this fires — the description carries the entire routing decision. Treat description-writing as writing a classifier, not a blurb.

---

## 3. Skill family disambiguation *(kongcode)*

When several sibling skills cover adjacent intents (a *family*), descriptions collide and the wrong one fires. Each member ends with a **sibling-disambiguation tail**:

> `… use <sibling> instead when <condition>.`

One tail per ambiguous sibling. This converts a fuzzy nearest-match into an explicit decision boundary the router can read off the page.

**Example** (a `code-review` skill in a family with `code-fix` and `security-review`):

```
… use code-fix instead when the user wants the problems fixed, not just
reported; use security-review instead when the concern is specifically
vulnerabilities or secrets.
```

Author families together, not in isolation — the tails only work if every member names the others.

---

## 4. Trigger quality *(kongcode)*

Descriptions for **proactive/maintenance** skills (ones that should fire on their own, before the user asks) need two extra clauses so the router fires them at the right moment and for the right reason.

- **Stakes-and-consequence clause** — name the **silent failure** that happens if the skill does *not* fire. A proactive skill with no stated stakes gets skipped because the router sees no cost to skipping it. Make the cost explicit.

  > `If this is skipped, stale mirror records accumulate and the dashboard shows config that no longer matches disk — silently.`

- **Timing directive** — for skills tied to an irreversible action, state *when*:

  > `Use BEFORE the irreversible action, not after.` (e.g. *"Use BEFORE committing or pushing, not after."*)

Both clauses sharpen *when*, not *what* — they belong in the description alongside the §2 classifier and §3 tails.

---

## 5. Skill body and loading *(kongcode)*

**Lazy-loaded body.** A skill is a **stub description** (the classifier from §2–§4) plus a **one-line loader**; the long body is served from a tool or the DB **at activation time**, not inlined into the authored file. The router only ever needs the description to match — paying for the full body before a skill fires wastes context on every turn it *doesn't* fire.

> ✅ **D-032 resolved — this now splits cleanly by skill kind.** **Authored** skills (what this doc is about) live as git-diffable `SKILL.md` **files on disk** (D-010 filesystem-authoritative, DB mirrors them) — so an authored skill's body lives in its file, not the DB. The **lazy-load-from-DB** pattern applies to the memory engine's **learned/graduated** skills (D-027), which are SurrealDB rows. So: author the body in the file for authored skills; the stub+loader serves *learned* skill bodies from the store. No store split (single SurrealDB stands, D-001/D-032).

**Numbered loop-until-empty Process** for queue-draining workers. A worker that drains a queue (post-task extraction, maintenance — the D-021 background queue) gets an explicit **numbered Process** that loops until the queue is empty:

```
Process:
1. Claim the next pending work item (atomic claim — D-021).
2. If none, stop.
3. Do the work described by the item's payload.
4. Record the outcome.
5. Go to 1.
```

**Push the per-task schema into the work payload, not the prompt.** The skill body describes the *loop*; each item carries its *own* schema/parameters in the claimed payload. Keeps one generic worker draining heterogeneous items, instead of re-authoring the prompt per task type.

---

## 6. Tools and model tier *(kongcode)*

**Tools whitelist = the minimal MCP set the Process needs.** List exactly the tools the skill/agent uses — no more. **Reporting and introspection agents get a read-only subset** (no `Edit`, no `Write`, no `Bash` mutation). A tight whitelist is the authored complement to the runtime gates (D-018) — narrow what an agent *can request* before the gate ever evaluates it.

**Model tier per agent, stated in frontmatter.** Every agent declares its tier so routing and the agent pool can place it:

| Work shape | Tier |
|------------|------|
| Structured / mechanical (classification, extraction, formatting) | **haiku** |
| Judgment / synthesis / review | **sonnet / opus** |

This is the authored half of v2's **tiered pool** — the frontmatter tier is what the pool config and `resolveRoute` read to assign a model (intent-adaptive routing, D-020). State it explicitly; don't leave the tier to be inferred. See §10 for the config tie.

---

## 7. Output discipline *(kongcode)*

Agents that gather then report need their **output shape pinned**, or they hallucinate structure and content. Three authored blocks:

- **Present / Output block — prescribe the SHAPE.** Don't describe only the gather process; give a **field checklist** the output must contain. The agent fills a known shape rather than improvising one.

  > `Output: a finding per row — {file, line, severity, what, evidence}. No prose summary.`

- **Per-output-type quality-standards block, with anti-hallucination guards.** For each output type, state the bar and bake in grounding guards:
  - **"evidence-grounded"** — every claim cites where it came from (the `[#N]` citation discipline; a finding with no source is dropped).
  - **"only-if-it-worked"** — never report a fix/result as done unless it was verified. This is the authoring-side echo of the DO-NOT-CAPTURE rule: never persist environment failures or "X is broken" as fact (BRIEF §3b) — they harden into self-cited refusals.

- **Identity-stakes coda + a grounded-not-invented guard in the recency slot.** Close the body with a short stakes line (what the agent is *for*), and in the **last thing the model reads** (the recency slot — highest adherence) place the guard:

  > `Your <output> is earned and grounded, not invented — if you can't cite it, you don't claim it.`

  Putting the guard last is deliberate: it's the instruction the model is most likely to honor.

---

## 8. Skill file standard *(hermes, MIT)*

Author skills to the **agentskills.io standard** so they stay portable and Claude-Code-native:

- **`SKILL.md` with YAML frontmatter** + the conventional sibling dirs: `references/`, `templates/`, `scripts/`, `assets/`.
- **Namespace all v2-specific metadata under `metadata.<v2>.*`** (e.g. `metadata.v2.tier`, `metadata.v2.intent`). Keeping v2 fields under a namespaced key preserves compatibility with the base standard — a generic agentskills.io reader ignores `metadata.v2.*`, and v2's mirror sync (D-010) reads it without colliding with standard fields.
- **Telemetry lives in a SIDECAR, never in `SKILL.md` frontmatter.** Mutable counters (usage count, last-fired, success/failure tallies, outcome scores) go in a sidecar file (e.g. `<skill>.usage.json`), **not** in the authored frontmatter. Authored content is git-diffable and reviewed; counters churn every run — mixing them produces noisy diffs and merge conflicts, and corrupts the "authored vs measured" boundary. (This sidecar is the authoring-side seat of the future utilization loop — BRIEF §2.1, D-022.)

> ✅ **D-032 resolved — agentskills.io files are the decided path for AUTHORED skills.** Authored skills are git-diffable `SKILL.md` files on disk (already consistent with D-010 — Claude Code config is filesystem-authoritative, DB mirrors). This does **not** split the store: the single SurrealDB store stands (D-001/D-032); only the memory engine's *learned* skills are DB rows (D-027). The `.usage.json` sidecar is the file-side telemetry for authored skills; learned-skill RL counts live on their SurrealDB rows.

---

## 9. Worked example — SKILL.md skeleton

A **template**, not a real skill — it shows the §2–§8 conventions in one place. Fill the bracketed slots.

```markdown
---
name: <skill-name>
description: >
  Activate when <intent>.                       # §2 classifier
  Triggers include "<verbatim phrase>", "<…>".   # §2 verbatim triggers
  If this is skipped, <silent failure>.          # §4 stakes (proactive skills)
  Use BEFORE <irreversible action>, not after.   # §4 timing (if applicable)
  Use <sibling> instead when <condition>.        # §3 family tail (if in a family)
model: haiku                                     # §6 tier: structured→haiku, judgment→sonnet/opus
allowed-tools: [Read, Grep, Glob]                # §6 minimal whitelist (read-only here)
metadata:
  v2:                                            # §8 namespaced v2 metadata
    tier: structured
    intent: <intent-class>                       # ties D-020 intent-adaptive routing
    loader: <db|file>                            # §5 stub + loader; D-032 decides source
# telemetry NOT here — lives in <skill-name>.usage.json sidecar  (§8)
---

# <Skill Name>

<One-line loader / body stub — full body served at activation (§5).>

## Process                                       # §5 numbered loop (queue workers)
1. <claim next item / read the input>
2. If none, stop.
3. <do the work; per-task schema comes from the payload, not this prompt>
4. <record the outcome>
5. Go to 1.

## Output                                        # §7 prescribe the SHAPE
- Emit one <record> per <unit>: { <field>, <field>, evidence }.
- No free-form summary unless a field asks for it.

## Quality standards                             # §7 anti-hallucination guards
- Evidence-grounded: every claim cites its source ([#N]); drop uncited claims.
- Only-if-it-worked: never report a result as done unless verified.
- Never persist "X is broken" / environment failures as fact (DO-NOT-CAPTURE).

---
Your <output> is earned and grounded, not invented —              # §7 recency-slot guard
if you can't cite it, you don't claim it.
```

`references/`, `templates/`, `scripts/`, `assets/` sit beside this file per §8.

---

## 10. Open items

- **D-032 (RESOLVED) ↔ skills-as-files vs bodies-in-DB — settled by skill kind.** **Authored** skills live as git-diffable `SKILL.md` files on disk (D-010 filesystem-authoritative, DB mirrors); the memory engine's **learned/graduated** skills are SurrealDB rows (D-027). Single store stands (D-001/D-032) — no polyglot split. §5's stub+loader serves *learned* skill bodies from the store; *authored* skill bodies live in their files.
- **Model tier / frontmatter ↔ agent-pool config.** The per-agent `model:` tier and `metadata.v2.tier` (§6) are the authored inputs the **agent-pool config** and `resolveRoute` consume to place agents on a tiered pool (D-020 intent-adaptive routing). Keep the frontmatter tier and the pool config in sync — the frontmatter is authoritative for *what tier an agent wants*; the pool config decides *how many of each tier exist*. When the pool config changes tiers, audit agent frontmatter for orphaned tiers.
- **Telemetry sidecar ↔ utilization loop.** The `.usage.json` sidecar (§8) is where per-skill outcome signal will land. Per the resolved D-030, that signal feeds the recall **ranker only** (not keep/prune — pruning stays time-based, D-015); the broader self-improvement loop is D-022/D-027. Author the sidecar now even though nothing reads it yet — it's the seat the loop plugs into later.

---

*Conventions distilled from `docs/CANNIBALIZE-BRIEF.md` §5 (kongcode + hermes skills). Candidates, not mandates — verify against v2 constraints before locking into DECISIONS.md.*
