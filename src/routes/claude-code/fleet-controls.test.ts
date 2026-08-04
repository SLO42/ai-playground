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

  it('the collapsed line is COMPOSED, not counted inline — its numbers are asserted semantically', () => {
    expect(fleetSection).toMatch(/class="fleet-collapsed[^"]*"/);
    // REGRESSION (live-measured 2026-08-04): this line used to inline
    // `{visibleFleet.length} of {fleet.length} sessions hidden`, which states the MATCHING count
    // as the HIDDEN count — collapsing hides every loaded row, filtered or not. Its only coverage
    // was a source-text mirror of that exact template, so the suite green-locked the inversion
    // through two reviews. A regex cannot tell 32 from 40; the sentence now comes from the pure
    // `fleetCollapsedSummary`, whose numbers ARE checked by arithmetic in fleet-view.test.ts.
    expect(fleetSection).toMatch(/<p class="fleet-collapsed mono">\{fleetCollapsed\}<\/p>/);
    expect(src).toMatch(
      /const fleetCollapsed = \$derived\(\s*fleetCollapsedSummary\(fleet\.length, visibleFleet\.length, fleetFilterSummary\)\s*\)/
    );
    // No count arithmetic may creep back into the collapsed paragraph itself.
    const collapsed = fleetSection.slice(
      fleetSection.indexOf('{#if !fleetView.open}'),
      fleetSection.indexOf('{:else}', fleetSection.indexOf('{#if !fleetView.open}'))
    );
    expect(collapsed).not.toMatch(/\{fleet\.length\}|\{visibleFleet\.length\}/);
    expect(collapsed).not.toMatch(/\d+\s+of\s+|of \{/);
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

  it('a 0-count NARROWING chip is disabled — never an option that cannot match', () => {
    // …except the ACTIVE one, and except `all`. REGRESSION (live-verified 2026-07-26): the rule
    // was a bare `n === 0 && !active`, which disabled the WIDEN action exactly in the dead end
    // (`?fleetProject=project:ghost&fleetState=failed` → every chip disabled but `failed`). The
    // three rules now live in the pure, unit-tested `isFleetStateChipDisabled`.
    expect(fleetSection).toMatch(/disabled=\{isFleetStateChipDisabled\(st, n, active\)\}/);
    expect(fleetSection).not.toMatch(/disabled=\{n === 0 && !active\}/);
  });

  it('each chip discloses its honest predicate, SCOPED to the project its badge counts under', () => {
    // REGRESSION: the static hint claimed "every session in the window" beside a badge of 0 while
    // the window held 40 — the badge is project-scoped (`fleetStateCounts(fleet, view.project)`)
    // and the prose was not, so one control made two contradicting claims (F-008).
    expect(fleetSection).toMatch(/title=\{fleetStateHint\(st, fleetChipScope\)\}/);
    expect(src).toMatch(
      /const fleetChipScope = \$derived\(fleetView\.project \? fleetScope : null\)/
    );
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

describe('the view survives the page\'s OWN live stream (live-verified DEFECT)', () => {
  /* REGRESSION. Measured on :5174: click `failed`, collapse → `?fleetState=failed&fleet=closed`,
     aria-expanded=false, 0 rows. One `invalidate('app:fleet')` — which the `session` onDbChange
     below fires on EVERY session row change — and the same URL rendered aria-expanded=true with
     40 rows. The re-seed effect parsed a `page.url` that `replaceState` never wrote.

     The page must therefore NOT re-parse `page.url` unconditionally; it delegates to the pure
     `reseedFleetView`, whose own contract is pinned in fleet-view.test.ts. */
  const reseedEffect = (() => {
    const i = src.indexOf('let fleetSeedHref');
    expect(i, 'the page must record the href it last seeded from').toBeGreaterThan(-1);
    return src.slice(i, src.indexOf('/** Mirror the view into the address bar.'));
  })();

  it('the re-seed goes through the pure rule, not a raw re-parse of page.url', () => {
    expect(reseedEffect).toMatch(
      /reseedFleetView\(\s*fleetSeedHref,\s*page\.url,\s*untrack\(\(\) => fleetView\),\s*navigated\s*\)/
    );
    // The exact shape that shipped the defect: an unconditional parse of the republished URL
    // inside the effect.
    expect(reseedEffect).not.toMatch(/const parsed = parseFleetView\(page\.url\.searchParams\)/);
  });

  it('the recorded href is advanced on every run, so one navigation re-seeds exactly once', () => {
    expect(reseedEffect).toMatch(/fleetSeedHref = decision\.href/);
    expect(reseedEffect).toMatch(/if \(decision\.view\) fleetView = decision\.view/);
  });

  it('the seed bookkeeping is NOT reactive state — it is never a render input', () => {
    expect(src).toMatch(/let fleetSeedHref = page\.url\.href;/);
    expect(src).not.toMatch(/fleetSeedHref = \$state/);
  });

  it('the live invalidate that exposed it is still wired (the fix must not have removed it)', () => {
    expect(src).toMatch(/onDbChange\('session', \(\) => void invalidate\('app:fleet'\)\)/);
  });

  it('the initial seed still comes from the URL, so a shared/reloaded link restores the view', () => {
    expect(src).toMatch(
      /let fleetView = \$state<FleetView>\(parseFleetView\(page\.url\.searchParams\)\)/
    );
  });
});

describe('…and a SAME-HREF navigation still re-seeds (the regression the href-only rule shipped)', () => {
  /* REGRESSION, measured on :5174 after the fix above landed: load /claude-code, click `failed`
     (replaceState writes the address bar, never `page.url`), then click the sidebar self-link
     `a[href="/claude-code"]`. Kit really navigates, `page.url.href` equals the seeded href, so the
     href-only rule adopted nothing — the address bar lost its params while `failed 32` stayed
     pressed over 32 rows, and a reload silently swung it to 40.

     Advancing the seed inside `syncFleetUrl` would re-open the wipe above (an invalidate
     re-publishes the ORIGINAL bare href), so the page needs a SECOND, independent signal. It is
     `afterNavigate`, which in kit 2.63.0 fires only from the hydration path (client.js:724) and
     the tail of `navigate()` (client.js:1987) — never from `_invalidate` (client.js:405-488) and
     never from `replaceState` (client.js:2489-2521). */
  const reseedEffect = src.slice(
    src.indexOf('let fleetSeedHref'),
    src.indexOf('/** Mirror the view into the address bar.')
  );

  it('the page imports the ONE kit hook that fires for navigations and not for invalidates', () => {
    expect(src).toMatch(/import \{[^}]*\bafterNavigate\b[^}]*\} from '\$app\/navigation'/);
  });

  it('a navigation bumps a monotonic epoch — the effect input the href cannot supply', () => {
    expect(src).toMatch(/let fleetNavEpoch = \$state\(0\)/);
    expect(src).toMatch(/afterNavigate\(\(\) => \{\s*fleetNavEpoch \+= 1;\s*\}\)/);
  });

  it('the epoch is compared against a NON-reactive seeded counter, never a render input', () => {
    expect(src).toMatch(/let fleetSeededNav = 0;/);
    expect(src).not.toMatch(/fleetSeededNav = \$state/);
    expect(reseedEffect).toMatch(/const navigated = fleetNavEpoch !== fleetSeededNav;/);
  });

  it('the navigation is CONSUMED once, so the next invalidate storm reads as a re-publish', () => {
    // Without this line the flag would stay TRUE forever after the first navigation, and every
    // subsequent `invalidate('app:fleet')` would re-seed — i.e. the original wipe, restored.
    expect(reseedEffect).toMatch(/fleetSeededNav = fleetNavEpoch;/);
  });
});

describe('…and the PAGE, not kit, owns URL/UI agreement (the abort-path regression)', () => {
  /* `afterNavigate` is a SOUND NEGATIVE and an INCOMPLETE POSITIVE: kit 2.63.0 `navigate()`
     commits the address bar (client.js:1833-1834) and `page.url` (:1894-1896), awaits settled + 2
     ticks (:1921-1926), then aborts at :1929-1932 — before the `afterNavigate` fire at :1987.
     `_invalidate` bumps that token (:413) and this page invalidates on every session row, so a
     navigation can commit BOTH and never signal. MEASURED on :5174: `failed` engaged (32 rows,
     `?fleetState=failed`) + a same-href goto racing one invalidate ⇒ bare address bar, `failed 32`
     still pressed. The decision logic cannot see that; the mirror re-assert is what closes it, so
     the WIRING of that re-assert is pinned here (its behaviour is in fleet-view.test.ts). */
  const reseedEffect = src.slice(
    src.indexOf('$effect(() => {\n    const navigated'),
    src.indexOf('/**\n   * Re-assert the URL mirror')
  );
  const reassert = src.slice(
    src.indexOf('function reassertFleetUrl'),
    src.indexOf('/** Mirror the view into the address bar.')
  );

  it('the effect re-asserts the mirror after the re-seed decision has settled', () => {
    // AFTER the adopt, or it would mirror the pre-navigation view and then be overwritten.
    expect(reseedEffect).toMatch(/if \(decision\.view\) fleetView = decision\.view;\s*(\/\/[^\n]*\n\s*)*untrack\(\(\) => reassertFleetUrl\(\)\);/);
  });

  it('the re-assert is UNTRACKED — it must never become a dependency of its own effect', () => {
    expect(reseedEffect).toMatch(/untrack\(\(\) => reassertFleetUrl\(\)\)/);
  });

  it('it compares against the REAL address bar, not `page.url` (which replaceState never writes)', () => {
    expect(reassert).toMatch(/fleetMirrorDrift\(/);
    expect(reassert).toMatch(/location\.search/);
    expect(src).toMatch(/import \{[^}]*\bfleetMirrorDrift\b[^}]*\} from '\.\/fleet-view'/s);
  });

  it('it writes ONLY on drift — an invalidate storm must not cost a history write per row', () => {
    expect(reassert).toMatch(/if \(drift === null\) return;/);
    expect(reassert).toMatch(/syncFleetUrl\(\);/);
  });
});
