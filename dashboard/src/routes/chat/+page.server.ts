import { readFile, mkdir } from 'fs/promises';
import { getModels } from '$lib/server/ollama-client.js';
import { PATHS } from '$lib/server/constants.js';
import { loadGeneralSettings } from '$lib/server/general-settings.js';
import type { PageServerLoad } from './$types.js';
import type { ChatSession, ChatSessionMeta } from '$lib/types/chat.js';

const CLAUDE_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

/** Safely read + parse JSON, retrying once on parse failure (race with writer). */
async function safeReadJson<T>(path: string): Promise<T | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const raw = await readFile(path, 'utf-8');
			return JSON.parse(raw) as T;
		} catch {
			if (attempt === 0) await new Promise(r => setTimeout(r, 50));
		}
	}
	return null;
}

export const load: PageServerLoad = async ({ url }) => {
	const [ollamaModels, generalSettings] = await Promise.all([
		getModels(),
		loadGeneralSettings()
	]);
	const requestedSession = url.searchParams.get('session');
	const prefillPrompt = url.searchParams.get('prompt') ?? null;

	await mkdir(PATHS.chatsDir, { recursive: true }).catch(() => {});

	const sessionsData = await safeReadJson<ChatSessionMeta[]>(`${PATHS.chatsDir}/index.json`);
	const sessions = (sessionsData ?? []).sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
	);

	// Load requested session or most recent
	const targetId = requestedSession ?? sessions[0]?.id;
	let lastSession: ChatSession | null = null;
	if (targetId) {
		lastSession = await safeReadJson<ChatSession>(`${PATHS.chatsDir}/${targetId}.json`);
	}

	return {
		ollamaModels: ollamaModels.map((m) => m.name),
		claudeModels: CLAUDE_MODELS,
		sessions,
		lastSession,
		prefillPrompt,
		generalSettings: {
			requireConfirmation: generalSettings.requireConfirmation,
			autoApproveLowRisk: generalSettings.autoApproveLowRisk,
			showCommandsInInputBar: generalSettings.showCommandsInInputBar
		}
	};
};
