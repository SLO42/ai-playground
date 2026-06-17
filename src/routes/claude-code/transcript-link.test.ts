/* ============================================================================
   ai-playground v2 — TV-1: fleet-row transcript affordance (static source gate)
   The backend (load reads transcript+sessionMeta for ?session=<id>) and the
   <SessionTranscript> render already exist; the ONLY gap TV-1 closes is that the
   TASK 9.3 fleet rows had no way to OPEN a session's transcript — the operator
   had to hand-edit the URL. These gates lock the affordance:
     1. each fleet row exposes a navigation to /claude-code?session=<that id>
        via an accessible <a href> (keyboard-focusable + Enter/Space-activatable
        natively), NOT a bare onclick on a div;
     2. the link carries an explicit accessible name (aria-label View transcript…);
     3. the currently-selected row (selectedSession === row.id) gets a clear
        active state (the `selected` class + aria-current on the link);
     4. the transcript link is NOT wrapped around the per-row control buttons
        (no interactive nesting — the controls stay in their own .sess-controls).
   Static source check (matches the route-head-a11y / page-tokens convention);
   the live render is verified in-browser at the end-gate.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, '+page.svelte');
const src = readFileSync(PAGE, 'utf8');

/** The fleet-row <li> … </li> block (the `{#each [...running, ...recent]}` body). */
function fleetRowBlock(s: string): string {
  const start = s.indexOf('<li class="fleet-row"');
  expect(start, 'fleet-row <li> must exist').toBeGreaterThan(-1);
  const end = s.indexOf('</li>', start);
  expect(end, 'fleet-row <li> must close').toBeGreaterThan(start);
  return s.slice(start, end + '</li>'.length);
}

describe('TV-1 — fleet rows open a session transcript', () => {
  const row = fleetRowBlock(src);

  it('each row navigates to /claude-code?session=<id> via an <a href> (not a div onclick)', () => {
    // A real anchor with the session id encoded into the query — keyboard-focusable
    // and Enter-activatable for free (no synthetic key handling needed).
    expect(row).toMatch(/<a[^>]*href=\{`\/claude-code\?session=\$\{encodeURIComponent\(s\.id\)\}`\}/);
    // The affordance is NOT a bare div/span onclick masquerading as a button.
    expect(row).not.toMatch(/<(div|span)[^>]*onclick=/);
  });

  it('the transcript link carries an explicit accessible name', () => {
    expect(row).toMatch(/class="[^"]*transcript-link[^"]*"/);
    expect(row).toMatch(/aria-label=\{`View transcript for session/);
  });

  it('the selected row gets a clear active state', () => {
    // The active class is driven by selectedSession === row.id (no fabricated state),
    expect(src).toMatch(/\{@const isSelected = selectedSession === s\.id\}/);
    expect(row).toMatch(/class:selected=\{isSelected\}/);
    // …and the link is marked aria-current for AT users.
    expect(row).toMatch(/aria-current=\{isSelected \? 'true' : undefined\}/);
    // The active state must be a real style rule (tokens only — gated separately by
    // the contrast set; here we just assert the rule exists).
    expect(src).toMatch(/\.fleet-row\.selected\s*\{/);
  });

  it('both running AND ended sessions are linkable (link is outside the isRunning branch)', () => {
    // The link lives in .fleet-main (always rendered), not inside the {#if isRunning}
    // control branch — so an ended session with a persisted transcript opens fine.
    const main = row.slice(row.indexOf('<div class="fleet-main">'), row.indexOf('<div class="sess-controls">'));
    expect(main).toMatch(/transcript-link/);
  });

  it('no interactive nesting — the control buttons are NOT inside the transcript link', () => {
    // The link must close before the controls open: a <button> nested in an <a> is an
    // a11y defect (interactive nesting). Assert the controls block sits outside the link.
    const linkOpen = row.indexOf('class="sess-id mono transcript-link"');
    const linkClose = row.indexOf('</a', linkOpen);
    const controls = row.indexOf('class="sess-controls"');
    expect(linkOpen).toBeGreaterThan(-1);
    expect(linkClose).toBeGreaterThan(linkOpen);
    expect(controls).toBeGreaterThan(linkClose);
  });
});
