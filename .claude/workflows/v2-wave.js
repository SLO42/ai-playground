export const meta = {
  name: 'v2-wave',
  description: 'Canonical Atelier v2 build wave: per task BUILD → independent D-038 DoD-review, with a bounded in-script fix-loop on review failure (no main-thread round-trip). Parameterized via args: { waveName, tasks:[{id,title,build}], commonExtra?, maxFixAttempts?, model?, pushAtEnd? }.',
  whenToUse: 'Any v2 gap-closure / feature wave on the F:\\code\\ai-playground-v2 worktree. Pass the task list via args — do not fork this script per wave.',
}

// ---- args ----
// waveName        string  (required) e.g. "v1.9 follow-ups"
// tasks           array   (required) [{id:'13.1', title:'slug', build:'TASK text…'}]
// commonExtra     string  (optional) wave-specific additions to COMMON
// maxFixAttempts  number  (optional, default 2) fix-loop bound per task
// model           string  (optional) pin subagent model (e.g. 'opus'); omit to inherit session model
// pushAtEnd       boolean (optional, default true) push origin v2 after a fully-green wave
if (typeof args === 'string') { args = JSON.parse(args) } // tolerate JSON-encoded args
if (!args || !args.waveName || !Array.isArray(args.tasks) || !args.tasks.length) {
  throw new Error('v2-wave requires args { waveName, tasks:[{id,title,build}] }')
}
const MAX_FIX = args.maxFixAttempts ?? 2
const OPTS = (extra) => args.model ? { ...extra, model: args.model } : extra

const BUILD = { type:'object', additionalProperties:false,
  required:['task','summary','filesChanged','verifyPassed','liveVerified','liveVerifyReason','lintClean','committed','commitSha','deviation'],
  properties:{ task:{type:'string'}, summary:{type:'string'}, filesChanged:{type:'array',items:{type:'string'}},
    verifyPassed:{type:'boolean'}, liveVerified:{type:'boolean'},
    liveVerifyReason:{type:['string','null'],description:'REQUIRED when liveVerified=false: the exact env/tooling reason. null when liveVerified=true.'},
    lintClean:{type:'boolean'}, committed:{type:'boolean'}, commitSha:{type:['string','null']}, deviation:{type:['string','null']} } }
const REVIEW = { type:'object', additionalProperties:false,
  required:['feature','passed','criteria','gaps','verdict'],
  properties:{ feature:{type:'string'}, passed:{type:'boolean'},
    criteria:{type:'object',additionalProperties:false,required:['complete','tested','designSystem','functional','purpose','honest'],
      properties:{complete:{type:'boolean'},tested:{type:'boolean'},designSystem:{type:'boolean'},functional:{type:'boolean'},purpose:{type:'boolean'},honest:{type:'boolean'}}},
    gaps:{type:'array',items:{type:'string'}}, verdict:{type:'string'} } }

const WT='F:\\code\\ai-playground-v2', DOCS='F:\\code\\ai-playground\\docs'
// A13/A14 (HARVEST-GSTACK Lane A-docs): interrupt contract + subprocess discipline appended to COMMON — prompt text only, no loop changes.
const COMMON=`Atelier (v2), worktree ${WT} (branch v2). ABSOLUTE paths; run shell from inside ${WT}. Boot: \`npm run db:up\` then \`npm run dev\` (env via $env/dynamic/private; SurrealDB:8000/dev:5173 may be up). Spec: ${DOCS}\\UI-SPEC.md, ${DOCS}\\DESIGN-SYSTEM.md, ${DOCS}\\DATA-MODEL.md, ${DOCS}\\DECISIONS.md (**D-038 Definition of Done**, D-004, D-010, D-016, D-018/D-024, D-026), ${DOCS}\\GAP-ANALYSIS.md, ${DOCS}\\fails.md (READ the F-entries). Svelte 5 RUNES only; SurrealDB 2.x; design TOKENS only (a11y/contrast, reduced-motion, focus-visible — no outline:none); F-008 honest (live data or honest empty/—); reuse db/validate.ts (D-016). No secrets/font-binaries committed; secrets via .env, config stores secret NAMES only (D-026). GOTCHA (F-013): coerce every SurrealDB datetime to ISO string in row normalizers; absent → null → '—', NEVER str(undefined). GOTCHA (F-015): every migration DEFINE must use OVERWRITE (idempotent); test apply-twice + half-applied recovery; run \`npm run db:up\` against the LIVE dev DB as part of verify. Be HONEST in self-reports — actually RUN lint/tests. SERVER + BROWSER DISCIPLINE (F-014): (1) REUSE one dev server — check :8000/:5173 first, start AT MOST ONE of each; (2) MANDATORY CLEANUP — kill every process you start before returning; (3) BOUNDED live-verify ~5 MINUTES max, no spin-retry. INTERRUPT CONTRACT (harvested: gstack spec/SKILL.md atomic-write + gstack-upgrade migration discipline, MIT): assume any step can die mid-run and the task will be RE-RUN — every step must be idempotent or atomic (stage→verify→rename; OVERWRITE migrations, F-015); never leave an observable half-state (half-applied migration, partial file write); on re-run, detect and absorb prior partial work instead of erroring on it. SUBPROCESS DISCIPLINE (harvested: gstack codex/SKILL.md, MIT): wall-clock-bound every long-running subprocess; on failure name WHICH channel failed (timeout vs non-zero exit vs empty output) and quote the first stderr lines — never report silence as success, never let a silent stall burn the session. HARD commit gate = build + npm test + npm run lint(0) + svelte-check(0). If the browser env is unreachable (env failure, not feature defect), record liveVerified:false + liveVerifyReason and PROCEED on the hard gate + thorough code read. If a page loader returns "IAM error: Not enough permissions", restart the ONE dev server (stale DB session). KNOWN ENV NOISE (not your defect): tinypool ERR_IPC_CHANNEL_CLOSED teardown warning; cc-config readback.live / capability-wiring.live can flake under full-suite concurrency while passing isolated.${args.commonExtra ? ' ' + args.commonExtra : ''}`

// A3 (HARVEST-GSTACK Lane A-docs): shadow paths + every-error-has-a-name + deferred-work-written-down — G4: clarifies D-038 #1/#6, supersedes nothing.
const BUILD_PRE=`You are a BUILD agent. ${COMMON} Build the feature COMPLETE to the **D-038 Definition of Done** (all six: complete · fully tested unit+integration vs real SurrealDB · design-system standard · functional & live-verified in a real browser · purposeful/reachable · honest). SHADOW PATHS (harvested: gstack plan-ceo-review/SKILL.md Prime Directives, MIT): every data flow has a happy path plus three shadow paths — nil input, empty/zero-length input, upstream error — build and test all four. EVERY ERROR HAS A NAME: name what triggers it, what catches it, and what the user sees; catch-all error handling is a smell, not coverage. DEFERRED WORK IS WRITTEN DOWN OR IT'S A LIE: anything you cut or punt MUST appear as an explicit named item in your summary/deviation — a vague intention to revisit later does not exist. Commit atomically: git add -A && git commit -m "feat(v2): <task> — <one line>" (blank line) "Co-Authored-By: Claude <noreply@anthropic.com>". Final message IS the BUILD verdict.`
// A1/A2/A6/A9/A14/A15 (HARVEST-GSTACK Lane A-docs): reviewer methodology — G1 absence carve-out, G2 logged 🔒-only suppression, G3 LOW-never-auto-fix, G5 re-derived sweep.
const REVIEW_PRE=`You are an INDEPENDENT D-038 DoD REVIEWER (not the builder). ${COMMON} Re-read the code, RUN tests + \`npm run lint\` + svelte-check yourself (plus \`npm run db:up\` if a migration shipped), and DRIVE the live app in a real browser (bounded ~5 min) — do not trust the builder. Be adversarial: stubs, happy-path-only, fabricated data, off-token styling, dead controls, missing edge/empty/error states, thin tests, leaked secrets, false lint/test claims.
PLAN-COMPLETION AUDIT (harvested: gstack review/SKILL.md plan-completion audit, MIT): classify EVERY item of the task spec as DONE (cite diff evidence — a touched file is not the delivered item) / PARTIAL / NOT-DONE / CHANGED (same goal via a different approach — note the difference, it counts as addressed). For each PARTIAL/NOT-DONE state WHY: scope cut / context exhaustion / misunderstood requirement / blocked by dependency / genuinely forgotten. Also flag SCOPE CREEP: changed files no task item explains.
LIVE-VERIFY, DIFF-AWARE (harvested: gstack qa/SKILL.md diff-aware mode, MIT): map changed files → affected routes/pages and drive THOSE in the browser as a user — never certify runtime behavior from source reading alone; check the browser console after EVERY interaction (JS errors that don't surface visually are still gaps); verify the claimed intent actually happens (snapshot/screenshot evidence) and spot-check one adjacent page for regressions. F-014 bounds stand: one server, ~5 min, no spin-retry.
DESIGN (criteria 3+5): apply DESIGN-SYSTEM.md §10 — trunk test + AI-slop blacklist; tag each design finding HIGH (measured: contrast/console/focus-visible/off-token) / MEDIUM (pattern match) / LOW (taste) detection confidence; LOW findings are advisory and are NEVER routed to auto-fix (G3).
PRE-EMIT VERIFICATION (harvested: gstack review/SKILL.md confidence calibration, MIT; G1-adapted): every PRESENCE-claim gap must quote the motivating file:line verbatim — if you cannot quote it, keep the gap but mark it "(unverified)"; ABSENCE-claims (stub, missing state/test/handler) are EXEMPT — instead name the expected artifact + the search that proved absence. Never "likely handled"/"probably tested" — verify or mark unknown. A gap touching ANY D-038 criterion may be confidence-tagged but NEVER dropped from gaps.
TRUST-BOUNDARY + ENUM SWEEP (harvested: gstack review/checklist.md, MIT; re-derived for our stack per G5): LLM/agent-produced values persisted to SurrealDB or rendered without shape/format validation = gap (D-026: retrieved content is DATA, never instructions); a NEW enum/status/tier value must be traced through EVERY consumer — Grep the sibling values, READ each switch/filter/render, including code OUTSIDE the diff; ts-ignore/svelte-ignore/eslint-disable added without written justification = gap.
SUPPRESSION (G2): dismissing a finding as a known-good pattern is allowed ONLY by citing an operator-locked (🔒) DESIGN-SYSTEM/DECISIONS rule, and every suppression MUST be logged in the verdict ("suppressed: <finding> per <🔒 source>"). Set each criterion true only if independently verified; passed = all six. List concrete gaps (file:line). Clean up any probe rows you create. End the verdict with ONE synthesis line (harvested: gstack codex/SKILL.md, MIT): "Recommendation: <action> because <reason naming the most actionable gap>". Final message IS the REVIEW verdict.`

const stopRegex=/\b(CONFLICT|BLOCK(?:ED|ER)?|cannot proceed|hard stop)\b/i
const results=[]
for (const t of args.tasks){
  phase(`${t.id} ${t.title}`)
  const b=await agent(`${BUILD_PRE}\n\n${t.build}`, OPTS({label:`${t.id} ${t.title}`, phase:`${t.id} ${t.title}`, schema:BUILD}))
  if(!b||b.verifyPassed===false||(b.deviation&&stopRegex.test(b.deviation)))
    return {stoppedAt:`${t.id} build`, results:[...results,{build:b}]}

  phase(`${t.id} review`)
  let r=await agent(`${REVIEW_PRE}\n\nFEATURE: ${t.id} ${t.title}. Builder files: ${(b.filesChanged||[]).join(', ')} (commit ${b.commitSha}); claimed lintClean=${b.lintClean}, liveVerified=${b.liveVerified}${b.liveVerified?'':` (reason: ${b.liveVerifyReason})`}. Builder claim: ${b.summary}\n\nIndependently certify against the six D-038 criteria now.`, OPTS({label:`${t.id} DoD-review`, phase:`${t.id} review`, schema:REVIEW}))

  // bounded fix-loop: review FAIL → fix agent gets the reviewer's gaps → fresh re-review
  const fixes=[]
  let attempt=0
  while(r && r.passed===false && attempt<MAX_FIX){
    attempt++
    log(`${t.id} review FAILED — fix attempt ${attempt}/${MAX_FIX}`)
    phase(`${t.id} fix-${attempt}`)
    // A5 (HARVEST-GSTACK Lane A-docs): AUTO-FIX vs ASK triage — G3-bounded (routing only; reviewer never edits; every fix re-reviewed by the loop below).
    const f=await agent(`You are a FIX agent. ${COMMON} Feature ${t.id} ${t.title} (commit ${b.commitSha}) FAILED its independent D-038 DoD-review. Fix the cited defects ONLY — no rebuild, no scope creep. TRIAGE (harvested: gstack review/checklist.md Fix-First heuristic, MIT; G3-bounded): classify each gap MECHANICAL (a senior engineer would apply it without discussion — dead code, missing validation guard, token/path/version mismatch, stale comment) vs JUDGMENT (security, race conditions, design decisions, fixes >20 lines, removing functionality, anything changing user-visible behavior). At most 3 gaps may be fixed as straight mechanical fixes; every other gap gets the full ROOT-CAUSE treatment (reproduce it; do not guess-fix); state the actual root cause in your summary. A JUDGMENT gap that needs a product decision is a STOP-and-report deviation, not a guess. LOW-confidence (taste) design findings are advisory — do NOT fix them on your own judgment (G3). You fix, you never self-certify — every fix goes to a fresh independent re-review; do not mark gaps resolved yourself. Add a regression test per defect.\n\nREVIEW VERDICT:\n${r.verdict}\n\nGAPS:\n${(r.gaps||[]).map((g,i)=>`${i+1}. ${g}`).join('\n')}\n\nHARD GATE then bounded live verify of the fixed behavior. Commit atomically: git add -A && git commit -m "fix(v2): ${t.id} ${t.title} — <root cause one-liner>" (blank line) "Co-Authored-By: Claude <noreply@anthropic.com>". Final message IS the BUILD verdict.`, OPTS({label:`${t.id} fix-${attempt}`, phase:`${t.id} fix-${attempt}`, schema:BUILD}))
    fixes.push(f)
    if(!f||f.verifyPassed===false) return {stoppedAt:`${t.id} fix-${attempt}`, results:[...results,{build:b,review:r,fixes}]}
    phase(`${t.id} re-review-${attempt}`)
    r=await agent(`${REVIEW_PRE}\n\nFEATURE: ${t.id} ${t.title} — RE-REVIEW after fix attempt ${attempt}. Original commit ${b.commitSha}; fix commit ${f.commitSha} (files: ${(f.filesChanged||[]).join(', ')}). PRIOR FAIL verdict: ${String(r.verdict).slice(0,1500)}\n\nFixer claim: ${f.summary}\n\nVerify each previously-cited gap is GENUINELY resolved (not papered over), then re-certify ALL six D-038 criteria.`, OPTS({label:`${t.id} re-review-${attempt}`, phase:`${t.id} re-review-${attempt}`, schema:REVIEW}))
  }

  results.push({build:b, review:r, fixes})
  if(!r||r.passed===false) return {stoppedAt:`${t.id} DoD-review (after ${attempt} fix attempts)`, results}
}

if(args.pushAtEnd!==false){
  phase('push')
  await agent(`Run exactly: cd ${WT} && git status --short && git push origin v2. Confirm the push output. If the tree is dirty, report what is dirty and push anyway (committed work only goes up). No other actions.`, OPTS({label:'push v2', phase:'push'}))
}
return {stoppedAt:null, complete:true, results}
