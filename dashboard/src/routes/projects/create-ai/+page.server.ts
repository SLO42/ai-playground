import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		templates: [
			{ id: 'sveltekit', name: 'SvelteKit', description: 'Full-stack Svelte app with SSR' },
			{ id: 'nextjs', name: 'Next.js', description: 'React framework with App Router' },
			{ id: 'express', name: 'Express API', description: 'Node.js REST API server' },
			{ id: 'python-flask', name: 'Flask', description: 'Python web framework' },
			{ id: 'rust-axum', name: 'Rust Axum', description: 'Rust async web framework' },
			{ id: 'blank', name: 'Blank', description: 'Empty project — AI decides the stack' }
		],
		techTags: [
			'TypeScript',
			'Python',
			'Rust',
			'Go',
			'React',
			'Svelte',
			'Vue',
			'PostgreSQL',
			'SQLite',
			'Redis',
			'Docker',
			'Tailwind CSS'
		]
	};
};
