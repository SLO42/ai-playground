import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { generateProject } from '$lib/server/project-generator.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { prompt, template, tags, name } = body;

	if (!prompt?.trim()) {
		return json({ error: 'Prompt is required' }, { status: 400 });
	}

	if (!name?.trim()) {
		return json({ error: 'Project name is required' }, { status: 400 });
	}

	const result = await generateProject({ prompt, template, tags, name });

	if (!result.success) {
		return json({ error: result.error }, { status: 400 });
	}

	return json({
		success: true,
		projectPath: result.projectPath,
	});
};
