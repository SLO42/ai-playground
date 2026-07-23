#!/usr/bin/env node
// Claude Code statusline for ai-playground (Atelier).
// Reads the statusline JSON Claude Code pipes on stdin and renders ONE honest,
// dev-useful line. Every signal is a live source; anything unreadable renders
// as an explicit unknown/omission, never a fabricated value (F-008 spirit).
//
// Segments (left→right, most-actionable first):
//   ▊ Atelier
//   <model display> <model-id>                 exact model from stdin (no guessing)
//   ⎇ <branch> ↑<unpushed> ✎<dirty>            THIS repo (docs, v2-main): push + WIP discipline
//   <chain state>                              live from docs/BUILD-QUEUE.md
//   v2 <tip> <clean|⚠N dirty>                  the CODE worktree — ⚠ = uncommitted work = F-007 loss risk
//   ✎<n>F                                       fails.md open-count (situational awareness)
//   $<cost> +<add>/-<del>                      this session's spend + churn
//
// Git calls are cheap/local and each guarded; the statusline never throws.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const R = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const PURPLE = '\x1b[35m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const ORANGE = '\x1b[38;5;208m';

const REPO = path.join(__dirname, '..', '..');          // docs repo root (v2-main)
const V2_WORKTREE = path.join(REPO, '..', 'ai-playground-v2'); // code worktree (v2)

function git(args, cwd) {
  try {
    return execSync(`git ${args}`, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500,
    }).trim();
  } catch (e) { return null; }
}

// --- stdin JSON from Claude Code (exact model + session cost/churn) ---------
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf-8')); } catch (e) { /* honest unknowns below */ }

const modelName = (input.model && (input.model.display_name || input.model.id)) || 'model unknown';
const modelId = (input.model && input.model.id) || '';
const cost = input.cost && input.cost.total_cost_usd;
const linesAdded = input.cost && input.cost.total_lines_added;
const linesRemoved = input.cost && input.cost.total_lines_removed;

// --- THIS repo: branch + unpushed + dirty -----------------------------------
function localRepo() {
  const branch = git('branch --show-current', REPO);
  if (!branch) return '';
  let seg = `${BLUE}⎇ ${branch}${R}`;
  const ahead = git(`rev-list --count origin/${branch}..HEAD`, REPO);
  if (ahead && ahead !== '0') seg += ` ${YELLOW}↑${ahead}${R}`;      // unpushed — push it (devlog rule)
  const dirty = git('status --porcelain', REPO);
  const n = dirty ? dirty.split('\n').filter(Boolean).length : 0;
  if (n) seg += ` ${DIM}✎${n}${R}`;
  return seg;
}

// --- Atelier wave-chain state from BUILD-QUEUE.md ----------------------------
function atelierChain() {
  try {
    const rows = fs.readFileSync(path.join(REPO, 'docs', 'BUILD-QUEUE.md'), 'utf-8').split('\n')
      .map(l => l.match(/^\|\s*(done|running|queued|paused|ready|blocked|partial)\s*\|\s*([^|]+?)\s*\|/))
      .filter(Boolean);
    const first = (s) => rows.find(r => r[1] === s);
    const count = (s) => rows.filter(r => r[1] === s).length;

    const running = first('running');
    const paused = first('paused');
    let state;
    if (running) state = `${GREEN}▶ ${running[2]}${R}`;
    else if (paused) state = `${YELLOW}⏸ ${paused[2]}${R}`;
    else state = `${DIM}chain idle${R}`;

    const extras = [];
    const q = count('queued'), g = count('ready'), b = count('blocked');
    if (q) extras.push(`${q}q`);
    if (g) extras.push(`${g}g`);
    if (b) extras.push(`${RED}${b}b${R}${DIM}`);
    return extras.length ? `${state} ${DIM}${extras.join(' ')}${R}` : state;
  } catch (e) { return `${DIM}queue unreadable${R}`; }
}

// --- v2 CODE worktree: tip + uncommitted-work warning (F-007) ----------------
function v2Worktree() {
  if (!fs.existsSync(V2_WORKTREE)) return '';
  const tip = git('rev-parse --short HEAD', V2_WORKTREE);
  if (!tip) return '';
  const dirty = git('status --porcelain', V2_WORKTREE);
  const n = dirty ? dirty.split('\n').filter(Boolean).length : 0;
  const ahead = git('rev-list --count origin/v2..HEAD', V2_WORKTREE);
  let seg = `${DIM}v2${R} ${CYAN}${tip}${R}`;
  if (ahead && ahead !== '0') seg += ` ${YELLOW}↑${ahead}${R}`;       // built but unpushed
  seg += n ? ` ${ORANGE}⚠${n} dirty${R}` : ` ${DIM}✓${R}`;            // ⚠ uncommitted = loss risk
  return seg;
}

// --- fails.md open-count (situational) --------------------------------------
function failsCount() {
  try {
    const txt = fs.readFileSync(path.join(REPO, 'docs', 'fails.md'), 'utf-8');
    const m = txt.match(/^#{1,4}\s*F-\d+/gm);
    return m ? `${DIM}${m.length}F${R}` : '';
  } catch (e) { return ''; }
}

// --- session cost + churn ---------------------------------------------------
function sessionSeg() {
  const bits = [];
  if (typeof cost === 'number') bits.push(`$${cost.toFixed(2)}`);
  if (typeof linesAdded === 'number' || typeof linesRemoved === 'number') {
    bits.push(`${GREEN}+${linesAdded || 0}${R}${DIM}/${RED}-${linesRemoved || 0}${R}${DIM}`);
  }
  return bits.length ? `${DIM}${bits.join(' ')}${R}` : '';
}

// --- render -----------------------------------------------------------------
const modelPart = `${BOLD}${PURPLE}${modelName}${R}` +
  (modelId && modelId !== modelName ? ` ${DIM}${modelId}${R}` : '');

const parts = [
  `${BOLD}${CYAN}▊ Atelier${R}`,
  modelPart,
  localRepo(),
  atelierChain(),
  v2Worktree(),
  failsCount(),
  sessionSeg(),
].filter(Boolean);

console.log(parts.join(`  ${DIM}│${R}  `));
