import type { PageServerLoad } from './$types.js';
import { WORKSPACE_ROOT } from '$lib/server/constants.js';
import { getTemplateMetadata } from '$lib/server/project-templates.js';

export const load: PageServerLoad = async () => {
	return {
		templates: getTemplateMetadata(),
		defaultWorkspace: WORKSPACE_ROOT,
		autoStartServices: [
			{ name: 'Claude Flow Daemon', description: 'Agent orchestration + memory', default: true },
			{ name: 'Dev Server (Vite)', description: 'npm run dev on :5173', default: true },
			{ name: 'Ollama Server', description: 'Local model runtime', default: true },
			{ name: 'MCP Servers', description: 'From .mcp.json config', default: false }
		]
	};
};
