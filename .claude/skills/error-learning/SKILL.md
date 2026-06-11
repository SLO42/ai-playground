---
name: error-learning
description: Post-task error review, fail documentation, and mistake prevention protocol
---

# Error Learning Protocol

## Before Starting Any Task

1. Read `docs/fails.md` — scan for entries matching the current task type
   (file deletion, API changes, refactoring, dependency updates, etc.)
2. Check auto-memory for feedback entries related to files you're about to modify
3. Include relevant prevention rules in your plan

## After Completing Any Task

1. Did build/test pass on first try?
   - YES → done
   - NO → continue to step 2

2. Document the failure in `docs/fails.md`:
   ```markdown
   ## F-NNN: [short description]
   - **Date**: [today]
   - **What**: [what broke — the symptom]
   - **Why**: [root cause — not the symptom, the actual reason]
   - **Fix**: [what you did to fix it]
   - **Prevention**: [rule to prevent this in the future]
   ```

3. Did you repeat a mistake already in fails.md?
   - YES → escalate: add the rule to the relevant skill's SKILL.md
   - Update the original fail entry with "Recurrence: [date]"

## After Any Session Where You Learned Something Reusable

Save to auto-memory:
- **feedback** type: corrections to your approach (how user wants things done)
- **project** type: decisions, deadlines, architectural choices
- **reference** type: where to find information in external systems

## Debugging Protocol — the Iron Law (harvested: gstack investigate/SKILL.md, MIT)

**NO FIXES WITHOUT ROOT-CAUSE INVESTIGATION FIRST.** Fixing symptoms creates
whack-a-mole debugging; every fix that doesn't address root cause makes the next
bug harder to find.

1. **Instrument before fixing**: form a specific, testable root-cause hypothesis,
   then confirm it with evidence (temporary log/assertion at the suspected cause +
   a deterministic reproduction) BEFORE writing any fix.
2. **Scope lock**: once the hypothesis is formed, restrict edits to the affected
   module/directory for the rest of the debug session. If the bug genuinely spans
   the repo, say so explicitly instead of silently widening scope.
3. **3-strike rule**: if 3 hypotheses fail, STOP. Escalate with options (continue
   with a NEW named hypothesis / hand to human review / add instrumentation and
   catch it next occurrence) — do not grind out hypothesis #4 silently.
4. **Recurring bugs in the same files are an architectural smell**, not a
   coincidence. Check `git log` and fails.md for prior fixes in the same area; if
   the area keeps breaking, the finding is "this layer is structurally wrong",
   not another patch.

Red flags — slow down if you catch yourself: "quick fix for now" (there is no
"for now" — fix it right or escalate); proposing a fix before tracing data flow
(you're guessing); each fix revealing a new problem elsewhere (wrong layer, not
wrong code).

## Staleness & Contradiction Marking (harvested: gstack learn/SKILL.md prune, MIT — G2: agents propose, operator retires)

fails.md and memory entries rot. The marking protocol:

- **Staleness check**: if an entry references files, commands, or mechanisms that
  no longer exist (verify with Glob/Grep — cite the search), append a dated line
  under the entry: `> STALE-PROPOSED (YYYY-MM-DD): <evidence — what no longer exists>`.
- **Contradiction check**: if two entries give opposing rules, append
  `> CONFLICT (YYYY-MM-DD): contradicts F-NNN — <one-line summary>` under BOTH.
  Do not pick a winner yourself.
- **MARK, never delete.** Agents only propose; ONLY the operator (or a
  D-039-validated PM decision) retires an entry. A marked entry stays in force
  until the operator retires it.

## Escalation Path

| Occurrences | Action |
|-------------|--------|
| 1st time | Document in docs/fails.md |
| 2nd time | Add to relevant skill SKILL.md |
| 3rd time | Add to CLAUDE.md as a hard rule |
| Keeps happening | Create a hook for hard enforcement |

## Fail Entry Quality

Good fail entries are specific and actionable:
- BAD: "Don't make mistakes when deleting files"
- GOOD: "Before deleting ANY file, run `grep -r 'from.*<filename>'` to find dependents"

The prevention rule should be a concrete action, not a vague reminder.
