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
      { label: 'Claude Code', href: '/claude-code' },
      { label: 'Workflows', href: '/workflows' }
    ]
  },
  {
    title: 'Knowledge & system',
    items: [
      // G-C — the atelier-wide reasoning/actions/communications timeline (GLOBAL-TRANSCRIPT-SPEC).
      { label: 'Atelier', href: '/atelier' },
      { label: 'Memory', href: '/memory' },
      // BL-6 — /cannibalize: the Ingest front door (capture→distill→screen→fence→embed→ingest
      // external content into the brain, with provenance + license) — CANNIBALIZE-SPEC §5.
      { label: 'Cannibalize', href: '/cannibalize' },
      { label: 'Reports', href: '/reports' },
      // TASK 10.5 — /services: live health + start/stop/restart for the managed local
      // services (Ollama/SurrealDB/engine) + incident history (UI-SPEC §45/§210).
      { label: 'Services', href: '/services' },
      // TASK 10.3 — /settings: orchestration mode (D-004), routing config view (D-020),
      // API-key presence (D-026). The operator control surface for the running engine.
      { label: 'Settings', href: '/settings' }
    ]
  }
];
