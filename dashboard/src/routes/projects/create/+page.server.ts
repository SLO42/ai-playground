import type { PageServerLoad } from './$types.js';
import type { ProjectTemplate } from '$lib/types/projects.js';
import { WORKSPACE_ROOT } from '$lib/server/constants.js';

export const load: PageServerLoad = async () => {
	const templates: ProjectTemplate[] = [
		{ id: 'blank', name: 'Blank', description: 'Empty project with CLAUDE.md', language: '', icon: '\uD83D\uDCC4', tags: [] },
		{ id: 'sveltekit', name: 'SvelteKit', description: 'SvelteKit + TailwindCSS + TypeScript', language: 'TypeScript', icon: '\uD83D\uDD36', tags: ['frontend', 'fullstack', 'web'] },
		{ id: 'nextjs', name: 'Next.js', description: 'Next.js 15 App Router + TypeScript', language: 'TypeScript', icon: '\u25B2', tags: ['frontend', 'fullstack', 'web'] },
		{ id: 'python', name: 'Python (FastAPI)', description: 'Python + FastAPI + uv package manager', language: 'Python', icon: '\uD83D\uDC0D', tags: ['backend', 'api', 'web'] },
		{ id: 'fullstack', name: 'Full Stack', description: 'Monorepo: SvelteKit front + Python back', language: 'TypeScript', icon: '\uD83C\uDFD7', tags: ['fullstack', 'web', 'monorepo'] },
		{ id: 'agent', name: 'Agent', description: 'Claude Agent SDK + MCP server template', language: 'TypeScript', icon: '\uD83E\uDD16', tags: ['ai', 'agent', 'mcp'] },
		{ id: 'go', name: 'Go', description: 'Go module with tests and build tooling', language: 'Go', icon: '\uD83D\uDC39', tags: ['backend', 'cli', 'systems'] },
		{ id: 'rust', name: 'Rust', description: 'Cargo project with tests', language: 'Rust', icon: '\u2699\uFE0F', tags: ['backend', 'cli', 'systems'] },
		{ id: 'python-cli', name: 'Python', description: 'Python CLI app with pytest and pyproject.toml', language: 'Python', icon: '\uD83D\uDC0D', tags: ['cli', 'tool', 'scripting'] },
		{ id: 'ruby', name: 'Ruby', description: 'Ruby project with RSpec tests', language: 'Ruby', icon: '\uD83D\uDC8E', tags: ['backend', 'scripting'] },
		{ id: 'java', name: 'Java', description: 'Maven project with JUnit 5 tests', language: 'Java', icon: '\u2615', tags: ['backend', 'enterprise'] },
		{ id: 'dotnet', name: 'C# / .NET', description: '.NET 8 console app with nullable enabled', language: 'C#', icon: '\uD83D\uDD35', tags: ['backend', 'enterprise', 'cli'] }
	];

	return {
		templates,
		defaultWorkspace: WORKSPACE_ROOT,
		autoStartServices: [
			{ name: 'Claude Flow Daemon', description: 'Agent orchestration + memory', default: true },
			{ name: 'Dev Server (Vite)', description: 'npm run dev on :5173', default: true },
			{ name: 'Ollama Server', description: 'Local model runtime', default: true },
			{ name: 'MCP Servers', description: 'From .mcp.json config', default: false }
		]
	};
};
