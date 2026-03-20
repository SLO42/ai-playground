import type { PageServerLoad } from './$types.js';
import { getTemplateMetadata } from '$lib/server/project-templates.js';

export const load: PageServerLoad = async () => {
	const templates = getTemplateMetadata();
	const languages = [...new Set(templates.map((t) => t.language).filter(Boolean))].sort();
	const tags = [...new Set(templates.flatMap((t) => t.tags))].sort();
	return { templates, languages, tags };
};
