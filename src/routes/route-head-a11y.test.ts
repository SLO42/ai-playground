/* ============================================================================
   ai-playground v2 — ROUTE HEAD + A11Y SOURCE GATE (task 14.3)
   Static-source checks over every route page, covering the audit findings the
   browser audit caught but no test gated:
     1. Every route declares a per-route <svelte:head><title> ("Reports —
        Atelier" pattern) — the app previously shipped one static "Atelier"
        title on all 13 routes.
     2. Headings (h1–h6) must render the display face: base.css guards the
        elements, so the only regression vector is a heading CLASS using the
        `font:` SHORTHAND (which resets font-family) with a body/mono type
        token. Gate: any class applied to an h* that sets `font:` must
        reference a display type token.
     3. Tab/count badges must not concatenate into the accessible name
        ("Tasks2"): any <button> whose content includes a count badge must
        carry an explicit aria-label, and the badge must be aria-hidden.
     4. Error pages are title-gated too (14.3 DoD-review fix): app.html no
        longer carries a static <title> fallback, so without a root
        +error.svelte declaring its own <svelte:head><title>, 404/500
        responses ship NO title at all (WCAG 2.4.2 Level A). The walker
        therefore collects +error.svelte alongside +page.svelte.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROUTES = dirname(fileURLToPath(import.meta.url));

/** Every +page.svelte AND +error.svelte under src/routes (recursive) — error
 *  pages are user-facing routes too and must pass the same title gate. */
function routePages(dir = ROUTES, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routePages(p, acc);
    else if (name === '+page.svelte' || name === '+error.svelte') acc.push(p);
  }
  return acc;
}

const pages = routePages().map((p) => ({
  path: p,
  rel: relative(ROUTES, p).replace(/\\/g, '/'),
  src: readFileSync(p, 'utf8')
}));

/** Markup only (no <script>/<style>). */
function templateOnly(src: string): string {
  return src.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
}

/** The <style> block contents. */
function styleOnly(src: string): string {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(src);
  return m ? m[1] : '';
}

/** Raw inner text of <svelte:head><title>…</title>. */
function titleOf(src: string): string | null {
  const head = /<svelte:head>([\s\S]*?)<\/svelte:head>/i.exec(src);
  if (!head) return null;
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head[1]);
  return t ? t[1].trim() : null;
}

describe('per-route <title> (14.3f) — no route ships the bare static "Atelier"', () => {
  it('found the full route set', () => {
    expect(pages.length).toBeGreaterThanOrEqual(13);
  });

  it.each(pages.map((p) => [p.rel, p] as const))('%s declares <svelte:head><title>', (_rel, p) => {
    const title = titleOf(p.src);
    expect(title, `${p.rel} must declare <svelte:head><title>`).toBeTruthy();
    // The "<Page> — Atelier" pattern: route context first, app name last.
    expect(title!).toMatch(/ — Atelier$/);
    // And a real per-route prefix (literal or dynamic), never just the app name.
    expect(title!).not.toBe('— Atelier');
    expect(title!.replace(/ — Atelier$/, '').trim().length).toBeGreaterThan(0);
  });

  it('titles are unique across routes (each page is findable in history/tabs)', () => {
    const titles = pages.map((p) => titleOf(p.src));
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('error pages ship a <title> (14.3 DoD-review fix — WCAG 2.4.2)', () => {
  // app.html intentionally has no static <title> (per-route titles own the
  // head), so the root error boundary is the ONLY thing standing between a
  // 404/500 response and an untitled document. Live-verified regression:
  // GET /no-such-route returned 404 HTML with no <title> element at all.
  const errorPage = pages.find((p) => p.rel === '+error.svelte');

  it('root +error.svelte exists (deleting it untitles every 404/500 response)', () => {
    expect(errorPage, 'src/routes/+error.svelte must exist').toBeTruthy();
  });

  it('its title is status-aware and on-pattern', () => {
    expect(errorPage).toBeTruthy();
    const title = titleOf(errorPage!.src);
    expect(title, '+error.svelte must declare <svelte:head><title>').toBeTruthy();
    expect(title!).toMatch(/ — Atelier$/);
    // Status-aware: the title must be driven by page.status (404 vs failure),
    // not a hardcoded string that lies about non-404 errors (F-008 honesty).
    expect(title!).toMatch(/\{/);
    expect(errorPage!.src).toMatch(/page\.status/);
  });

  it('app.html still has no static <title> (the per-route pattern owns the head)', () => {
    // Guards the premise: if a static title ever returns to app.html it would
    // double-title every page; if this fails, revisit the error-page gate.
    const appHtml = readFileSync(join(ROUTES, '..', 'app.html'), 'utf8');
    expect(appHtml).not.toMatch(/<title[\s>]/i);
  });
});

describe('headings render the display face (14.3d) — no mono h3/h4 via font: shorthand', () => {
  // A `font:` shorthand on a heading class resets font-family; it must pull a
  // display token. Body/label/mono type tokens are banned on heading classes.
  // `var(--type-h3, <fallback>)` counts — the defined token wins at runtime.
  const DISPLAY_OK = /var\(\s*--type-(display|h1|h2|h3)\s*[,)]|var\(\s*--font-display\s*[,)]/;

  it.each(pages.map((p) => [p.rel, p] as const))('%s heading classes use display type', (_rel, p) => {
    const tmpl = templateOnly(p.src);
    const style = styleOnly(p.src);

    // Classes applied to h1–h6 in this template.
    const headingClasses = new Set<string>();
    const hRe = /<h[1-6]\s+[^>]*class="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = hRe.exec(tmpl)) !== null) {
      for (const c of m[1].split(/\s+/)) if (c) headingClasses.add(c);
    }

    // Flat rule blocks: selector { decls }.
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    const offenders: string[] = [];
    while ((m = ruleRe.exec(style)) !== null) {
      const [, selector, decls] = m;
      const touchesHeading = [...headingClasses].some((c) =>
        new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(selector)
      );
      if (!touchesHeading) continue;
      const fontShorthand = /(^|[;\s])font\s*:\s*([^;]+);?/.exec(decls);
      if (fontShorthand && !DISPLAY_OK.test(fontShorthand[2])) {
        offenders.push(`${selector.trim()} → font: ${fontShorthand[2].trim()}`);
      }
    }
    expect(
      offenders,
      `heading classes must keep --font-display (base.css h1–h6 guard is reset by font: shorthand):\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });
});

describe('count badges never concatenate into accessible names (14.3e)', () => {
  it.each(pages.map((p) => [p.rel, p] as const))('%s buttons with count badges are named', (_rel, p) => {
    const tmpl = templateOnly(p.src);
    const buttonRe = /<button\b([\s\S]*?)>([\s\S]*?)<\/button/g;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = buttonRe.exec(tmpl)) !== null) {
      const [, attrs, content] = m;
      const badges = content.match(/<span[^>]*class="[^"]*\bcount\b[^"]*"[^>]*>/g) ?? [];
      if (badges.length === 0) continue;
      if (!/aria-label\s*=/.test(attrs)) {
        offenders.push(`button missing aria-label: ${content.replace(/\s+/g, ' ').slice(0, 60)}`);
      }
      for (const b of badges) {
        if (!/aria-hidden\s*=\s*"true"/.test(b)) offenders.push(`badge missing aria-hidden: ${b}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
