# OpenClaw AI Playground

Dashboard and orchestration platform for OpenClaw — an autonomous AI agent system with multi-model routing, swarm coordination, and real-time monitoring.

**Stack:** SvelteKit (Svelte 5) · Tailwind v4 · Node.js 22 · Ollama · Claude API

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Ollama](https://ollama.com/) (local model serving)
- An [Anthropic API key](https://console.anthropic.com/) (for Claude models)

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude model access |
| `OPENAI_API_KEY` | No | OpenAI API key (optional provider) |
| `GITHUB_TOKEN` | No | GitHub token for repo integrations |
| `PUBLIC_SENTRY_DSN` | No | Sentry DSN for error monitoring (client + server) |

API keys can also be managed from the Settings page in the dashboard UI.

## Local Development

```bash
# Install dependencies
cd dashboard
npm install

# Start the dev server (http://localhost:5173)
npm run dev
```

### Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start development server with HMR |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build locally |
| `npm run check` | Type-check with svelte-check |
| `npm run test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run end-to-end tests (Playwright) |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Check formatting with Prettier |

### Services

The dashboard integrates with several local services:

| Service | Default Port | Health Check |
|---|---|---|
| Ollama | 11434 | `http://127.0.0.1:11434/` |
| OpenClaw Gateway | 18789 | `http://127.0.0.1:18789/` |
| Claude Flow Daemon | — | PID file + tasklist |
| Penpot MCP | 4400 | `http://127.0.0.1:4400/` |

Start services from the dashboard Services page, or manually:

```bash
# Ollama
ollama serve

# OpenClaw gateway
npx openclaw gateway run --port 18789 --allow-unconfigured

# Claude Flow daemon
bash scripts/daemon-ctl.sh start
```

## Docker

### Build the image

```bash
docker build -t openclaw-dashboard ./dashboard
```

The Dockerfile uses a multi-stage build (Node 22 Alpine):
1. **Build stage** — installs deps, runs `npm run build`, prunes dev dependencies
2. **Runtime stage** — copies only the build output and production `node_modules`

### Run the container

```bash
docker run -d \
  --name openclaw-dashboard \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e PUBLIC_SENTRY_DSN=https://... \
  openclaw-dashboard
```

The container exposes port **3000** and runs `node build` as its entrypoint.

### Docker Compose

Create a `docker-compose.yml` for a complete local stack:

```yaml
services:
  dashboard:
    build: ./dashboard
    ports:
      - "3000:3000"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - PUBLIC_SENTRY_DSN=${PUBLIC_SENTRY_DSN}
    depends_on:
      - ollama
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
    restart: unless-stopped

volumes:
  ollama-data:
```

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f dashboard

# Rebuild after code changes
docker compose up -d --build dashboard
```

## CI/CD Pipeline

The project uses GitHub Actions for automated releases. The workflow is defined in `.github/workflows/release.yml`.

### Release Flow

1. **Trigger** — A pull request is merged into `main`
2. **Version bump** — Determined by PR labels:
   - `major` label → major version bump
   - `minor` label → minor version bump
   - No label → patch bump
3. **Tag & Release** — A Git tag is created and a GitHub Release is published with auto-generated notes
4. **Docker build** — The dashboard image is built and pushed to GitHub Container Registry (`ghcr.io`)

### Container Registry

Published images are tagged with:
- Full semver (`v1.2.3`)
- Major.minor (`1.2`)
- `latest`

Pull the latest image:

```bash
docker pull ghcr.io/<owner>/ai-playground:latest
```

### Running CI Locally

```bash
# Type-check
cd dashboard && npm run check

# Lint
npm run lint

# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Full build
npm run build
```

## Project Structure

```
ai-playground/
├── dashboard/              # SvelteKit application
│   ├── src/
│   │   ├── lib/server/    # Server-side logic (heartbeat, providers, tasks)
│   │   ├── routes/        # SvelteKit routes (pages + API endpoints)
│   │   └── lib/types/     # TypeScript type definitions
│   ├── Dockerfile         # Multi-stage production build
│   └── package.json
├── config/                 # Configuration files (gateway, security, agent pool)
├── scripts/                # Utility scripts (daemon-ctl, patches)
├── .github/workflows/      # CI/CD pipeline
├── .playground/            # Runtime state (gitignored)
└── .env.example            # Environment variable template
```

## License

See [LICENSE](LICENSE) for details.
