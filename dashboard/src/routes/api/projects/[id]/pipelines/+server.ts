import { json, error } from '@sveltejs/kit';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';

async function getProjectPath(id: string): Promise<string> {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === id);
	if (!project) throw error(404, 'Project not found');
	return project.path;
}

export async function GET({ params }) {
	const projectPath = await getProjectPath(params.id);

	try {
		const { getPipelineStatus } = await import('$lib/server/ci-pipeline.js');
		const status = await getPipelineStatus(projectPath);
		return json(status);
	} catch {
		return json({ repo: '', workflows: [], recentRuns: [], hasGh: false });
	}
}

export async function POST({ params, request }) {
	const projectPath = await getProjectPath(params.id);
	const body = await request.json();

	if (body.action === 'trigger') {
		if (!body.workflowId || typeof body.workflowId !== 'string') {
			throw error(400, 'workflowId is required');
		}

		try {
			const { triggerWorkflow } = await import('$lib/server/ci-pipeline.js');
			const success = await triggerWorkflow(
				projectPath,
				body.workflowId,
				body.branch ?? undefined
			);

			return json(
				{
					triggered: success,
					workflowId: body.workflowId,
					message: success
						? `Workflow "${body.workflowId}" triggered`
						: 'Failed to trigger workflow'
				},
				{ status: success ? 202 : 500 }
			);
		} catch (e) {
			const message = e instanceof Error ? e.message : 'Failed to trigger workflow';
			throw error(500, message);
		}
	}

	throw error(400, 'Unknown action');
}
