/* ============================================================================
   ai-playground v2 — CREATE PAGE ?run= NAVIGATION CONTRACT (LT-1 fix regression)
   LT-1 DoD-review found the client live-transition was DEAD: the launch effect
   set ?run=<id> via replaceState() + invalidate('app:create-run'). replaceState
   is *shallow* routing — it updates page.url client-side, but the URL it injects
   is NOT propagated into invalidate()'s __data.json re-fetch, so the loader
   re-ran WITHOUT the run param → url.searchParams.get('run') === null → run:null
   every time. The page never left the brief form; only a full reload (which
   carries ?run= in the document URL) surfaced the resolved proposal.

   Fix: use goto(urlWithRun, { replaceState:true, keepFocus:true, noScroll:true })
   — a real shallow client navigation that changes the data URL, so the loader
   re-runs WITH ?run= and data.run hydrates the live generating → review|failed
   flip. Applies in BOTH the launch effect and startOver().

   Regression gate (source-parse — mirrors page-tokens.test.ts / template-picker
   style; the component isn't unit-rendered here): the run-param navigation must
   go through goto() with the param-carrying URL, and replaceState must NOT be the
   mechanism that pins/drops ?run=. A revert to replaceState for ?run= is the
   exact defect and fails here.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, '+page.svelte');
const src = readFileSync(PAGE, 'utf8');

describe('LT-1 — ?run= reaches the loader via goto(), never replaceState()', () => {
  it('the defect mechanism is GONE: replaceState() is not imported (so cannot be called)', () => {
    // The fix removed the replaceState navigation fn from the $app/navigation import; it is
    // un-callable. (The `replaceState: true` goto OPTION is fine and expected — only the
    // standalone replaceState() nav, which loses the param on the loader re-fetch, was the bug.
    // We assert on the import rather than call-site prose so explanatory comments naming the
    // anti-pattern don't trip the gate.) The import line is comment-stripped before matching.
    const importLines = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n');
    expect(importLines).not.toMatch(/\breplaceState\b/);
    expect(importLines).toMatch(/\bgoto\b/); // goto IS imported (the correct primitive)
  });

  it('the launch effect navigates with the run param via goto()', () => {
    // url.searchParams.set('run', …) must be followed by a goto(url, …) — the only
    // navigation primitive that carries the param into the loader's data URL.
    expect(src).toMatch(/url\.searchParams\.set\(\s*['"]run['"]/);
    expect(src).toMatch(/goto\(\s*url\s*,\s*\{[^}]*replaceState:\s*true[^}]*\}/);
  });

  it('startOver drops the run param via goto() (back to STAGE 1)', () => {
    expect(src).toMatch(/url\.searchParams\.delete\(\s*['"]run['"]/);
  });

  it('goto() for run-nav keeps focus and scroll (no jump on the live flip)', () => {
    const gotoRunNav = src.match(/goto\(\s*url\s*,\s*\{[^}]*\}\s*\)/g);
    expect(gotoRunNav, 'expected goto(url, {…}) calls for run-param nav').toBeTruthy();
    // Both run-nav goto calls (launch + startOver) carry keepFocus + noScroll.
    expect(gotoRunNav!.length).toBeGreaterThanOrEqual(2);
    for (const call of gotoRunNav!) {
      expect(call).toMatch(/keepFocus:\s*true/);
      expect(call).toMatch(/noScroll:\s*true/);
    }
  });

  it('the SSE run-row watcher still re-reads via invalidate (URL unchanged path)', () => {
    // invalidate('app:create-run') is correct for a row-change re-read (no URL change);
    // it must stay — only the param-pinning replaceState was the bug.
    expect(src).toMatch(/onDbChange\(\s*['"]create_proposal_run['"]/);
    expect(src).toMatch(/invalidate\(\s*['"]app:create-run['"]\s*\)/);
  });
});
