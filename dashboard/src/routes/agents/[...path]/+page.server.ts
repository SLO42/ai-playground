import type { PageServerLoad, Actions } from './$types.js';
import { readFile, writeFile, unlink } from 'fs/promises';
import { PATHS } from '$lib/server/constants.js';
import { fail, redirect } from '@sveltejs/kit';
import { resolveAgentPath, parseFrontmatter, getCategories } from '$lib/server/agent-scanner.js';

export const load: PageServerLoad = async ({ params }) => {
	const filename = params.path;
	if (!filename) {
		return { error: 'No agent path specified' };
	}

	const agentPath = resolveAgentPath(filename);
	const categories = await getCategories();

	try {
		const content = await readFile(agentPath, 'utf-8');
		const { frontmatter, body } = parseFrontmatter(content);

		return {
			filename,
			content,
			frontmatter,
			body,
			categories,
			error: null
		};
	} catch {
		return {
			filename,
			content: null,
			frontmatter: null,
			body: null,
			categories,
			error: 'Agent file not found'
		};
	}
};

export const actions: Actions = {
	save: async ({ request, params }) => {
		const formData = await request.formData();
		const content = formData.get('content') as string;
		const filename = params.path;

		if (!filename || !content) {
			return fail(400, { error: 'Missing filename or content' });
		}

		const agentPath = resolveAgentPath(filename);
		try {
			await writeFile(agentPath, content, 'utf-8');
			return { success: true };
		} catch (e) {
			return fail(500, { error: `Failed to save: ${e}` });
		}
	},

	delete: async ({ params }) => {
		const filename = params.path;
		if (!filename) {
			return fail(400, { error: 'Missing filename' });
		}

		const agentPath = resolveAgentPath(filename);
		try {
			await unlink(agentPath);
		} catch (e) {
			return fail(500, { error: `Failed to delete: ${e}` });
		}

		redirect(303, '/agents');
	}
};
