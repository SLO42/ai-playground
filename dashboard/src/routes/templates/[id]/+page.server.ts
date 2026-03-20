import type { PageServerLoad } from './$types.js';
import { error } from '@sveltejs/kit';
import { TEMPLATE_MAP, toTemplateMetadata } from '$lib/server/project-templates.js';

export const load: PageServerLoad = async ({ params }) => {
	const def = TEMPLATE_MAP.get(params.id);
	if (!def) throw error(404, 'Template not found');

	const meta = toTemplateMetadata(def);

	// Generate a sample file tree using placeholder values
	const sampleFiles = def.generate(
		'my-project',
		'Sample project',
		Object.fromEntries(def.params.map((p) => [p.key, p.default]))
	);

	return {
		template: meta,
		fileTree: Object.keys(sampleFiles).sort()
	};
};
