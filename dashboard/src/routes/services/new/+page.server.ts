import type { PageServerLoad } from './$types.js';

export interface DetectedService {
	name: string;
	type: string;
	command: string;
	port: number;
	selected: boolean;
}

export const load: PageServerLoad = async () => {
	const detectedServices: DetectedService[] = [
		{ name: 'penpot-mcp', type: 'MCP Server', command: 'pnpm run start', port: 4400, selected: true },
		{ name: 'dev-server', type: 'Vite Dev', command: 'npm run dev', port: 5173, selected: true },
		{ name: 'storybook', type: 'Web App', command: 'npm run storybook', port: 6006, selected: false }
	];

	return {
		detectedServices,
		defaultConfigDir: '.openclaw/services/'
	};
};
