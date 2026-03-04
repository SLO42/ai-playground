import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		summary: { totalNodes: 89, namespaces: 6, hnswIndex: '1.2MB', hitRate: '94.2%' },
		namespaces: [
			{ name: 'patterns', count: 24, description: 'Code patterns & conventions', color: 'accent-blue' },
			{ name: 'decisions', count: 18, description: 'Architecture decisions (ADRs)', color: 'accent-purple' },
			{ name: 'context', count: 16, description: 'Session context & state', color: 'accent-cyan' },
			{ name: 'errors', count: 12, description: 'Error resolutions & fixes', color: 'accent-red' },
			{ name: 'dependencies', count: 11, description: 'Package & version info', color: 'accent-yellow' },
			{ name: 'user-prefs', count: 8, description: 'User preferences & workflow', color: 'accent-green' }
		],
		recentNodes: [
			{ key: 'pattern-auth', namespace: 'patterns', value: 'JWT with refresh token rotation', ttl: null, score: 0.97 },
			{ key: 'adr-026-routing', namespace: 'decisions', value: '3-tier model routing (Booster→Haiku→...', ttl: null, score: 0.95 },
			{ key: 'ctx-current-task', namespace: 'context', value: 'Building Penpot design system pages', ttl: '24h', score: 0.92 },
			{ key: 'err-vite-hmr', namespace: 'errors', value: 'HMR disconnect fix: check WebSocket...', ttl: '7d', score: 0.88 },
			{ key: 'dep-svelte-5', namespace: 'dependencies', value: 'SvelteKit 2.x requires Svelte 5 runes', ttl: '30d', score: 0.85 }
		],
		hnswConfig: {
			m: 16,
			efConstruction: 200,
			efSearch: 50,
			dimensions: 384,
			distance: 'cosine',
			backend: 'hybrid'
		}
	};
};
