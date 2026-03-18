import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { withLock } from '$lib/server/async-mutex.js';
import type { AutoMemoryEntry } from '$lib/types/memory.js';
import crypto from 'crypto';

async function loadEntries(): Promise<AutoMemoryEntry[]> {
	try {
		const raw = await readFile(PATHS.autoMemoryStore, 'utf-8');
		return JSON.parse(raw) as AutoMemoryEntry[];
	} catch {
		return [];
	}
}

async function saveEntries(entries: AutoMemoryEntry[]): Promise<void> {
	await mkdir(dirname(PATHS.autoMemoryStore), { recursive: true });
	await writeFile(PATHS.autoMemoryStore, JSON.stringify(entries, null, '\t'), 'utf-8');
}

/** GET /api/memory/entries — list entries, optionally filtered by namespace/type */
export async function GET({ url }) {
	const namespace = url.searchParams.get('namespace');
	const type = url.searchParams.get('type');

	let entries = await loadEntries();

	if (namespace) {
		entries = entries.filter(e => e.namespace === namespace);
	}
	if (type) {
		entries = entries.filter(e => e.type === type);
	}

	return json({ entries, total: entries.length });
}

/** POST /api/memory/entries — create a new entry */
export async function POST({ request }) {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const key = typeof body.key === 'string' ? body.key.trim() : '';
	const content = typeof body.content === 'string' ? body.content.trim() : '';

	if (!key) {
		return json({ error: 'key is required' }, { status: 400 });
	}
	if (!content) {
		return json({ error: 'content is required' }, { status: 400 });
	}

	const entry: AutoMemoryEntry = {
		id: typeof body.id === 'string' && body.id.trim()
			? body.id.trim()
			: crypto.randomUUID().slice(0, 12),
		key,
		content,
		summary: typeof body.summary === 'string' ? body.summary : content.slice(0, 120),
		namespace: typeof body.namespace === 'string' ? body.namespace : 'default',
		type: typeof body.type === 'string' ? body.type : undefined,
		metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
			? body.metadata as Record<string, unknown>
			: undefined,
		createdAt: Date.now()
	};

	const created = await withLock(PATHS.autoMemoryStore, async () => {
		const entries = await loadEntries();
		entries.push(entry);
		await saveEntries(entries);
		return entry;
	});

	return json({ entry: created }, { status: 201 });
}

/** DELETE /api/memory/entries — remove entries by ID list */
export async function DELETE({ request }) {
	const body = await request.json() as { ids: string[] };
	if (!Array.isArray(body.ids) || body.ids.length === 0) {
		return json({ error: 'ids array required' }, { status: 400 });
	}

	return withLock(PATHS.autoMemoryStore, async () => {
		const entries = await loadEntries();
		const idsToRemove = new Set(body.ids);
		const filtered = entries.filter(e => !idsToRemove.has(e.id));
		const removed = entries.length - filtered.length;

		if (removed === 0) {
			return json({ removed: 0, message: 'no matching entries found' });
		}

		await saveEntries(filtered);
		return json({ removed, remaining: filtered.length });
	});
}
