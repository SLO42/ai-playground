# Unified Dashboard — SvelteKit Implementation Plan

## Context

The ai-playground stack has 4 independent services (OpenClaw Gateway, Ollama, Ruflo, HEB MCP) with no unified visual interface. Each service exposes its own API but there's no single pane of glass to monitor models, agents, channels, and tools. The user wants a locally-hosted SvelteKit dashboard that ties everything together.

## Architecture Overview

```
dashboard/ (SvelteKit app, port 5173 dev / 3001 prod)
├── Server routes → proxy to backend APIs (avoids CORS)
├── WebSocket store → OpenClaw Gateway (ws://127.0.0.1:18789)
├── Polling stores → Ollama (http://127.0.0.1:11434)
├── File/CLI stores → Ruflo metrics (.claude-flow/metrics/*.json)
└── HTTP store → HEB MCP (http://127.0.0.1:3000)
```

## Project Structure

```
dashboard/
├── package.json
├── svelte.config.js          # Node adapter, alias config
├── tailwind.config.js
├── vite.config.ts
├── src/
│   ├── app.html
│   ├── app.css                # Tailwind imports + dark theme
│   ├── lib/
│   │   ├── stores/
│   │   │   ├── openclaw.ts    # WebSocket store (gateway connection)
│   │   │   ├── ollama.ts      # Polling store (model stats, VRAM)
│   │   │   ├── ruflo.ts       # File-read store (metrics JSONs)
│   │   │   └── grocery.ts     # HTTP store (HEB MCP proxy)
│   │   ├── components/
│   │   │   ├── Sidebar.svelte
│   │   │   ├── StatusBadge.svelte
│   │   │   ├── ModelCard.svelte
│   │   │   ├── AgentCard.svelte
│   │   │   ├── ChannelCard.svelte
│   │   │   ├── VramGauge.svelte
│   │   │   └── MetricsChart.svelte
│   │   └── utils/
│   │       └── api.ts         # Shared fetch helpers, error handling
│   ├── routes/
│   │   ├── +layout.svelte     # Sidebar + global status bar
│   │   ├── +page.svelte       # Dashboard home (overview cards)
│   │   ├── models/
│   │   │   └── +page.svelte   # Ollama models, VRAM, tokens/sec
│   │   ├── agents/
│   │   │   └── +page.svelte   # Ruflo agents, swarm topology
│   │   ├── channels/
│   │   │   └── +page.svelte   # OpenClaw channels (Twitch status)
│   │   └── grocery/
│   │       └── +page.svelte   # HEB search, cart, coupons
│   └── routes/api/            # Server-side proxies
│       ├── ollama/[...path]/+server.ts
│       ├── openclaw/[...path]/+server.ts
│       ├── ruflo/metrics/+server.ts
│       └── grocery/[...path]/+server.ts
```

## Data Sources & Connection Strategy

### 1. OpenClaw Gateway (WebSocket)
- **Endpoint**: `ws://127.0.0.1:18789` (or `wss://` with TLS)
- **Protocol**: JSON frames — `{ type: "req", id, method, params }` / `{ type: "res", id, result }` / `{ type: "event", event, data }`
- **Connect flow**: Send `connect` challenge, receive session token
- **Key methods to call**:
  - `sessions.list` — active chat sessions
  - `channels.status` — channel health (Twitch connected/disconnected)
  - `agents.list` — delegated agents
  - `models.list` — configured models + active model
  - `tools.catalog` — registered MCP tools
- **Key events to subscribe**:
  - `tick` — periodic health heartbeat
  - `channel.connected` / `channel.disconnected`
  - `chat` — live message stream
  - `exec.approval.requested` — pending human-in-the-loop approvals
- **Store pattern**: Svelte writable store, auto-reconnect on disconnect, 5s heartbeat check

### 2. Ollama (REST polling)
- **Base**: `http://127.0.0.1:11434`
- **Endpoints**:
  - `GET /api/tags` — list models (name, size, quantization, modified date)
  - `GET /api/ps` — running models with VRAM usage (`size_vram`), tokens/sec (`eval_count/eval_duration`)
  - `POST /api/show` body `{ name: "gpt-oss:20b" }` — model details (params, template, license)
  - `GET /api/version` — Ollama version
  - `GET /` — health check (returns "Ollama is running")
- **Poll interval**: 5s for `/api/ps` (VRAM/perf), 30s for `/api/tags` (model list)
- **Key metrics to display**: VRAM usage gauge (used/24GB), tokens/sec, model load time, context window usage

### 3. Ruflo Metrics (file reads via server route)
- **Files** (relative to project root):
  - `.claude-flow/metrics/v3-progress.json` — swarm state (activeAgents, topology), learning (patternsLearned)
  - `.claude-flow/metrics/swarm-activity.json` — process counts, coordination
  - `.claude-flow/metrics/learning.json` — routing accuracy, patterns
  - `.claude-flow/security/audit-status.json` — security scan results
- **Strategy**: Server route reads files from disk, returns JSON. Poll every 10s.
- **CLI fallback**: For live data, server route can exec `npx ruflo swarm status --json` and `npx ruflo agent list --json`

### 4. HEB Grocery MCP (HTTP proxy)
- **Base**: `http://127.0.0.1:3000` (RUFLO_MCP_PORT)
- **MCP tool calls**: `product_search`, `get_product_details`, `get_coupons`, `clip_coupon`, `get_cart`, `add_to_cart`
- **Strategy**: Server-side proxy route translates dashboard requests into MCP tool invocations
- **Display**: Product search with images, coupon list with clip buttons, cart summary

## Pages Detail

### Home (`/`) — System Overview
- **Top row**: 4 status cards (Ollama, OpenClaw, Ruflo, HEB) with green/red/yellow badges
- **Middle**: GPT-OSS 20B model card showing VRAM gauge, tokens/sec, uptime
- **Bottom**: Recent activity feed (last 10 OpenClaw events)

### Models (`/models`)
- **Model list**: All Ollama models from `/api/tags` with size, quantization, modified date
- **Active model panel**: Real-time stats from `/api/ps` — VRAM bar, tokens/sec sparkline, context window usage
- **Fallback chain**: Visual display of routing order (GPT-OSS → Sonnet → Haiku) with cost indicators

### Agents (`/agents`)
- **Swarm topology**: Visual grid of active Ruflo agents with status badges
- **Metrics**: patterns learned, routing accuracy, sessions completed
- **Agent detail**: Click to see agent type, assigned tasks, memory usage

### Channels (`/channels`)
- **Channel cards**: Twitch (and future channels) with connected/disconnected status
- **Twitch detail**: Allowlisted users, message rate, recent chat messages
- **Pairing management**: View pending pairing requests, approve/deny

### Grocery (`/grocery`)
- **Product search**: Search bar → product grid with images and prices
- **Coupons**: List with clip buttons, savings total
- **Cart**: Current items, quantities, estimated total

## Tech Stack

| Tool | Purpose |
|------|---------|
| SvelteKit | Framework (file routing, SSR, server routes) |
| @sveltejs/adapter-node | Production deployment (local server) |
| Tailwind CSS v4 | Styling (dark theme default) |
| shadcn-svelte | UI components (cards, badges, buttons, tables) |
| Chart.js + svelte-chartjs | VRAM gauge, tokens/sec sparkline |
| TypeScript | Type safety throughout |

## Build Sequence

### Step 1: Scaffold + dependencies
```bash
npx sv create dashboard    # SvelteKit skeleton
cd dashboard
npx sv add tailwindcss     # Tailwind v4
npx shadcn-svelte init     # shadcn components
npm i chart.js svelte-chartjs
```

### Step 2: Layout + routing shell
- Create sidebar layout with nav links
- Add global status bar (service health dots)
- Set up dark theme (Tailwind dark mode)

### Step 3: Stores + server routes
- `ollama.ts` store — polling `/api/tags` and `/api/ps`
- `openclaw.ts` store — WebSocket connection to gateway
- `ruflo.ts` store — file reads via server route
- Server proxy routes under `routes/api/`

### Step 4: Home page
- Service status cards reading from stores
- Model summary card
- Activity feed from OpenClaw events

### Step 5: Models page
- Model list from Ollama
- VRAM gauge component
- Tokens/sec chart
- Routing chain visualization

### Step 6: Agents page
- Agent grid from Ruflo metrics
- Swarm topology display
- Metrics panels

### Step 7: Channels page
- Channel status cards from OpenClaw
- Twitch detail panel
- Chat message stream

### Step 8: Grocery page
- Product search with MCP proxy
- Coupon list
- Cart management

### Step 9: Polish + production
- Error boundaries on all pages
- Loading skeletons
- `adapter-node` build config
- Add `dashboard:dev` and `dashboard:build` scripts to root `package.json`

## Verification

1. **Dev server**: `cd dashboard && npm run dev` — opens at `http://localhost:5173`
2. **Ollama connectivity**: Models page shows GPT-OSS 20B with VRAM stats (requires Ollama running)
3. **OpenClaw connectivity**: Home page shows gateway status (requires `npm run openclaw:start`)
4. **Ruflo metrics**: Agents page shows swarm data (requires `.claude-flow/metrics/` files to exist)
5. **Grocery**: Search returns H-E-B products (requires `npm run heb:start`)
6. **Production build**: `npm run build && node build` serves on port 3001

## Files Modified Outside `dashboard/`

- `package.json` (root) — add `dashboard:dev`, `dashboard:build`, `dashboard:start` scripts
- `.gitignore` — add `dashboard/node_modules/`, `dashboard/.svelte-kit/`, `dashboard/build/`
