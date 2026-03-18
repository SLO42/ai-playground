import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { resolve } from 'path';
import { readJsonFile, writeJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';

interface ProjectSettings {
	general: {
		name: string;
		description: string;
		branch: string;
	};
	build: {
		dev: { command: string; label: string };
		build: { command: string; label: string };
		test: { command: string; label: string };
	};
	agentConfig: {
		topology: string;
		maxAgents: number;
		memoryBackend: string;
		consensus: string;
	};
	autoStart: boolean;
}

function settingsPath(projectId: string): string {
	const sanitized = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
	return resolve(PATHS.projectsDir, `${sanitized}.json`);
}

export const GET: RequestHandler = async ({ params }) => {
	const path = settingsPath(params.id);
	const config = await readJsonFile<ProjectSettings>(path);
	return json(config ?? null);
};

export const POST: RequestHandler = async ({ params, request }) => {
	const body = await request.json();

	// Validate required fields
	if (!body.general?.name || typeof body.general.name !== 'string') {
		return json({ error: 'Project name is required' }, { status: 400 });
	}

	const maxAgents = Number(body.agentConfig?.maxAgents);
	if (!Number.isFinite(maxAgents) || maxAgents < 1 || maxAgents > 100) {
		return json({ error: 'maxAgents must be 1-100' }, { status: 400 });
	}

	const settings: ProjectSettings = {
		general: {
			name: String(body.general.name).slice(0, 100),
			description: String(body.general.description ?? '').slice(0, 500),
			branch: String(body.general.branch ?? 'main').slice(0, 100)
		},
		build: {
			dev: {
				command: String(body.build?.dev?.command ?? 'npm run dev').slice(0, 200),
				label: String(body.build?.dev?.label ?? 'Development').slice(0, 100)
			},
			build: {
				command: String(body.build?.build?.command ?? 'npm run build').slice(0, 200),
				label: String(body.build?.build?.label ?? 'Production build').slice(0, 100)
			},
			test: {
				command: String(body.build?.test?.command ?? 'npm test').slice(0, 200),
				label: String(body.build?.test?.label ?? 'Test suite').slice(0, 100)
			}
		},
		agentConfig: {
			topology: String(body.agentConfig?.topology ?? 'hierarchical').slice(0, 50),
			maxAgents,
			memoryBackend: String(body.agentConfig?.memoryBackend ?? 'hybrid').slice(0, 50),
			consensus: String(body.agentConfig?.consensus ?? 'raft').slice(0, 50)
		},
		autoStart: Boolean(body.autoStart)
	};

	const path = settingsPath(params.id);
	const ok = await writeJsonFile(path, settings);

	if (!ok) {
		return json({ error: 'Failed to save project settings' }, { status: 500 });
	}

	return json({ success: true, settings });
};
