import { json, error } from '@sveltejs/kit';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { resolve } from 'path';
import { createInterface } from 'readline';
import { PATHS } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';

export interface ConversationEvent {
	s: number;
	ts: string;
	t: 'prompt' | 'tool' | 'stop';
	d?: string;
	len?: number;
	n?: string;
	f?: string;
	ok?: boolean;
}

export const GET: RequestHandler = async ({ params, url }) => {
	const id = params.id;

	// Validate ID format: session-\d+ or "current"
	if (id !== 'current' && !/^session-\d+$/.test(id)) {
		throw error(400, 'Invalid session ID format');
	}

	const after = Math.max(0, parseInt(url.searchParams.get('after') ?? '0', 10));
	const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '100', 10)));

	const filename = id === 'current' ? 'events-current.jsonl' : `events-${id}.jsonl`;
	const filePath = resolve(PATHS.sessionsDir, filename);

	try {
		await stat(filePath);
	} catch {
		return json({ events: [], nextCursor: 0, total: 0 });
	}

	return new Promise((res) => {
		const events: ConversationEvent[] = [];
		let total = 0;
		let lastSeq = 0;

		const rl = createInterface({
			input: createReadStream(filePath, 'utf-8'),
			crlfDelay: Infinity
		});

		rl.on('line', (line) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as ConversationEvent;
				total++;
				if (event.s > after && events.length < limit) {
					events.push(event);
				}
				if (event.s > lastSeq) lastSeq = event.s;
			} catch {
				// Skip malformed lines
			}
		});

		rl.on('close', () => {
			res(json({
				events,
				nextCursor: events.length > 0 ? events[events.length - 1].s : after,
				total
			}));
		});

		rl.on('error', () => {
			res(json({ events: [], nextCursor: 0, total: 0 }));
		});
	});
};
