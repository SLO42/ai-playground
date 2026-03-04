import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		templates: [
			{ id: 'blank', name: 'Blank', description: 'Empty project with CLAUDE.md', icon: '📄' },
			{ id: 'sveltekit', name: 'SvelteKit', description: 'SvelteKit + TailwindCSS + TypeScript', icon: '🔶' },
			{ id: 'nextjs', name: 'Next.js', description: 'Next.js 15 App Router + TypeScript', icon: '▲' },
			{ id: 'python', name: 'Python', description: 'Python + FastAPI + uv package manager', icon: '🐍' },
			{ id: 'fullstack', name: 'Full Stack', description: 'Monorepo: SvelteKit front + Python back', icon: '🏗' },
			{ id: 'agent', name: 'Agent', description: 'Claude Agent SDK + MCP server template', icon: '🤖' }
		],
		defaultWorkspace: 'C:\\Users\\11sos\\work',
		autoStartServices: [
			{ name: 'Claude Flow Daemon', description: 'Agent orchestration + memory', default: true },
			{ name: 'Dev Server (Vite)', description: 'npm run dev on :5173', default: true },
			{ name: 'Ollama Server', description: 'Local model runtime', default: true },
			{ name: 'MCP Servers', description: 'From .mcp.json config', default: false }
		]
	};
};
