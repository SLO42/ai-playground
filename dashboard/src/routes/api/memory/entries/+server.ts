import { json } from '@sveltejs/kit';
import { readFile, writeFile } from 'fs/promises';
import { PATHS } from '$lib/server/constants.js';
import type { AutoMemoryEntry } from '$lib/types/memory.js';

async function loadEntries(): Promise<AutoMemoryEntry[]> {
	try {
		const raw = await readFile(PATHS.autoMemoryStore, 'utf-8');
		return JSON.parse(raw) as AutoMemoryEntry[];
	} catch {
		return [];
	}
}

async function saveEntries(entries: AutoMemoryEntry[]): Promise<void> {
	await writeFile(PATHS.autoMemoryStore, JSON.stringify(entries, null, '\t'), 'utf-8');
}

/** DELETE /api/memory/entries — remove entries by ID list */
export async function DELETE({ request }) {
	const body = await request.json() as { ids: string[] };
	if (!Array.isArray(body.ids) || body.ids.length === 0) {
		return json({ error: 'ids array required' }, { status: 400 });
	}

	const entries = await loadEntries();
	const idsToRemove = new Set(body.ids);
	const filtered = entries.filter(e => !idsToRemove.has(e.id));
	const removed = entries.length - filtered.length;

	if (removed === 0) {
		return json({ removed: 0, message: 'no matching entries found' });
	}

	await saveEntries(filtered);
	return json({ removed, remaining: filtered.length });
}
