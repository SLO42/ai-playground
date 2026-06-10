/* ============================================================================
   ai-playground v2 — LAYOUT GATE (task 14.2)
   Operator finding: the app capped every page at 980–1200px, stranding dead
   space on wide monitors. Pages are now FLUID full-width framed by ONE gutter
   token (--page-gutter); long prose keeps its readable ch-based measure.

   Fails the build if:
     1. any route +page.svelte reintroduces a page-level px max-width cap
        (declarations only — `@media (max-width: …)` queries are fine);
     2. the gutter token disappears, or the shell stops using it / stops
        stretching the page root vertically (dead-bottom-space regression);
     3. prose ledes lose their ch-based measure (the 64–72ch caps are correct
        typography and MUST stay);
     4. the project section tab strip stops scrolling at narrow widths (14.2b);
     5. the mobile nav drawer loses its Esc-close / focus-management contract
        (14.2c — matches the RightTray pattern).
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');
const ROUTES = join(SRC, 'routes');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

const pageFiles = walk(ROUTES).filter((p) => p.endsWith('+page.svelte'));
const layoutSvelte = readFileSync(join(ROUTES, '+layout.svelte'), 'utf8');
const spacingCss = readFileSync(join(SRC, 'lib', 'styles', 'tokens', 'spacing.css'), 'utf8');
const projectPage = readFileSync(join(ROUTES, 'projects', '[id]', '+page.svelte'), 'utf8');

describe('14.2a — pages are fluid full-width (no px page caps)', () => {
  it('found the route pages (sanity)', () => {
    expect(pageFiles.length).toBeGreaterThanOrEqual(12);
  });

  it.each(pageFiles.map((p) => [p.slice(ROUTES.length), p] as const))(
    'route %s has no page-level px max-width declaration',
    (_label, file) => {
      const css = readFileSync(file, 'utf8');
      // Declarations only: `max-width: 980px;` — NOT `@media (max-width: 767px)`.
      // Page-level means a cap wide enough to constrain the page column (>=600px);
      // small element caps (e.g. a 9rem cell) are component sizing, not page caps.
      const decl = /(?<![(\w-])max-width:\s*(\d+)px/g;
      for (const m of css.matchAll(decl)) {
        expect(
          Number(m[1]),
          `${file} declares "max-width: ${m[1]}px" — page caps are banned (14.2a); use the fluid page + --page-gutter`
        ).toBeLessThan(600);
      }
    }
  );

  it('the shell defines the ONE gutter token (--page-gutter) in spacing.css', () => {
    expect(spacingCss).toMatch(/--page-gutter:\s*var\(--pad-panel\)/);
  });

  it('the shell content region pads with the gutter token and stretches the page root', () => {
    const content = /\.content\s*\{[^}]*\}/s.exec(layoutSvelte)?.[0] ?? '';
    expect(content).toMatch(/padding:\s*var\(--page-gutter\)/);
    // Vertical fill: flex column + a growing page child = no dead bottom space.
    expect(content).toMatch(/display:\s*flex/);
    expect(content).toMatch(/flex-direction:\s*column/);
    expect(layoutSvelte).toMatch(/\.content\s*>\s*:global\(\*\)\s*\{[^}]*flex:\s*1\s+0\s+auto/s);
  });

  it('prose ledes KEEP their readable ch-based measure (correct typography)', () => {
    const home = readFileSync(join(ROUTES, '+page.svelte'), 'utf8');
    const reports = readFileSync(join(ROUTES, 'reports', '+page.svelte'), 'utf8');
    expect(home).toMatch(/\.lede\s*\{[^}]*max-width:\s*\d+ch/s);
    expect(reports).toMatch(/\.lede\s*\{[^}]*max-width:\s*\d+ch/s);
  });
});

describe('14.2b — project section tab strip scrolls instead of clipping at 375px', () => {
  it('.tabs is a horizontal scroll container', () => {
    const tabs = /\.tabs\s*\{[^}]*\}/s.exec(projectPage)?.[0] ?? '';
    expect(tabs, '.tabs style block exists').not.toBe('');
    expect(tabs).toMatch(/overflow-x:\s*auto/);
  });

  it('tabs keep natural width (no shrink) so every tab stays reachable', () => {
    const tab = /\.tab\s*\{[^}]*\}/s.exec(projectPage)?.[0] ?? '';
    expect(tab).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(tab).toMatch(/white-space:\s*nowrap/);
  });

  it('a visible overflow affordance exists at narrow widths (edge fade)', () => {
    expect(projectPage).toMatch(/mask-image:\s*linear-gradient/);
  });

  it('the strip keeps its accessible name (audit anchor)', () => {
    expect(projectPage).toMatch(/aria-label="project sections"/);
  });
});

describe('14.2c — mobile nav drawer keyboard + focus contract (RightTray pattern)', () => {
  it('Escape closes the drawer', () => {
    expect(layoutSvelte).toMatch(/e\.key === 'Escape'/);
    expect(layoutSvelte).toMatch(/<svelte:window onkeydown=\{onShellKeydown\}/);
  });

  it('focus moves INTO the drawer on open and RETURNS to the trigger on close', () => {
    // open: remember the trigger, focus the first focusable inside #app-sidebar
    expect(layoutSvelte).toMatch(/navRestoreFocus = \(document\.activeElement as HTMLElement\)/);
    expect(layoutSvelte).toMatch(/sidebarFocusables\(\)\[0\]\?\.focus\(\)/);
    // close: restore the trigger
    expect(layoutSvelte).toMatch(/function closeNav\(\)/);
    expect(layoutSvelte).toMatch(/target\?\.focus\?\.\(\)/);
    // scrim + hamburger both close via the restoring path
    expect(layoutSvelte).toMatch(/onclick=\{closeNav\}/);
  });

  it('Tab cycles within the open drawer (focus trap while it overlays)', () => {
    expect(layoutSvelte).toMatch(/e\.key === 'Tab'/);
  });
});
