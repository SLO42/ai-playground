import { describe, expect, it } from 'vitest';
import { navGroups } from './nav';

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
});
