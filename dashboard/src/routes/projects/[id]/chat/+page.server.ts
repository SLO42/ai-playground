import { readFile } from 'fs/promises';
import { PATHS } from '$lib/server/constants.js';
import { getModels } from '$lib/server/ollama-client.js';
import type { PageServerLoad } from './$types.js';
import type { ChatSession, ChatSessionMeta } from '$lib/types/chat.js';

async function safeReadJson<T>(path: string): Promise<T | null> {
	try {
		const raw = await readFile(path, 'utf-8');
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ parent, url }) => {
	const { projectId, project } = await parent();
	const requestedSession = url.searchParams.get('session');

	const ollamaModels = await getModels();

	// Load session index and filter to this project
	const index = await safeReadJson<ChatSessionMeta[]>(`${PATHS.chatsDir}/index.json`) ?? [];
	const projectSessions = index.filter((s) => {
		// Match by projectId in metadata, or by cwd path
		if ((s as any).projectId === projectId) return true;
		if ((s as any).cwd && project.path && (s as any).cwd.includes(project.path)) return true;
		// Also include sessions whose title references the project
		if (s.title?.toLowerCase().includes(projectId.toLowerCase())) return true;
		return false;
	});

	// Load the requested or most recent session
	let lastSession: ChatSession | null = null;
	const targetId = requestedSession ?? projectSessions[0]?.id;
	if (targetId) {
		lastSession = await safeReadJson<ChatSession>(`${PATHS.chatsDir}/${targetId}.json`);
	}

	return {
		sessions: projectSessions,
		lastSession,
		ollamaModels,
		projectId,
		projectName: project.name,
		projectPath: project.path
	};
};
