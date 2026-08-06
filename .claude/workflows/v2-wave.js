export const meta = {
  name: 'v2-wave',
  description: 'Canonical Atelier v2 build wave: per task BUILD → independent D-038 DoD-review, with a bounded in-script fix-loop on review failure (no main-thread round-trip), an A7 verdict artifact gate on every review, and an A4 red-team second pass on explicitly risk-flagged tasks. In-scope MEDIUM+ review/red-team findings flip passed=false and auto-route to the fix-loop; DEFERRED (out-of-scope/latent) findings surface as a structured deferredFollowUps ledger so the orchestrator chains a hardening wave (operator directive 2026-06-13). Parameterized via args: { waveName, tasks:[{id,title,build,redTeam?,tier?}], commonExtra?, maxFixAttempts?, redTeamAll?, model?, models?, pushAtEnd? }.',
  whenToUse: 'Any v2 gap-closure / feature wave on the F:\\code\\ai-playground-v2 worktree. Pass the task list via args — do not fork this script per wave.',
}

// ---- args ----
// waveName        string  (required) e.g. "v1.9 follow-ups"
// tasks           array   (required) [{id:'13.1', title:'slug', build:'TASK text…', redTeam?:true, tier?:'sonnet'}]
// commonExtra     string  (optional) wave-specific additions to COMMON
// maxFixAttempts  number  (optional, default 2) fix-loop bound per task
// redTeamAll      boolean (optional, default false) A4 red-team second pass for EVERY task; per-task via tasks[i].redTeam
// model           string  (optional) blanket pin for ALL subagents; omit to inherit session model
// models          object  (optional) per-KIND model map — COST DISCIPLINE (operator, 2026-06-11):
//                 {build?, review?, fix?, redTeam?, push?} e.g. {review:'opus', push:'haiku'}.
//                 Resolution per agent: tasks[i].tier (build/fix of that task) > models[kind] > model > inherit.
//                 Frontier (session model) is the DEFAULT for build/review/red-team until v2.3's
//                 tier-aware hiring provides gauntlet EVIDENCE for cheaper assignments — downgrades
//                 are the wave author's explicit, recorded choice, never silent.
// pushAtEnd       boolean (optional, default true) push origin v2 after a fully-green wave
// stopOnAnyRed    boolean (optional, default false) restore ABSOLUTE suite semantics: stop the wave on
//                 ANY failing test, even ones that predate the build. Default is RELATIVE — a build
//                 that leaves the suite no worse than the baseline it MEASURED proceeds to review
//                 (see buildStop). Set this only for a wave that must land on a green tip.
if (typeof args === 'string') { args = JSON.parse(args) } // tolerate JSON-encoded args
if (!args || !args.waveName || !Array.isArray(args.tasks) || !args.tasks.length) {
  throw new Error('v2-wave requires args { waveName, tasks:[{id,title,build}] }')
}
const MAX_FIX = args.maxFixAttempts ?? 2
const OPTS = (extra) => args.model ? { ...extra, model: args.model } : extra
// Per-kind/per-task model resolution (cost discipline). kind: 'build'|'review'|'fix'|'redTeam'|'push'.
const KOPTS = (kind, task, extra) => {
  const m = modelFor(kind, task, args)
  return m ? { ...extra, model: m } : extra
}

// ---- pure helpers (self-contained — extracted + unit-tested by v2-wave.test.mjs; keep host-free) ----
// PLAIN declarations, NOT exported (F-016): the workflow host special-cases ONLY the leading
// `export const meta` (AST-required first statement, sliced off before load); any other `export`
// is a load-time SyntaxError — the remaining body is pre-checked inside an async-function wrapper
// where `export` is illegal. v2-wave.test.mjs extracts this sentinel block from source instead.
// A7 (harvested: gstack EXIT-PLAN-MODE artifact gate, MIT — Lane A-code A4/A7): machine-validate every
// review-shaped return BEYOND the schema. Returns [] when structurally sound, else the named defects.
function checkVerdict(r){
  if(!r || typeof r!=='object' || Array.isArray(r)) return ['verdict is not an object']
  const defects=[]
  const gaps=Array.isArray(r.gaps)?r.gaps:[]
  const crit=(r.criteria && typeof r.criteria==='object')?r.criteria:{}
  const allCriteriaTrue=['complete','tested','designSystem','functional','purpose','honest'].every(k=>crit[k]===true)
  if(r.passed===false && gaps.length<1)
    defects.push('passed=false requires at least one named gap (gaps is empty)')
  if(r.passed===true && !allCriteriaTrue)
    defects.push('passed=true but a criteria flag is false/missing — any false criterion requires passed=false')
  if(r.passed===true && allCriteriaTrue){
    // cheap honesty tripwire, not NLP: a passing verdict must carry evidence of independent verification
    const v=typeof r.verdict==='string'?r.verdict.trim():''
    if(v.length<40 || !/(test|lint|check|browser|measur|verif)/i.test(v))
      defects.push('passed=true verdict lacks evidence of independent verification (need a non-trivial verdict, >=40 chars, mentioning at least one of: test/lint/check/browser/measured/verified)')
  }
  gaps.forEach((g,i)=>{ if(typeof g!=='string'||!g.trim()) defects.push(`gaps[${i}] is not a non-empty string`) })
  return defects
}
// A4 (harvested: gstack review/SKILL.md red-team pass, MIT — Lane A-code A4/A7): trigger is EXPLICIT
// only — the wave author flags risky tasks. No invented automatic heuristics (diff-size thresholds
// would be invented numbers, F-008).
function shouldRedTeam(task, waveArgs){
  return (task!=null && task.redTeam===true) || (waveArgs!=null && waveArgs.redTeamAll===true)
}
// COST DISCIPLINE (operator, 2026-06-11): per-agent model resolution. Task tier applies only to the
// task's own build/fix agents (reviewers are never silently downgraded by a task hint); per-kind map
// next; blanket pin next; else inherit the session model. push defaults to 'haiku' (two git commands).
function modelFor(kind, task, waveArgs){
  const a = waveArgs || {}
  if((kind==='build'||kind==='fix') && task && typeof task.tier==='string' && task.tier) return task.tier
  const m = a.models && typeof a.models==='object' ? a.models[kind] : undefined
  if(typeof m==='string' && m) return m
  if(typeof a.model==='string' && a.model) return a.model
  if(kind==='push') return 'haiku'
  return undefined
}
// Deferral ledger (operator directive 2026-06-13): in-scope MEDIUM+ defects flip passed=false and the
// existing fix-loop fixes them in-task; DEFERRED findings (real but out-of-scope/latent) are recorded
// in each verdict's `followUps` — this aggregates them across the wave so the orchestrator chains a
// hardening wave instead of hand-extracting them from prose. Pure: operates on the results array only.
function collectDeferred(taskResults){
  if(!Array.isArray(taskResults)) return []
  const out=[]
  for(const x of taskResults){
    for(const rv of [x&&x.review, x&&x.redTeam]){
      if(rv && Array.isArray(rv.followUps)){
        for(const f of rv.followUps){
          if(f && f.scope==='deferred' && typeof f.title==='string' && f.title.trim())
            out.push({task: typeof rv.feature==='string'?rv.feature:'(unknown)', severity:f.severity, title:f.title})
        }
      }
    }
  }
  return out
}
// SENTINEL-PREFIX markers (F-019 + recurrence): a stop counts ONLY when the deviation BEGINS with
// the marker. Word-matching anywhere failed twice — first lowercase prose ("blocked tool_result
// events"), then a NEGATED caps mention ("No BLOCKED/CONFLICT items"). BUILD_PRE instructs builders
// to begin the deviation with "BLOCKED:"/"CONFLICT:" when they genuinely need the wave to stop.
const stopRegex=/^\s*(CONFLICT|BLOCKED|BLOCKER|CANNOT PROCEED|HARD STOP)\b/
// Wave-stop decision for a BUILD-shaped verdict — used for BOTH the build step and each fix step.
// Returns null to proceed, else the reason. RELATIVE SUITE RULE (2026-08-04): the old check was
// `verifyPassed===false`, an ABSOLUTE claim that cannot distinguish "I broke the gate" from "the gate
// was already red when I arrived". It cost a whole wave — TC-1 built correctly, committed 5 good
// commits, honestly reported a PRE-EXISTING red suite, and was hard-stopped, so those commits went
// unreviewed. The honest builder was punished for the honesty. So: the NON-TEST gates (build / lint /
// svelte-check) stay ABSOLUTE — a red one is always this build's own problem — while the TEST suite is
// judged against the baseline the builder MEASURED. No worse than baseline proceeds to review (the
// reviewer re-runs a targeted slice anyway); worse stops. Unmeasured also stops: the honesty is the
// NUMBER, not the flag, so a build that never measured is not a passing build. waveArgs.stopOnAnyRed
// restores the absolute behaviour for a wave that must land green.
function buildStop(b, waveArgs){
  if(!b) return 'build returned no verdict (skipped/dead subagent)'
  if(typeof b.deviation==='string' && stopRegex.test(b.deviation)) return `builder signalled a hard stop — ${b.deviation.slice(0,200)}`
  if(b.nonTestGatesPassed===false) return 'NON-TEST gates red (build / lint / svelte-check) — always this build\'s own problem'
  const s=(b.suite && typeof b.suite==='object' && !Array.isArray(b.suite))?b.suite:null
  if(!s||!Number.isInteger(s.baselineFailed)||!Number.isInteger(s.afterFailed)||s.baselineFailed<0||s.afterFailed<0)
    return 'no MEASURED suite counts reported (suite.baselineFailed / suite.afterFailed) — an unmeasured suite is not a passing suite'
  if(s.afterFailed>s.baselineFailed) return `this build made the suite WORSE: ${s.baselineFailed} failing at baseline → ${s.afterFailed} after`
  if(waveArgs!=null && waveArgs.stopOnAnyRed===true && s.afterFailed>0)
    return `suite still red (${s.afterFailed} failing) and this wave set stopOnAnyRed`
  return null
}
// ---- verdict retention (pure half: screen + build the record; the I/O sink lives in the host body) ----
// WHY THIS EXISTS (audit, 2026-08-06): wave verdict payloads were retained NOWHERE. Zero `deviation`
// fields across a 79.5 MB session transcript, and no run store on disk at all. The only deviation text
// still readable from the one recorded stop (2026-06-11) survives because a human ran a one-off dump at
// the time. So a wave that stopped unattended left NO durable record of why. Survivable while someone is
// watching; not survivable for an autonomous stretch, and impossible to reconstruct a reasoned changelog
// from records that were never written.
//
// THE CONTRACT — RETENTION IS OBSERVABILITY, NEVER A GATE. A failed write is swallowed and the wave
// PROCEEDS (F-014). This is deliberately the INVERSE of D-024, whose fail-CLOSED rule governs SECURITY
// boundaries only; a logging fault is not a security boundary, and a wave that dies because it could not
// write a log has turned an audit aid into an outage. Records are APPEND-ONLY, one per event, never
// rewritten or compacted.

// D-026: deviation/reason text is AGENT-AUTHORED content, so it is DATA and it gets screened before it
// is persisted — a builder that pasted an .env line or a stack trace into its deviation must not turn
// the run log into a durable secret store. Redaction is by pattern and deliberately OVER-broad: a false
// redaction costs a little context, a missed secret sits on disk forever. Order matters — the specific
// token shapes run before the generic NAME=VALUE sweep.
const SCREEN_RULES=[
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED:ANTHROPIC_KEY]'],
  [/\bsk-[A-Za-z0-9]{16,}/g, '[REDACTED:API_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED:GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:GITHUB_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:AWS_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[REDACTED:JWT]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED:EMAIL]'],
]
function screenText(text, maxLen){
  if(typeof text!=='string') return null
  let out=text
  for(const rule of SCREEN_RULES) out=out.replace(rule[0], rule[1])
  // NAME=VALUE / NAME: VALUE secrets — the catch-all for credential shapes the specific rules above do
  // not know. The NAME survives (it is the useful signal — WHICH credential was involved); the VALUE
  // never does. The negative lookahead matters: without it this rule re-redacts a value one of the
  // specific rules already replaced, overwriting "[REDACTED:ANTHROPIC_KEY]" with the vaguer
  // "[REDACTED:SECRET]" and throwing away the one thing an auditor actually wants to know.
  out=out.replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)(\s*[:=]\s*)(?!\[REDACTED:)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    (m, name, sep) => `${name}${sep}[REDACTED:SECRET]`)
  const cap=(Number.isInteger(maxLen)&&maxLen>0)?maxLen:2000
  if(out.length<=cap) return out
  return `${out.slice(0,cap)}…[truncated ${out.length-cap} chars]`
}
// One append-only record: the event plus enough identity to correlate a stop back to the run, task and
// step that produced it. `at` is ISO-8601 so a run's records sort lexically. Absent fields are OMITTED
// rather than written as null noise — except the identity four, which are always present (a record you
// cannot correlate is not worth keeping).
function retentionRecord(kind, fields){
  const f=(fields&&typeof fields==='object'&&!Array.isArray(fields))?fields:{}
  const str=(v)=>(typeof v==='string'&&v)?v:null
  const rec={
    at:new Date().toISOString(),
    kind:str(kind)||'unknown',
    runId:str(f.runId),
    wave:str(f.wave),
    taskId:str(f.taskId),
    step:str(f.step),
  }
  // Recorded for PROCEED as well as STOP: the question "why did this stop?" is only answerable against
  // the trail of what it passed on the way there.
  if(typeof f.stopped==='boolean') rec.stopped=f.stopped
  const reason=screenText(f.reason, 500)
  if(reason) rec.reason=reason
  const deviation=screenText(f.deviation, 2000)
  if(deviation) rec.deviation=deviation
  const sha=str(f.commitSha)
  if(sha) rec.commitSha=sha
  const s=(f.suite&&typeof f.suite==='object'&&!Array.isArray(f.suite))?f.suite:null
  if(s&&Number.isInteger(s.baselineFailed)&&Number.isInteger(s.afterFailed))
    rec.suite={baselineFailed:s.baselineFailed, afterFailed:s.afterFailed}
  return rec
}
// FAIL-OPEN BY CONSTRUCTION. The sink performs the I/O and MAY throw — full disk, locked file, read-only
// mount, a host that forbids fs, a serializer that chokes. Every one of those is swallowed HERE and
// reported as `false`, never rethrown, so no caller can turn a logging fault into a wave stop. This is
// the whole safety property of the feature, which is why it is a named function with its own test rather
// than an inline try/catch at each call site.
function retainVia(sink, kind, fields){
  try{
    if(typeof sink!=='function') return false
    sink(retentionRecord(kind, fields))
    return true
  }catch(_err){
    return false
  }
}
// ---- end pure helpers ----

const BUILD = { type:'object', additionalProperties:false,
  required:['task','summary','filesChanged','verifyPassed','nonTestGatesPassed','suite','liveVerified','liveVerifyReason','lintClean','committed','commitSha','deviation'],
  properties:{ task:{type:'string'}, summary:{type:'string'}, filesChanged:{type:'array',items:{type:'string'}},
    verifyPassed:{type:'boolean',description:'ABSOLUTE: build + FULL test suite + lint + svelte-check ALL green RIGHT NOW. A suite that was already red before you arrived makes this false, and that alone is NOT held against you — the wave decides on nonTestGatesPassed + suite instead. Report it honestly.'},
    nonTestGatesPassed:{type:'boolean',description:'The NON-TEST gates only: npm run build + npm run lint (0) + svelte-check (0). false STOPS the wave — these are absolute, a red one is always your own change.'},
    suite:{type:'object',additionalProperties:false,required:['baselineFailed','afterFailed','baselineSource'],
      description:'MEASURED test-suite counts — the honesty is the NUMBER, not a flag. The wave proceeds while afterFailed <= baselineFailed.',
      properties:{ baselineFailed:{type:'integer',minimum:0,description:'failing tests on the tip you STARTED from, before your change'},
        afterFailed:{type:'integer',minimum:0,description:'failing tests after your change'},
        baselineSource:{type:'string',description:'how you got the baseline: the exact command AND the commit sha you ran it at — or, if you genuinely could not measure it, say so here (an unmeasured baseline stops the wave).'} }},
    liveVerified:{type:'boolean'},
    liveVerifyReason:{type:['string','null'],description:'REQUIRED when liveVerified=false: the exact env/tooling reason. null when liveVerified=true.'},
    lintClean:{type:'boolean'}, committed:{type:'boolean'}, commitSha:{type:['string','null']}, deviation:{type:['string','null']} } }
const REVIEW = { type:'object', additionalProperties:false,
  required:['feature','passed','criteria','gaps','verdict'],
  properties:{ feature:{type:'string'}, passed:{type:'boolean'},
    criteria:{type:'object',additionalProperties:false,required:['complete','tested','designSystem','functional','purpose','honest'],
      properties:{complete:{type:'boolean'},tested:{type:'boolean'},designSystem:{type:'boolean'},functional:{type:'boolean'},purpose:{type:'boolean'},honest:{type:'boolean'}}},
    gaps:{type:'array',items:{type:'string'}},
    followUps:{type:'array',description:'OPTIONAL. DEFERRED follow-ups ONLY — real findings that are genuinely out-of-scope / latent / only reachable at a future step. An IN-SCOPE MEDIUM+ defect does NOT go here — it goes in gaps with passed=false. The wave aggregates these into a deferredFollowUps ledger so a hardening wave is chained (operator directive 2026-06-13).',
      items:{type:'object',additionalProperties:false,required:['severity','scope','title'],
        properties:{severity:{type:'string',enum:['HIGH','MEDIUM','LOW']},scope:{type:'string',enum:['in-scope','deferred']},title:{type:'string',description:'one line: what + where (file:line) + why it bites later'}}}},
    verdict:{type:'string',description:'Evidence-dense and BOUNDED: ≤250 words. Lead with PASS/FAIL + what YOU ran/measured; per-criterion evidence in clauses, not narrative. Itemized detail belongs in gaps, never re-told here. End with the one-line Recommendation.'} } }

// WT defaults to the canonical v2 worktree. args.worktree lets a SECOND wave run concurrently in
// its own worktree+branch (F-052: never two builders in one worktree — they race .svelte-kit).
// A parallel lane must be scoped to files DISJOINT from the other lane's, and its branch merged
// back deliberately; args.branch names the branch the push step targets.
const WT=args.worktree||'F:\\code\\ai-playground-v2', DOCS='F:\\code\\ai-playground\\docs'
const BRANCH=args.branch||'v2'
// A13/A14 (HARVEST-GSTACK Lane A-docs): interrupt contract + subprocess discipline appended to COMMON — prompt text only, no loop changes.
const COMMON=`Atelier (v2), worktree ${WT} (branch ${BRANCH}). ABSOLUTE paths; run shell from inside ${WT}. Boot: \`npm run db:up\` then \`npm run dev\` (env via $env/dynamic/private; SurrealDB:8000/dev:5173 may be up). Spec: ${DOCS}\\UI-SPEC.md, ${DOCS}\\DESIGN-SYSTEM.md, ${DOCS}\\DATA-MODEL.md, ${DOCS}\\DECISIONS.md (**D-038 Definition of Done**, D-004, D-010, D-016, D-018/D-024, D-026), ${DOCS}\\GAP-ANALYSIS.md, ${DOCS}\\fails.md (READ the F-entries). Svelte 5 RUNES only; SurrealDB 2.x; design TOKENS only (a11y/contrast, reduced-motion, focus-visible — no outline:none); F-008 honest (live data or honest empty/—); reuse db/validate.ts (D-016). No secrets/font-binaries committed; secrets via .env, config stores secret NAMES only (D-026). GOTCHA (F-013): coerce every SurrealDB datetime to ISO string in row normalizers; absent → null → '—', NEVER str(undefined). GOTCHA (F-015): every migration DEFINE must use OVERWRITE (idempotent); test apply-twice + half-applied recovery; run \`npm run db:up\` against the LIVE dev DB as part of verify. Be HONEST in self-reports — actually RUN lint/tests. SERVER + BROWSER DISCIPLINE (F-014): (1) REUSE one dev server — check :8000/:5173 first, start AT MOST ONE of each; (2) MANDATORY CLEANUP — kill every process you start before returning; (3) BOUNDED live-verify ~5 MINUTES max, no spin-retry. INTERRUPT CONTRACT (harvested: gstack spec/SKILL.md atomic-write + gstack-upgrade migration discipline, MIT): assume any step can die mid-run and the task will be RE-RUN — every step must be idempotent or atomic (stage→verify→rename; OVERWRITE migrations, F-015); never leave an observable half-state (half-applied migration, partial file write); on re-run, detect and absorb prior partial work instead of erroring on it. SUBPROCESS DISCIPLINE (harvested: gstack codex/SKILL.md, MIT): wall-clock-bound every long-running subprocess; on failure name WHICH channel failed (timeout vs non-zero exit vs empty output) and quote the first stderr lines — never report silence as success, never let a silent stall burn the session. HARD commit gate = build + npm test + npm run lint(0) + svelte-check(0). If the browser env is unreachable (env failure, not feature defect), record liveVerified:false + liveVerifyReason and PROCEED on the hard gate + thorough code read. If a page loader returns "IAM error: Not enough permissions", restart the ONE dev server (stale DB session). KNOWN ENV NOISE (not your defect): tinypool ERR_IPC_CHANNEL_CLOSED teardown warning; cc-config readback.live / capability-wiring.live can flake under full-suite concurrency while passing isolated.${args.commonExtra ? ' ' + args.commonExtra : ''}`

// A3 (HARVEST-GSTACK Lane A-docs): shadow paths + every-error-has-a-name + deferred-work-written-down — G4: clarifies D-038 #1/#6, supersedes nothing.
const BUILD_PRE=`You are a BUILD agent. ${COMMON} Build the feature COMPLETE to the **D-038 Definition of Done** (all six: complete · fully tested unit+integration vs real SurrealDB · design-system standard · functional & live-verified in a real browser · purposeful/reachable · honest). SHADOW PATHS (harvested: gstack plan-ceo-review/SKILL.md Prime Directives, MIT): every data flow has a happy path plus three shadow paths — nil input, empty/zero-length input, upstream error — build and test all four. EVERY ERROR HAS A NAME: name what triggers it, what catches it, and what the user sees; catch-all error handling is a smell, not coverage. DEFERRED WORK IS WRITTEN DOWN OR IT'S A LIE: anything you cut or punt MUST appear as an explicit named item in your summary/deviation — a vague intention to revisit later does not exist. SUITE BASELINE — MEASURE IT, DO NOT GUESS IT (2026-08-04): BEFORE you touch anything, run the test suite on the tip you start from and record the FAILING COUNT; run it again after your change. Report both in the REQUIRED \`suite\` field ({baselineFailed, afterFailed, baselineSource}), with baselineSource naming the exact command and the commit sha you measured at. A suite that was ALREADY red when you arrived is NOT your failure, NOT a reason to stop, and NOT a number to hide or round: the wave stops you only if afterFailed > baselineFailed, if the NON-TEST gates (build / lint / svelte-check → \`nonTestGatesPassed\`) are red, or if you never measured at all. Report \`verifyPassed\` as the honest ABSOLUTE claim (everything green right now) even when a pre-existing red suite makes it false — you are judged on the delta, so honesty costs you nothing here. STOP SIGNALING: if you genuinely need the wave to STOP (unresolvable conflict with a spec/locked decision, cannot proceed), BEGIN your deviation field with the marker — "BLOCKED: <why>" or "CONFLICT: <why>". Markers are only honored at the START of the deviation; advisory deviations must NOT start with those words. Commit atomically: git add -A && git commit -m "feat(v2): <task> — <one line>" (blank line) "Co-Authored-By: Claude <noreply@anthropic.com>". Final message IS the BUILD verdict.`
// A1/A2/A6/A9/A14/A15 (HARVEST-GSTACK Lane A-docs): reviewer methodology — G1 absence carve-out, G2 logged 🔒-only suppression, G3 LOW-never-auto-fix, G5 re-derived sweep.
const REVIEW_PRE=`You are an INDEPENDENT D-038 DoD REVIEWER (not the builder). ${COMMON} Re-read the code and RUN verification yourself — TARGETED (cost discipline, 2026-06-11): run the TOUCHED test files + the affected area's suite slice + \`npm run lint\` + svelte-check (plus \`npm run db:up\` if a migration shipped); the FULL suite is the builder's hard gate and is NOT re-run by default — escalate to the full suite ONLY if your targeted slice fails, the builder's full-run claim looks inconsistent, or the diff touches cross-cutting infra (migrations, gates, events/watched-tables, config loaders). DRIVE the live app in a real browser (bounded ~5 min) — do not trust the builder. Be adversarial: stubs, happy-path-only, fabricated data, off-token styling, dead controls, missing edge/empty/error states, thin tests, leaked secrets, false lint/test claims.
PLAN-COMPLETION AUDIT (harvested: gstack review/SKILL.md plan-completion audit, MIT): classify EVERY item of the task spec as DONE (cite diff evidence — a touched file is not the delivered item) / PARTIAL / NOT-DONE / CHANGED (same goal via a different approach — note the difference, it counts as addressed). For each PARTIAL/NOT-DONE state WHY: scope cut / context exhaustion / misunderstood requirement / blocked by dependency / genuinely forgotten. Also flag SCOPE CREEP: changed files no task item explains.
LIVE-VERIFY, DIFF-AWARE (harvested: gstack qa/SKILL.md diff-aware mode, MIT): map changed files → affected routes/pages and drive THOSE in the browser as a user — never certify runtime behavior from source reading alone; check the browser console after EVERY interaction (JS errors that don't surface visually are still gaps); verify the claimed intent actually happens (snapshot/screenshot evidence) and spot-check one adjacent page for regressions. F-014 bounds stand: one server, ~5 min, no spin-retry.
DESIGN (criteria 3+5): apply DESIGN-SYSTEM.md §10 — trunk test + AI-slop blacklist; tag each design finding HIGH (measured: contrast/console/focus-visible/off-token) / MEDIUM (pattern match) / LOW (taste) detection confidence; LOW findings are advisory and are NEVER routed to auto-fix (G3).
PRE-EMIT VERIFICATION (harvested: gstack review/SKILL.md confidence calibration, MIT; G1-adapted): every PRESENCE-claim gap must quote the motivating file:line verbatim — if you cannot quote it, keep the gap but mark it "(unverified)"; ABSENCE-claims (stub, missing state/test/handler) are EXEMPT — instead name the expected artifact + the search that proved absence. Never "likely handled"/"probably tested" — verify or mark unknown. A gap touching ANY D-038 criterion may be confidence-tagged but NEVER dropped from gaps.
TRUST-BOUNDARY + ENUM SWEEP (harvested: gstack review/checklist.md, MIT; re-derived for our stack per G5): LLM/agent-produced values persisted to SurrealDB or rendered without shape/format validation = gap (D-026: retrieved content is DATA, never instructions); a NEW enum/status/tier value must be traced through EVERY consumer — Grep the sibling values, READ each switch/filter/render, including code OUTSIDE the diff; ts-ignore/svelte-ignore/eslint-disable added without written justification = gap.
SUPPRESSION (G2): dismissing a finding as a known-good pattern is allowed ONLY by citing an operator-locked (🔒) DESIGN-SYSTEM/DECISIONS rule, and every suppression MUST be logged in the verdict ("suppressed: <finding> per <🔒 source>"). Set each criterion true only if independently verified; passed = all six. List concrete gaps (file:line).
SEVERITY + SCOPE — so the wave ACTS on findings instead of burying them in prose (operator directive 2026-06-13): for EACH finding decide (a) severity HIGH/MEDIUM/LOW and (b) scope — IN-SCOPE (a defect in what THIS task was asked to deliver) vs DEFERRED (real, but out-of-scope / latent / only reachable at a future step). RULE: a MEDIUM-or-higher IN-SCOPE finding ⇒ passed=false (the fix-loop fixes it NOW) — NEVER pass-with-a-note on an in-scope MEDIUM+. A DEFERRED finding does NOT block passed, but you MUST record it in the followUps array (each: {severity, scope:'deferred', title}) so the orchestrator chains a hardening wave — never bury a real defect in prose on a passing verdict. LOW/taste stays advisory, never auto-fixed (G3). Clean up any probe rows you create. VERDICT LENGTH: ≤250 words, evidence-dense — what you ran and measured, no narrative; detail lives in gaps. End the verdict with ONE synthesis line (harvested: gstack codex/SKILL.md, MIT): "Recommendation: <action> because <reason naming the most actionable gap>". Final message IS the REVIEW verdict.`

// A7 gate runner (harvested: gstack EXIT-PLAN-MODE artifact gate, MIT — Lane A-code A4/A7): EVERY
// review-shaped agent return (initial review, re-reviews, red-team) passes checkVerdict; on failure
// the SAME reviewer is re-asked ONCE with the defects named; a second failure becomes a review
// failure (fix-loop path) with the structural defects recorded.
const forceFail=(r,defects)=>({ ...r, passed:false, structuralDefects:defects,
  gaps:[...(Array.isArray(r.gaps)?r.gaps:[]).filter(g=>typeof g==='string'&&g.trim()),
        ...defects.map(d=>`STRUCTURAL (A7 artifact gate): ${d}`)],
  verdict:`[A7 ARTIFACT-GATE FAILURE: ${defects.join('; ')}] ${typeof r.verdict==='string'?r.verdict:''}`.trim() })
async function gatedReview(prompt, opts){
  const r=await agent(prompt, opts)
  if(!r) return r // skipped/dead agent — caller's existing null handling stands
  const defects=checkVerdict(r)
  if(!defects.length) return r
  log(`${opts.label}: verdict failed the A7 artifact gate (${defects.join('; ')}) — re-asking the reviewer once`)
  const r2=await agent(`${prompt}\n\nARTIFACT GATE (structural self-check): your verdict failed the artifact gate: ${defects.join('; ')} — re-emit a complete verdict. Your defective verdict was: ${typeof r.verdict==='string'?r.verdict.slice(0,1500):String(r.verdict)}`, {...opts, label:`${opts.label} re-emit`})
  if(!r2) return forceFail(r, defects)
  const defects2=checkVerdict(r2)
  return defects2.length ? forceFail(r2, defects2) : r2
}

// stopRegex (F-019) + buildStop (relative suite semantics) live in the pure-helper block above.

// ---- verdict retention (impure half: the JSONL sink) ----
// LOCATION, chosen deliberately — the WORKFLOW repo, NOT the build worktree:
//  - NOT inside WT. A wave's BUILD/FIX agents run `git add -A && git commit`, so anything written there
//    is swept into a feature commit. The run log would corrupt the very history it exists to explain.
//  - NOT .playground/. That is live state with real readers, not a dumping ground.
//  - HERE, and gitignored BY CONSTRUCTION: on v2-main .gitignore line 6 is `/*`, admitting only /docs/
//    and /.gitignore, so an untracked file under .claude/ can never be committed by accident. Verified
//    with `git check-ignore -v` rather than assumed.
// ONE FILE PER RUN, keyed by RUN_ID, so concurrent waves (the args.worktree parallel lanes, F-052) can
// never interleave into one file or clobber each other.
const RUN_DIR=args.runLogDir||'F:\\code\\ai-playground\\.claude\\wave-runs'
const RUN_ID=`${String(args.waveName).replace(/[^A-Za-z0-9._-]+/g,'-').slice(0,40)}-${new Date().toISOString().replace(/[:.]/g,'-')}-${Math.random().toString(36).slice(2,8)}`
let retainWarned=false
// Never throws, never awaits anything the wave depends on. The fs handle is acquired defensively because
// the host's evaluation model is not knowable from this repo: dynamic import first, `require` second, and
// if BOTH fail the wave proceeds with retention off and says so ONCE (honest degradation, F-008 — never
// a silent no-op that reads as "it was logged").
async function retain(kind, fields){
  let ok=false
  try{
    let mod=null
    try{ const m=await import('node:fs'); mod=m&&m.default?m.default:m }catch(_err){ mod=null }
    if(!mod){ try{ mod=require('node:fs') }catch(_err){ mod=null } }
    if(mod) ok=retainVia((rec)=>{
      mod.mkdirSync(RUN_DIR,{recursive:true})
      mod.appendFileSync(`${RUN_DIR}\\${RUN_ID}.jsonl`, `${JSON.stringify(rec)}\n`, 'utf8')
    }, kind, {...fields, runId:RUN_ID, wave:args.waveName})
  }catch(_err){ ok=false }
  if(!ok&&!retainWarned){
    retainWarned=true
    try{ log(`verdict retention unavailable (${RUN_DIR}) — the wave PROCEEDS without it; retention is observability, never a gate`) }catch(_err){}
  }
}

const results=[]
await retain('wave-start', {step:'start'})
for (const t of args.tasks){
  phase(`${t.id} ${t.title}`)
  const b=await agent(`${BUILD_PRE}\n\n${t.build}`, KOPTS('build', t, {label:`${t.id} ${t.title}`, phase:`${t.id} ${t.title}`, schema:BUILD}))
  const bstop=buildStop(b, args)
  // Every buildStop DECISION is retained, proceed as well as stop — the deviation text rides along
  // because it is the payload that vanished before (an audit found zero of them anywhere on disk).
  await retain('build-gate', {taskId:t.id, step:`${t.id} build`, stopped:!!bstop, reason:bstop,
    deviation:b&&b.deviation, commitSha:b&&b.commitSha, suite:b&&b.suite})
  if(bstop){
    await retain('wave-stop', {taskId:t.id, step:`${t.id} build`, stopped:true, reason:bstop, deviation:b&&b.deviation})
    return {stoppedAt:`${t.id} build — ${bstop}`, results:[...results,{build:b}]}
  }

  phase(`${t.id} review`)
  let r=await gatedReview(`${REVIEW_PRE}\n\nFEATURE: ${t.id} ${t.title}. Builder files: ${(b.filesChanged||[]).join(', ')} (commit ${b.commitSha}); claimed lintClean=${b.lintClean}, verifyPassed=${b.verifyPassed}, nonTestGatesPassed=${b.nonTestGatesPassed}, liveVerified=${b.liveVerified}${b.liveVerified?'':` (reason: ${b.liveVerifyReason})`}. MEASURED suite: ${b.suite?`${b.suite.baselineFailed} failing at baseline → ${b.suite.afterFailed} after (baseline source: ${b.suite.baselineSource})`:'(none reported)'} — judge the DELTA only: failures that predate this task are wave context, NOT a gap against it. But numbers that contradict the flags (e.g. verifyPassed=true alongside afterFailed>0, or a baselineSource that names no command/sha) ARE an honesty finding under criterion 6. Builder claim: ${b.summary}\n\nIndependently certify against the six D-038 criteria now.`, KOPTS('review', t, {label:`${t.id} DoD-review`, phase:`${t.id} review`, schema:REVIEW}))

  // bounded fix-loop: review FAIL → fix agent gets the reviewer's gaps → fresh re-review.
  // Outer escalation loop exists ONLY for A4: a red-team FAIL re-enters the same fix-loop
  // (same maxFixAttempts budget); red team runs at most ONCE per task.
  const fixes=[]
  let attempt=0
  let redTeam=null
  let escalate=true
  while(escalate){
  escalate=false
  while(r && r.passed===false && attempt<MAX_FIX){
    attempt++
    log(`${t.id} review FAILED — fix attempt ${attempt}/${MAX_FIX}`)
    phase(`${t.id} fix-${attempt}`)
    // A5 (HARVEST-GSTACK Lane A-docs): AUTO-FIX vs ASK triage — G3-bounded (routing only; reviewer never edits; every fix re-reviewed by the loop below).
    const f=await agent(`You are a FIX agent. ${COMMON} Feature ${t.id} ${t.title} (commit ${b.commitSha}) FAILED its independent D-038 DoD-review. Fix the cited defects ONLY — no rebuild, no scope creep. TRIAGE (harvested: gstack review/checklist.md Fix-First heuristic, MIT; G3-bounded): classify each gap MECHANICAL (a senior engineer would apply it without discussion — dead code, missing validation guard, token/path/version mismatch, stale comment) vs JUDGMENT (security, race conditions, design decisions, fixes >20 lines, removing functionality, anything changing user-visible behavior). At most 3 gaps may be fixed as straight mechanical fixes; every other gap gets the full ROOT-CAUSE treatment (reproduce it; do not guess-fix); state the actual root cause in your summary. A JUDGMENT gap that needs a product decision is a STOP-and-report deviation, not a guess. LOW-confidence (taste) design findings are advisory — do NOT fix them on your own judgment (G3). You fix, you never self-certify — every fix goes to a fresh independent re-review; do not mark gaps resolved yourself. Add a regression test per defect.\n\nREVIEW VERDICT:\n${r.verdict}\n\nGAPS:\n${(r.gaps||[]).map((g,i)=>`${i+1}. ${g}`).join('\n')}\n\nHARD GATE then bounded live verify of the fixed behavior. Your \`suite\` baseline is the tip you start from — i.e. AFTER the build commit ${b.commitSha}; same rule applies (you are judged on the delta, not on failures you inherited), and \`nonTestGatesPassed\` red still stops the wave. Commit atomically: git add -A && git commit -m "fix(v2): ${t.id} ${t.title} — <root cause one-liner>" (blank line) "Co-Authored-By: Claude <noreply@anthropic.com>". Final message IS the BUILD verdict.`, KOPTS('fix', t, {label:`${t.id} fix-${attempt}`, phase:`${t.id} fix-${attempt}`, schema:BUILD}))
    fixes.push(f)
    const fstop=buildStop(f, args)
    await retain('fix-gate', {taskId:t.id, step:`${t.id} fix-${attempt}`, stopped:!!fstop, reason:fstop,
      deviation:f&&f.deviation, commitSha:f&&f.commitSha, suite:f&&f.suite})
    if(fstop){
      await retain('wave-stop', {taskId:t.id, step:`${t.id} fix-${attempt}`, stopped:true, reason:fstop, deviation:f&&f.deviation})
      return {stoppedAt:`${t.id} fix-${attempt} — ${fstop}`, results:[...results,{build:b,review:r,redTeam,fixes}]}
    }
    phase(`${t.id} re-review-${attempt}`)
    r=await gatedReview(`${REVIEW_PRE}\n\nFEATURE: ${t.id} ${t.title} — RE-REVIEW after fix attempt ${attempt}. Original commit ${b.commitSha}; fix commit ${f.commitSha} (files: ${(f.filesChanged||[]).join(', ')}). PRIOR FAIL verdict: ${String(r.verdict).slice(0,1500)}\n\nFixer claim: ${f.summary}\n\nVerify each previously-cited gap is GENUINELY resolved (not papered over), then re-certify ALL six D-038 criteria.`, KOPTS('review', t, {label:`${t.id} re-review-${attempt}`, phase:`${t.id} re-review-${attempt}`, schema:REVIEW}))
  }

  // A4 (harvested: gstack review/SKILL.md red-team pass + review/specialists/red-team.md, MIT — Lane
  // A-code A4/A7): AFTER the review PASSES, explicitly risk-flagged tasks get ONE adversarial second
  // pass fed the prior reviewer's findings verbatim; passed=false re-enters the fix-loop above.
  if(r && r.passed===true && redTeam===null && shouldRedTeam(t, args)){
    phase(`${t.id} red-team`)
    const fixShas=fixes.filter(x=>x&&x.commitSha).map(x=>x.commitSha)
    redTeam=await gatedReview(`${REVIEW_PRE}\n\nFEATURE: ${t.id} ${t.title} — RED-TEAM SECOND PASS. A first independent DoD-review already PASSED this risk-flagged feature. This is NOT a checklist re-run — it is adversarial analysis: your job is to find what the first reviewer MISSED, not to re-find the same things. Think like an attacker, a chaos engineer, and a hostile QA tester at once: attack the happy path (load, concurrent writes, slow DB, garbage from upstream); hunt silent failures (swallowed exceptions, partial completion, inconsistent state after a crash); exploit trust assumptions (frontend-only validation, unvalidated config, paths/URLs built from user input); break edge cases (max-size input, zero/empty/null, first-run-ever, double-submit); and probe the seams the first pass didn't cover — cross-cutting and integration-boundary issues. Builder files: ${(b.filesChanged||[]).join(', ')} (commit ${b.commitSha}${fixShas.length?`; fix commits ${fixShas.join(', ')}`:''}).\n\nPRIOR REVIEW (PASSED) — findings/gaps VERBATIM, hunt what it MISSED:\nverdict: ${r.verdict}\ngaps: ${(r.gaps&&r.gaps.length)?r.gaps.map((g,i)=>`${i+1}. ${g}`).join('; '):'(none listed)'}\n\nRe-certify ALL six D-038 criteria with fresh adversarial eyes; set passed=false ONLY for real, evidenced gaps the first pass missed.`, KOPTS('redTeam', t, {label:`${t.id} red-team`, phase:`${t.id} red-team`, schema:REVIEW}))
    if(!redTeam){
      await retain('wave-stop', {taskId:t.id, step:`${t.id} red-team`, stopped:true,
        reason:'red-team agent skipped/died — required gate, fail closed'})
      return {stoppedAt:`${t.id} red-team (agent skipped/died — required gate, fail closed)`, results:[...results,{build:b,review:r,redTeam:null,fixes}]}
    }
    if(redTeam.passed===false){ log(`${t.id} red-team FAILED — feeding its gaps into the fix-loop`); r=redTeam; escalate=true }
  }
  }

  results.push({build:b, review:r, redTeam, fixes})
  // name the actual failing gate: when the red team failed with the fix budget already spent, r IS the red-team verdict
  if(!r||r.passed===false){
    const gate=r&&r===redTeam?'red-team review':'DoD-review'
    // The reviewer's own gaps are the "why" here — the verdict is a review verdict, not a build one,
    // so the reason is assembled from the gaps rather than a buildStop string.
    await retain('wave-stop', {taskId:t.id, step:`${t.id} ${gate}`, stopped:true,
      reason:`${gate} failed after ${attempt} fix attempts — ${r?(r.gaps||[]).join(' | '):'no verdict (agent skipped/died)'}`})
    return {stoppedAt:`${t.id} ${gate} (after ${attempt} fix attempts)`, results}
  }
}

if(args.pushAtEnd!==false){
  phase('push')
  // Housekeeping agent: cheapest tier — it runs two git commands (cost discipline, 2026-06-11).
  await agent(`Run exactly: cd ${WT} && git status --short && git push origin ${BRANCH}. Confirm the push output. If the tree is dirty, report what is dirty and push anyway (committed work only goes up). No other actions.`, KOPTS('push', null, {label:`push ${BRANCH}`, phase:'push'}))
}
const deferredFollowUps = collectDeferred(results)
if(deferredFollowUps.length) log(`${deferredFollowUps.length} DEFERRED follow-up(s) recorded — orchestrator should chain a hardening wave: ${deferredFollowUps.map(d=>`[${d.severity}] ${d.task}: ${d.title}`).join(' | ')}`)
await retain('wave-complete', {step:'end', stopped:false,
  reason:`all ${args.tasks.length} task(s) green${deferredFollowUps.length?`; ${deferredFollowUps.length} deferred follow-up(s)`:''}`})
return {stoppedAt:null, complete:true, results, deferredFollowUps, runId:RUN_ID}
