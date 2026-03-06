import { json } from '@sveltejs/kit';
import { readFile, writeFile, unlink } from 'fs/promises';
import { PATHS } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';
import type { ChatSession, ChatSessionMeta, ChatMessage } from '$lib/types/chat.js';

function sessionPath(id: string) {
	return `${PATHS.chatsDir}/${id}.json`;
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

export const GET: RequestHandler = async ({ params }) => {
	// Retry once — the heartbeat may be writing the file concurrently
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const raw = await readFile(sessionPath(params.id), 'utf-8');
			return json(JSON.parse(raw));
		} catch {
			if (attempt === 0) await new Promise(r => setTimeout(r, 50));
		}
	}
	return json({ error: 'Session not found' }, { status: 404 });
};

export const PUT: RequestHandler = async ({ params, request }) => {
	let body: { messages?: ChatMessage[]; model?: string; provider?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	let session: ChatSession;
	try {
		const raw = await readFile(sessionPath(params.id), 'utf-8');
		session = JSON.parse(raw);
	} catch {
		return json({ error: 'Session not found' }, { status: 404 });
	}

	if (body.messages) {
		// For claw-owned sessions, merge: keep any server-side messages that
		// were added after the client's last known message (e.g. by heartbeat).
		// This prevents the client from overwriting heartbeat progress messages.
		if (session.source === 'claw' && body.messages.length > 0 && session.messages.length > body.messages.length) {
			// Client sent fewer messages than server has — append client's new messages
			// to the server's existing array instead of replacing
			const clientNew = body.messages.slice(session.messages.length);
			if (clientNew.length > 0) {
				session.messages.push(...clientNew);
			} else {
				// Client may have added messages mid-array — use client version
				// but append any server messages that came after
				const serverExtra = session.messages.slice(body.messages.length);
				session.messages = [...body.messages, ...serverExtra];
			}
		} else {
			session.messages = body.messages;
		}
	}
	if (body.model) session.model = body.model;
	if (body.provider) session.provider = body.provider;
	session.updatedAt = new Date().toISOString();

	await writeFile(sessionPath(params.id), JSON.stringify(session, null, '\t'), 'utf-8');

	const firstUserMsg = session.messages.find((m) => m.role === 'user');
	const title = firstUserMsg ? firstUserMsg.content.slice(0, 40) : 'New Chat';

	const index = await readIndex();
	const idx = index.findIndex((s) => s.id === params.id);
	const existing = idx >= 0 ? index[idx] : undefined;
	const meta: ChatSessionMeta = {
		id: session.id,
		title,
		model: session.model,
		provider: session.provider,
		messageCount: session.messages.length,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		// Preserve fields set by the heartbeat — don't strip them on user save
		...(session.source ? { source: session.source } : existing?.source ? { source: existing.source } : {}),
		...(session.status ? { status: session.status } : existing?.status ? { status: existing.status } : {})
	};
	if (idx >= 0) {
		index[idx] = meta;
	} else {
		index.unshift(meta);
	}
	await writeIndex(index);

	return json(session);
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		await unlink(sessionPath(params.id));
	} catch {
		// file already gone
	}

	const index = await readIndex();
	const filtered = index.filter((s) => s.id !== params.id);
	await writeIndex(filtered);

	return json({ ok: true });
};
