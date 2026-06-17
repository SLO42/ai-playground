/* ============================================================================
   ai-playground v2 — /agents STAFFING-REACHABILITY GATE (BL3-b DoD fix)

   D-038 DoD-review found the delivered /agents/staffing decision board was a
   DEAD END: no nav link reached it anywhere in the app. The sidebar nav is a
   flat top-level rail (no /agents children), and its sibling sub-routes
   (/agents/proposals, /agents/ceremony) are reached only via in-page CTA links
   from the /agents workforce panel — staffing had none, so an operator could
   never navigate to a functionally-correct, well-tested surface (complete +
   purpose fail).

   Regression gate: the /agents page markup MUST carry a navigable href to each
   operator surface it owns. A delivered sub-route with no reachable link from
   its parent is the exact defect this gate exists to catch. Static-markup
   assertion (mirrors proposals/page-tokens.test.ts) — no DB, no server.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, '+page.svelte');

/** Every `href="…"` literal in the page source (the only nav primitive here). */
function hrefs(src: string): string[] {
  return [...src.matchAll(/href=["']([^"']+)["']/g)].map((m) => m[1]);
}

describe('BL3-b — /agents links to every operator sub-route it owns (reachability)', () => {
  const src = readFileSync(PAGE, 'utf8');
  const links = hrefs(src);

  it('the staffing decision board is reachable from /agents (the defect)', () => {
    expect(
      links.includes('/agents/staffing'),
      '/agents/staffing has no navigable link from /agents — the delivered board is a dead end (D-038 complete+purpose)'
    ).toBe(true);
  });

  it('its sibling operator surfaces stay reachable (no regression)', () => {
    expect(links).toContain('/agents/proposals');
    expect(links).toContain('/agents/ceremony');
  });
});
