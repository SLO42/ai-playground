import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { PATHS } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';
import type { ChatSession, ChatSessionMeta } from '$lib/types/chat.js';

async function ensureDir() {
	await mkdir(PATHS.chatsDir, { recursive: true });
}

async function readIndex(): Promise<ChatSessionMeta[]> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/index.json`, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

async function writeIndex(index: ChatSessionMeta[]) {
	await writeFile(`${PATHS.chatsDir}/index.json`, JSON.stringify(index, null, '\t'), 'utf-8');
}

export const GET: RequestHandler = async () => {
	const index = await readIndex();
	index.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
	return json(index);
};

export const POST: RequestHandler = async ({ request }) => {
	let body: { model?: string; provider?: string; source?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	await ensureDir();

	const id = crypto.randomUUID().slice(0, 8);
	const now = new Date().toISOString();

	const session: ChatSession = {
		id,
		model: body.model ?? 'gpt-oss:20b',
		provider: body.provider ?? 'ollama',
		createdAt: now,
		updatedAt: now,
		messages: [],
		source: (body.source as ChatSession['source']) ?? 'user',
		status: 'idle'
	};

	await writeFile(`${PATHS.chatsDir}/${id}.json`, JSON.stringify(session, null, '\t'), 'utf-8');

	const meta: ChatSessionMeta = {
		id,
		title: 'New Chat',
		model: session.model,
		provider: session.provider,
		messageCount: 0,
		createdAt: now,
		updatedAt: now,
		source: session.source,
		status: session.status
	};

	const index = await readIndex();
	index.unshift(meta);
	await writeIndex(index);

	return json(session, { status: 201 });
};
