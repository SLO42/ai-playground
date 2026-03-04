# ai-playground — Unified Dashboard Project Plan

> Updated: 2026-03-04
> Original plan: [DASHBOARD_PLAN_ORIGINAL.md](./DASHBOARD_PLAN_ORIGINAL.md)
> Design file: Penpot (29 frames, 1 design system page)

---

## Vision

A locally-hosted dashboard that unifies all ai-playground services into a single interface. Two operational modes:

1. **Global views** — Monitor and manage all services, agents, models, and channels across the entire platform
2. **Project views** — Drill into a specific project's agents, memory, hooks, security, and settings

---

## Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Framework | SvelteKit | File routing, SSR, server routes |
| Adapter | @sveltejs/adapter-node | Local production server (port 3001) |
| Styling | Tailwind CSS v4 | Dark theme, design tokens |
| Components | shadcn-svelte | Cards, badges, buttons, tables |
| Charts | Chart.js + svelte-chartjs | VRAM gauge, sparklines, timelines |
| Types | TypeScript | Type safety throughout |

---

## Backend Services

| Service | Protocol | Endpoint | Poll Interval |
|---------|----------|----------|---------------|
| OpenClaw Gateway | WebSocket | `ws://127.0.0.1:18789` | Real-time (events) |
| Ollama | REST | `http://127.0.0.1:11434` | 5s (ps), 30s (tags) |
| Ruflo / Claude Flow v3 | File reads + CLI | `.claude-flow/metrics/*.json` | 10s |
| HEB Grocery MCP | HTTP | `http://127.0.0.1:3000` | On demand |

---

## Architecture

```
dashboard/ (SvelteKit app)
├── src/lib/stores/
│   ├── openclaw.ts        # WebSocket store → Gateway
│   ├── ollama.ts          # Polling store → model stats, VRAM
│   ├── ruflo.ts           # File-read store → metrics JSONs
│   ├── grocery.ts         # HTTP store → HEB MCP proxy
│   ├── projects.ts        # Project registry + active project state
│   └── notifications.ts   # Toast queue + alert center
├── src/lib/components/    # Reusable UI (design system)
├── src/routes/            # Pages (file-based routing)
└── src/routes/api/        # Server-side proxies (avoids CORS)
```

---

## Pages — Global Views (16 frames)

These are platform-wide views accessible from the main sidebar.

| Route | Penpot Frame | Description |
|-------|-------------|-------------|
| `/` | Home / Dashboard | 4 metric cards, V3 progress bars, VRAM gauge, learning gauge, top memory nodes |
| `/models` | Models / Model Routing | Model grid, active VRAM stats, routing chain (GPT-OSS → Sonnet → Haiku), routing intelligence |
| `/agents` | Agents / Agent Grid | Stats row, capacity bar, category filters, agent grid with status badges |
| `/channels` | Channels / Gateway Config | Gateway config, channel cards (Twitch), DM pairing policy, allowlist management |
| `/apps` | Apps / MCP Servers | Summary cards, MCP server cards (HEB, Penpot), tool accordion, app list |
| `/memory` | Memory / HNSW Memory | Config cards, bubble graph, ranked context table, auto-memory table |
| `/security` | Security / Audit & CVE | Audit status, CVE remediation progress, findings table, network policy |
| `/hooks` | Hooks / Self-Learning | Stats row, hook registry table, worker timeline, learning config |
| `/sessions` | Sessions / Active Workflows | Session table with filters, timeline view, resource usage |
| `/notifications` | Notifications / Alert Center | Notification center (dropdown), notification preferences grid |
| `/settings` | Settings | Global platform settings |
| `/services` | Services | Service health cards, auto-start config, recent logs |
| `/services/new` | Services / New Service Dialog | Modal: add new service to the platform |
| `/about` | About / Stack | Platform info, version, connected services, documentation links |
| `/inbox` | Agent Inbox / Conversations | Decision requests, Q&A threads, agent message content, response composer |

### Design System Components (shared)
- **Status Bar** — Service pills (dot + name), sync timestamp, notification bell with badge count. 3 variants: Global, Warning, Compact. Tooltip on hover shows full status (online/running/connected/active) plus uptime, latency, extra fields per service.
- **Alert Banners** — Critical (red), Warning (yellow), Info (blue). Dismissible.
- **Card** — bg-secondary, 1px border, 8px radius, 16px padding
- **MetricCard** — Card + uppercase label + mono value + subtitle
- **StatusBadge** — 8px dot + label, variants: online/offline/warning
- **Progress Bar** — Track + colored fill
- **Category Badge** — Pill, 10% bg + accent text color
- **DataTable Row** — Header + data rows with hover state
- **NavItem** — Sidebar link, active/inactive variants
- **Sidebar** — 224px wide, nav + header + footer
- **Toast Overlay** — Stacked toasts (success/error/warning/info), auto-dismiss

---

## Pages — Project Views (13 frames)

Project-scoped views use a different sidebar (project selector + workspace nav). Accessible after selecting a project from the Projects Hub.

| Route | Penpot Frame | Description |
|-------|-------------|-------------|
| `/projects` | Projects / Project Hub | Project cards with health indicators, search, filters, create/import buttons |
| `/projects/create` | Projects / Create & Import | New project wizard (name, template, git init) |
| `/projects/import` | Projects / Import Existing | Import from directory or git URL |
| `/projects/:id` | Shell / Project-Scoped Navigation | Project shell layout with project-specific sidebar |
| `/projects/:id/services` | Shell / Project Services | Service cards (daemon, dev server, Penpot MCP, Ollama), auto-start config, service logs |
| `/projects/:id/about` | Shell / Project About | App identity, core technologies, stack panels, MCP servers, channels, resources, tasks, project timeline |
| `/projects/:id/agents` | Shell / Project Agents | 6 agent cards with stats, capacity bar, agent categories |
| `/projects/:id/sessions` | Shell / Project Sessions | Session table, timeline, resource usage scoped to project |
| `/projects/:id/settings` | Shell / Project Settings | Env vars, build commands, agent config, danger zone |
| `/projects/:id/memory` | Shell / Project Memory | Namespace cards, HNSW node table, memory config |
| `/projects/:id/hooks` | Shell / Project Hooks | Hook registry, learning config, worker status |
| `/projects/:id/security` | Shell / Project Security | CVE table, policies, permissions, audit log |

---

## Design Tokens

### Colors (12)
| Token | Hex | Role |
|-------|-----|------|
| `bg-primary` | `#0F0F23` | Page background |
| `bg-secondary` | `#1A1A2E` | Card/panel background |
| `bg-tertiary` | `#16213E` | Active/hover states |
| `border` | `#2A2A4A` | Borders, dividers |
| `text-primary` | `#E2E8F0` | Body text |
| `text-secondary` | `#94A3B8` | Labels, muted text |
| `accent-blue` | `#3B82F6` | Primary accent |
| `accent-green` | `#22C55E` | Success, online |
| `accent-yellow` | `#EAB308` | Warning, pending |
| `accent-red` | `#EF4444` | Error, offline |
| `accent-purple` | `#A855F7` | Intelligence |
| `accent-cyan` | `#06B6D4` | Branding |

### Typography
| Style | Font | Size | Weight |
|-------|------|------|--------|
| Page Title | Inter | 24px | Bold |
| Section Title | Inter | 18px | Semibold |
| Card Title | Inter | 14px | Semibold |
| Label | Inter | 12px | Medium, uppercase |
| Body | Inter | 14px | Regular |
| Small | Inter | 12px | Regular |
| Mono Value | JetBrains Mono | 24px | Bold |
| Mono Small | JetBrains Mono | 12px | Regular |

### Spacing & Grid
- Base unit: 4px
- Card padding: 16px
- Section gap: 24px
- Sidebar width: 224px
- Content area: 1216px (1440 - 224)
- Border radius: 8px (cards), 6px (inputs), 4px (badges)

---

## Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                    SvelteKit Dashboard                   │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌───────────┐ │
│  │ openclaw │  │  ollama   │  │ ruflo  │  │  grocery  │ │
│  │  store   │  │  store    │  │ store  │  │  store    │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘  └─────┬─────┘ │
│       │              │            │              │       │
│  ┌────┴─────┐  ┌────┴─────┐  ┌───┴────┐  ┌─────┴─────┐ │
│  │ /api/    │  │ /api/    │  │ /api/  │  │ /api/     │ │
│  │ openclaw │  │ ollama   │  │ ruflo  │  │ grocery   │ │
│  │ proxy    │  │ proxy    │  │ reader │  │ proxy     │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘  └─────┬─────┘ │
└───────┼──────────────┼────────────┼─────────────┼───────┘
        │              │            │             │
   ┌────▼─────┐  ┌────▼─────┐  ┌───▼────┐  ┌────▼──────┐
   │ OpenClaw │  │  Ollama  │  │ .claude │  │ HEB MCP   │
   │ Gateway  │  │  :11434  │  │ -flow/  │  │ :3000     │
   │ :18789   │  │          │  │ metrics │  │           │
   └──────────┘  └──────────┘  └────────┘  └───────────┘
```

---

## Build Phases

### Phase 1: Foundation
- [ ] Scaffold SvelteKit project in `dashboard/`
- [ ] Install Tailwind v4, shadcn-svelte, Chart.js
- [ ] Implement design tokens (colors, typography, spacing)
- [ ] Build shared components: Card, MetricCard, StatusBadge, ProgressBar, DataTable, NavItem
- [ ] Build layout: Sidebar + Status Bar + content area
- [ ] Set up dark theme

### Phase 2: Stores & Server Routes
- [ ] `openclaw.ts` — WebSocket store with auto-reconnect, heartbeat
- [ ] `ollama.ts` — Polling store for `/api/tags` and `/api/ps`
- [ ] `ruflo.ts` — File-read store for metrics JSONs
- [ ] `grocery.ts` — HTTP proxy store for MCP tool calls
- [ ] `projects.ts` — Project registry, active project state
- [ ] `notifications.ts` — Toast queue, alert center
- [ ] Server proxy routes under `routes/api/`

### Phase 3: Global Pages
- [ ] Home / Dashboard — metric cards, progress bars, VRAM gauge
- [ ] Models / Model Routing — model grid, VRAM stats, routing chain
- [ ] Agents / Agent Grid — agent cards, capacity bar, category filters
- [ ] Channels / Gateway Config — channel cards, DM policy, allowlist
- [ ] Apps / MCP Servers — server cards, tool accordion
- [ ] Memory / HNSW Memory — config cards, context table
- [ ] Security / Audit & CVE — audit status, CVE progress, findings table, network policy
- [ ] Hooks / Self-Learning — hook registry, worker timeline, learning config

### Phase 4: Global Support Pages
- [ ] Sessions / Active Workflows — session table, timeline
- [ ] Notifications / Alert Center — notification center, preferences
- [ ] Settings — global platform settings
- [ ] Services — service health, auto-start, logs
- [ ] About / Stack — platform info, versions, docs
- [ ] Agent Inbox / Conversations — decision requests, Q&A, message composer

### Phase 5: Project System
- [ ] Projects Hub — project cards, search, create/import
- [ ] Project Create & Import wizards
- [ ] Project shell layout (sidebar with project selector + workspace nav)
- [ ] Project-scoped pages: Services, About (with resources, tasks, timeline), Agents, Sessions, Settings, Memory, Hooks, Security

### Phase 6: Polish & Production
- [ ] Error boundaries on all pages
- [ ] Loading skeletons
- [ ] Toast overlay system
- [ ] Status bar tooltip interactions
- [ ] Keyboard shortcuts
- [ ] `adapter-node` build config
- [ ] Add scripts to root `package.json`: `dashboard:dev`, `dashboard:build`, `dashboard:start`
- [ ] Responsive breakpoints (1440 → 1024 → mobile)

---

## Verification Checklist

| Check | Command / Action |
|-------|-----------------|
| Dev server runs | `cd dashboard && npm run dev` → `http://localhost:5173` |
| Ollama connected | Models page shows GPT-OSS 20B with VRAM stats |
| OpenClaw connected | Status bar shows Gateway: Online |
| Ruflo metrics load | Agents page shows swarm data |
| HEB MCP works | Apps page shows grocery tools |
| Project shell works | Create project → navigate project pages |
| Production build | `npm run build && node build` → port 3001 |
| Design tokens match | Compare dashboard to Penpot design system |

---

## Files Modified Outside `dashboard/`

- `package.json` (root) — add `dashboard:dev`, `dashboard:build`, `dashboard:start` scripts
- `.gitignore` — add `dashboard/node_modules/`, `dashboard/.svelte-kit/`, `dashboard/build/`

---

## Change Log

| Date | Change |
|------|--------|
| 2026-03-03 | Original 5-page plan created (Home, Models, Agents, Channels, Grocery) |
| 2026-03-03 | Penpot design work began — expanded to 29 frames |
| 2026-03-04 | Added: Security, Hooks, Sessions, Memory, Settings, Services, Notifications, About, Agent Inbox |
| 2026-03-04 | Added: Full project system (Hub, Create, Import, 8 project-scoped pages) |
| 2026-03-04 | Added: Design system with 12 colors, 8 typography styles, component library |
| 2026-03-04 | Added: Status bar component (3 variants), alert banners, toast overlay |
| 2026-03-04 | Added: Tooltip interaction spec for service pills |
| 2026-03-04 | Consolidated into this updated project plan |
