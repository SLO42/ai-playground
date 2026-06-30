/* ============================================================================
   /agents/catalog REACHABILITY GATE (D-038 complete + purpose).

   The "Available Agents" library is a delivered operator sub-route. Per the
   project's reachability discipline (mirrors staffing-reachable.test.ts), a
   sub-route with no navigable link from its parent /agents page is a dead end —
   a complete + purpose fail. This gate asserts /agents links to /agents/catalog,
   and that the catalog page itself links back to /agents (no orphan). Static
   markup assertion — no DB, no server.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARENT = join(HERE, '..', '+page.svelte');
const PAGE = join(HERE, '+page.svelte');

function hrefs(src: string): string[] {
  return [...src.matchAll(/href=["']([^"']+)["']/g)].map((m) => m[1]);
}

describe('/agents/catalog reachability', () => {
  it('the agent library is reachable from /agents (not a dead end)', () => {
    const links = hrefs(readFileSync(PARENT, 'utf8'));
    expect(
      links.includes('/agents/catalog'),
      '/agents/catalog has no navigable link from /agents — the delivered library is a dead end (D-038)'
    ).toBe(true);
  });

  it('the catalog page links back to /agents (no orphan)', () => {
    const links = hrefs(readFileSync(PAGE, 'utf8'));
    expect(links).toContain('/agents');
  });
});
