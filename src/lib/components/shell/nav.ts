/**
 * Sidebar nav model — clustered by the product's two pillars
 * (Portfolio · Harness · Knowledge & system) per UI-SPEC §3 and the
 * design-system "proximity" grouping. Extracted as a plain module so the
 * grouping contract is unit-testable without rendering Svelte.
 */
export interface NavItem {
  label: string;
  href: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const navGroups: NavGroup[] = [
  {
    title: 'Portfolio',
    items: [
      { label: 'Home', href: '/' },
      { label: 'Projects', href: '/projects' }
    ]
  },
  {
    title: 'Harness',
    items: [
      { label: 'Agents', href: '/agents' },
      { label: 'Claude Code', href: '/claude-code' }
    ]
  },
  {
    title: 'Knowledge & system',
    items: [
      // NOTE: /memory, /services, /workflows are UI-SPEC §43/45/47 surfaces not yet
      // built. They are deliberately omitted here rather than linked dead — task 4.3
      // forbids orphaned nav links (a href with no +page.svelte → 404). Services
      // health is currently surfaced on the Statusbar; the standalone pages are
      // tracked as a UI coverage gap for a follow-up wave.
      { label: 'Reports', href: '/reports' }
    ]
  }
];
