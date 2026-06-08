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
      { label: 'Reports', href: '/reports' },
      { label: 'Services', href: '/services' }
    ]
  }
];
