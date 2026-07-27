/* ============================================================================
   /claude-code — SESSION FLEET filter + collapse controls (static source gate).

   Operator ask (2026-07-26): *"the session fleet for claude code section should be
   filterable by project, failure, or collapseable. to keep the page from getting to
   tall."*

   The DECISION logic is unit-tested (`fleet-view.test.ts`) and pinned to live rows
   (`fleet-filter.live.test.ts`). What a pure test cannot see is whether the PAGE wires
   those decisions to accessible, honest controls — that is what this source gate locks,
   in the same convention as `transcript-link.test.ts` / the route-head-a11y set:

     1. the collapse control is a REAL <button> with aria-expanded + aria-controls
        (not a styled div), and the region it names actually exists;
     2. the always-visible head keeps the window-wide running/failed counts OUTSIDE the
        collapsible region — collapsing must never hide that something failed;
     3. the state chips are real buttons with aria-pressed, and a 0-count option is
        disabled rather than silently dead;
     4. the project filter is a real labelled <select>;
     5. the rows iterate the FILTERED set, and the filtered-empty case renders its own
        honest copy, distinct from "no sessions exist" (F-008);
     6. the window bound is disclosed, and comes from the shared FLEET_LIMIT, not a
        hardcoded number;
     7. no `outline: none`, and the chevron motion is reduced-motion guarded.

   The live render is verified in-browser at the end-gate.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// F-054: the editor may write CRLF here; normalize so every regex below is EOL-agnostic.
const src = readFileSync(join(HERE, '+page.svelte'), 'utf8').replace(/\r\n/g, '\n');
const loader = readFileSync(join(HERE, '+page.server.ts'), 'utf8').replace(/\r\n/g, '\n');

/** The fleet <section> … the transcript panel that follows it. */
const fleetSection = (() => {
  const start = src.indexOf('<section class="card fleet"');
  expect(start, 'the fleet section must exist').toBeGreaterThan(-1);
  const end = src.indexOf('<!-- ── TASK (transcript-panel)', start);
  expect(end, 'the fleet section must be followed by the transcript panel').toBeGreaterThan(start);
  return src.slice(start, end);
})();

/** The always-visible head (before the collapsible body opens). */
const fleetHead = fleetSection.slice(
  fleetSection.indexOf('<div class="fleet-head">'),
  fleetSection.indexOf('<div id="fleet-body"')
);

describe('collapse — a real, accessible disclosure', () => {
  it('is a <button type="button"> with aria-expanded bound to the view (never a styled div)', () => {
    expect(fleetHead).toMatch(/<button\s+class="fleet-toggle"/);
    expect(fleetHead).toMatch(/type="button"/);
    expect(fleetHead).toMatch(/aria-expanded=\{fleetView\.open\}/);
    // Not a div/span pretending to be a control.
    expect(fleetHead).not.toMatch(/<(div|span)[^>]*onclick=/);
  });

  it('aria-controls names a region that really exists in the DOM at all times', () => {
    expect(fleetHead).toMatch(/aria-controls="fleet-body"/);
    // The container is unconditional; only its CONTENTS are conditional — so aria-controls
    // never dangles while collapsed.
    expect(fleetSection).toMatch(/<div id="fleet-body" class="fleet-body">/);
    const bodyOpen = fleetSection.indexOf('<div id="fleet-body"');
    expect(fleetSection.slice(bodyOpen, bodyOpen + 200)).toMatch(/\{#if !fleetView\.open\}/);
  });

  it('toggling writes through the ONE view setter (URL-mirrored, so it survives a reload)', () => {
    expect(fleetHead).toMatch(/onclick=\{\(\) => setFleetView\(\{ open: !fleetView\.open \}\)\}/);
    expect(src).toMatch(/let fleetView = \$state<FleetView>\(parseFleetView\(page\.url\.searchParams\)\)/);
    expect(src).toMatch(/replaceState\(url, page\.state\)/);
  });

  it('the collapsed state still says how much is hidden, and what is filtering', () => {
    expect(fleetSection).toMatch(/class="fleet-collapsed[^"]*"/);
    expect(fleetSection).toMatch(/session\{fleet\.length === 1 \? '' : 's'\} hidden/);
    // With a filter engaged the collapsed line reports the FILTERED count too, so "hidden"
    // never silently means a different number than the expanded list would show.
    expect(fleetSection).toMatch(
      /\{#if fleetFilterSummary\}\{visibleFleet\.length\} of \{fleet\.length\} sessions hidden/
    );
  });

  it('the heading names the REAL scope, not a hardcoded "all projects" (live-verified defect)', () => {
    // The heading IS the disclosure's accessible name — with a project filter engaged it must not
    // still announce the whole portfolio. Composed by the pure `fleetScopeLabel`.
    expect(fleetHead).toMatch(/session fleet · \{fleetScope\}/);
    expect(fleetHead).not.toMatch(/session fleet · all projects/);
    expect(src).toMatch(
      /const fleetScope = \$derived\(fleetScopeLabel\(fleetView, fleetResolved\.projectOptions\)\)/
    );
  });

  it('window-wide running/failed counts stay in the ALWAYS-VISIBLE head (F-008)', () => {
    // A collapse that hides a failure count would make the section lie by omission.
    expect(fleetHead).toMatch(/\{running\.length\} running/);
    expect(fleetHead).toMatch(/fleetWindowCounts\.failed > 0/);
    expect(fleetHead).toMatch(/class="count-failed"/);
  });

  it('those window-wide counts QUALIFY themselves once the heading is project-scoped', () => {
    // REGRESSION: the heading became project-scoped while the counts beside it stayed window-wide
    // and unlabelled, so one head made two contradicting claims (`bepinexpack_rounds_port` next to
    // `40 recent · 32 failed` over 4 rows). The counts stay window-wide — they now say so.
    expect(fleetHead).toMatch(/\{#if fleetCountScope\}<span\s+class="count-scope"/);
    expect(src).toMatch(/const fleetCountScope = \$derived\(fleetCountScopeNote\(fleetView\)\)/);
    // CAUGHT IN THE BROWSER: Svelte trims a text node's leading whitespace at an element
    // boundary, so a plain space inside the span rendered `32 failedacross all projects`. The
    // separator must be a literal `&nbsp;` — the same fix `.count-failed` above already carries.
    expect(fleetHead).toMatch(/class="count-scope"\s*>&nbsp;\{fleetCountScope\}/);
    // It lives INSIDE the same `.count` element as the numbers it qualifies — never as a separate
    // fact elsewhere in the head, and never inside the toggle, where it would corrupt the
    // disclosure's accessible name (which `fleetScope` alone owns).
    const countEl = fleetHead.slice(fleetHead.indexOf('<span class="count mono">'));
    expect(countEl).toMatch(/class="count-scope"/);
    const toggle = fleetHead.slice(
      fleetHead.indexOf('<button'),
      fleetHead.indexOf('<span class="count mono">')
    );
    expect(toggle).not.toMatch(/count-scope/);
  });
});

describe('filters — real data, real counts, no dead option', () => {
  it('state chips are real buttons with aria-pressed and their live count', () => {
    expect(fleetSection).toMatch(/role="group" aria-label="Filter sessions by state"/);
    expect(fleetSection).toMatch(/\{#each FLEET_STATE_FILTERS as st \(st\)\}/);
    expect(fleetSection).toMatch(/aria-pressed=\{active\}/);
    expect(fleetSection).toMatch(/\{@const n = fleetResolved\.stateCounts\[st\]\}/);
    expect(fleetSection).toMatch(/class="chip-n mono">\{n\}/);
  });

  it('a 0-count chip is disabled — never an option that cannot match', () => {
    // …except the ACTIVE one, which must stay clickable so the operator can un-set it.
    expect(fleetSection).toMatch(/disabled=\{n === 0 && !active\}/);
  });

  it('each chip discloses its honest predicate (what "failed" actually means here)', () => {
    expect(fleetSection).toMatch(/title=\{FLEET_STATE_HINTS\[st\]\}/);
  });

  it('the project filter is a real labelled <select> driven by derived options', () => {
    expect(fleetSection).toMatch(/<label class="filter-project">/);
    expect(fleetSection).toMatch(/<span class="filter-label">project<\/span>/);
    expect(fleetSection).toMatch(/<select/);
    expect(fleetSection).toMatch(/\{#each fleetResolved\.projectOptions as o \(o\.value\)\}/);
    // Options carry their real count; a stale selection is labelled, not hidden.
    expect(fleetSection).toMatch(/\(\{o\.count\}\)\{o\.stale \? ' — none in view' : ''\}/);
  });

  it('a clear-filters escape hatch appears exactly when a filter is engaged', () => {
    expect(fleetSection).toMatch(/\{#if fleetFiltered\}/);
    expect(fleetSection).toMatch(/onclick=\{\(\) => setFleetView\(\{ project: null, state: 'all' \}\)\}/);
  });
});

describe('honesty — the rows, the empties, and the window bound', () => {
  it('the row list iterates the FILTERED set (not the raw fleet)', () => {
    expect(fleetSection).toMatch(/\{#each visibleFleet as s \(s\.id\)\}/);
    expect(fleetSection).not.toMatch(/\{#each \[\.\.\.running, \.\.\.recent\] as s/);
  });

  it('filtered-empty has its OWN copy, distinct from "no sessions exist"', () => {
    expect(fleetSection).toMatch(/\{:else if fleetResolved\.filteredEmpty\}/);
    expect(fleetSection).toMatch(/No session in this window matches/);
    expect(fleetSection).toMatch(/No sessions across the portfolio yet/);
    // A stale/out-of-window project says WHY the list is empty.
    expect(fleetSection).toMatch(/\{#if fleetResolved\.staleProject\}/);
  });

  it('the window bound is disclosed and comes from the SHARED limit, not a magic number', () => {
    expect(fleetSection).toMatch(/showing \{visibleFleet\.length\} of \{fleet\.length\}/);
    expect(fleetSection).toMatch(/window = newest \{fleetLimit\} sessions/);
    expect(src).toMatch(/const fleetLimit = \$derived\(data\.fleetLimit \?\? fleet\.length\)/);
    // The loader passes the same shared constant to the read model.
    expect(loader).toMatch(/import \{ FLEET_LIMIT \} from '\.\/fleet-view'/);
    expect(loader).toMatch(/listFleetAcrossProjects\(db, FLEET_LIMIT\)/);
    expect(loader).not.toMatch(/listFleetAcrossProjects\(db, \d+\)/);
  });

  it('opening a transcript preserves the active filter in the URL', () => {
    expect(src).toMatch(/function transcriptHref\(sessionId: string\): string/);
    expect(fleetSection).toMatch(/href=\{transcriptHref\(s\.id\)\}/);
  });
});

describe('a11y + tokens on the new controls', () => {
  it('no outline:none anywhere on the page, and every new control has a focus ring', () => {
    expect(src).not.toMatch(/outline:\s*none/);
    for (const sel of ['.fleet-toggle:focus-visible', '.chip:focus-visible', '.filter-project select:focus-visible']) {
      expect(src, `${sel} must define a visible focus ring`).toContain(sel);
    }
  });

  it('the chevron motion is reduced-motion guarded', () => {
    expect(src).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.chev \{\s*transition: none;/);
  });

  it('the new control styles use design tokens, never hardcoded hex/rgb colours', () => {
    const start = src.indexOf('.fleet-toggle {');
    const end = src.indexOf('.fleet-rows {');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/\brgba?\(/);
    expect(block).toMatch(/var\(--color-/);
  });

  it('the collapse control is wrapped in a heading — collapsing costs no document structure', () => {
    expect(fleetHead).toMatch(/<h2 class="fleet-h">\s*<button/);
  });
});
