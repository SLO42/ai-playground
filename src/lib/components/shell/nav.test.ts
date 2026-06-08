import { describe, expect, it } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { navGroups } from './nav';

/**
 * Resolve the set of routable top-level page hrefs by scanning src/routes for
 * directories (and the root) that own a `+page.svelte`. This is the live route
 * truth — task 4.3 forbids an orphaned nav link (a href with no page → 404).
 */
function routableHrefs(): Set<string> {
  const routesDir = fileURLToPath(new URL('../../../routes', import.meta.url));
  const hrefs = new Set<string>();
  if (existsSync(`${routesDir}/+page.svelte`)) hrefs.add('/');
  for (const entry of readdirSync(routesDir, { withFileTypes: true })) {
    // Skip dynamic/group segments and non-dirs; nav only links static top-level pages.
    if (!entry.isDirectory() || entry.name.startsWith('[') || entry.name === 'api') continue;
    if (existsSync(`${routesDir}/${entry.name}/+page.svelte`)) hrefs.add(`/${entry.name}`);
  }
  return hrefs;
}

describe('sidebar nav model', () => {
  it('clusters nav by the two product pillars (UI-SPEC §3)', () => {
    const titles = navGroups.map((g) => g.title);
    expect(titles).toEqual(['Portfolio', 'Harness', 'Knowledge & system']);
  });

  it('every nav item has a label and an absolute href', () => {
    for (const group of navGroups) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.href.startsWith('/')).toBe(true);
      }
    }
  });

  it('has no duplicate hrefs across groups', () => {
    const hrefs = navGroups.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('every nav href resolves to a real route — no orphaned links (task 4.3)', () => {
    const routable = routableHrefs();
    const orphans = navGroups
      .flatMap((g) => g.items.map((i) => i.href))
      .filter((href) => !routable.has(href));
    expect(orphans, `orphaned nav links (no +page.svelte): ${orphans.join(', ')}`).toEqual([]);
  });
});
