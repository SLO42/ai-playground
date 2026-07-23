#!/usr/bin/env node
// Claude Code statusline for ai-playground (Atelier).
// Reads the statusline JSON Claude Code pipes on stdin (model, cost, workspace)
// and renders ONE honest line:
//   ▊ Atelier │ <model> <model-id> │ ⎇ <branch> │ <chain state from BUILD-QUEUE> │ $<session cost>
// Chain state is parsed live from docs/BUILD-QUEUE.md — the wave chain's single
// source of truth (kept out of the dev DB by design). No fabricated metrics:
// anything unreadable renders as an explicit unknown, never a guess (F-008).

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

// --- stdin JSON from Claude Code (exact model + session cost) ---------------
let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf-8'));
} catch (e) { /* run outside Claude Code: fall through to honest unknowns */ }

const modelName = (input.model && (input.model.display_name || input.model.id)) || 'model unknown';
const modelId = (input.model && input.model.id) || '';
const cost = input.cost && input.cost.total_cost_usd;

// --- git branch (of this repo, regardless of session cwd) -------------------
let branch = '';
try {
  branch = execSync('git branch --show-current 2>NUL', { encoding: 'utf-8', cwd: __dirname }).trim();
} catch (e) { /* no branch shown */ }

// --- Atelier wave-chain state from BUILD-QUEUE.md ---------------------------
function atelierStatus() {
  try {
    const qPath = path.join(__dirname, '..', '..', 'docs', 'BUILD-QUEUE.md');
    const rows = fs.readFileSync(qPath, 'utf-8').split('\n')
      .map(l => l.match(/^\|\s*(done|running|queued|paused|ready|blocked|partial)\s*\|\s*([^|]+?)\s*\|/))
    .filter(Boolean);
    const first = (s) => rows.find(r => r[1] === s);
    const count = (s) => rows.filter(r => r[1] === s).length;

    const running = first('running');
    const paused = first('paused');

    // Priority: an actively running or operator-paused wave IS the chain state;
    // blocked rows are typically awaiting operator input and show as a count.
    let state;
    if (running) state = `${GREEN}▶ running ${running[2]}${R}`;
    else if (paused) state = `${YELLOW}⏸ paused @ ${paused[2]}${R}`;
    else state = `${DIM}chain idle${R}`;

    const queued = count('queued');
    const opGated = count('ready');
    const blocked = count('blocked');
    const extras = [];
    if (queued) extras.push(`${queued} queued`);
    if (opGated) extras.push(`${opGated} op-gate`);
    if (blocked) extras.push(`${RED}${blocked} blocked${R}${DIM}`);
    return extras.length ? `${state} ${DIM}(${extras.join(' · ')})${R}` : state;
  } catch (e) {
    return `${DIM}queue unreadable${R}`;
  }
}

// --- render -----------------------------------------------------------------
const modelPart = `${BOLD}${PURPLE}${modelName}${R}` +
  (modelId && modelId !== modelName ? ` ${DIM}${modelId}${R}` : '');

const parts = [
  `${BOLD}${CYAN}▊ Atelier${R}`,
  modelPart,
  branch ? `${BLUE}⎇ ${branch}${R}` : '',
  atelierStatus(),
  typeof cost === 'number' ? `${DIM}$${cost.toFixed(2)}${R}` : '',
].filter(Boolean);

console.log(parts.join(`  ${DIM}│${R}  `));
