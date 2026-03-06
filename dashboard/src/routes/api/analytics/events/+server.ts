import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { PATHS } from '$lib/server/constants.js';

const EVENTS_PATH = resolve(PATHS.root, '.playground/ui-analytics.json');

interface UIEvent {
	id: string;
	category: string;
	action: string;
	label?: string;
	value?: number;
	metadata?: Record<string, unknown>;
	timestamp: string;
}

async function loadEvents(): Promise<UIEvent[]> {
	try {
		const raw = await readFile(EVENTS_PATH, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

async function saveEvents(events: UIEvent[]): Promise<void> {
	await mkdir(dirname(EVENTS_PATH), { recursive: true });
	// Keep last 500 events to avoid unbounded growth
	const trimmed = events.slice(-500);
	await writeFile(EVENTS_PATH, JSON.stringify(trimmed, null, '\t'), 'utf-8');
}

let counter = 0;

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { category, action, label, value, metadata } = body;

	if (!category || !action) {
		return json({ error: 'category and action are required' }, { status: 400 });
	}

	const event: UIEvent = {
		id: `ui-${Date.now()}-${++counter}`,
		category: String(category),
		action: String(action),
		label: label ? String(label) : undefined,
		value: typeof value === 'number' ? value : undefined,
		metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
		timestamp: new Date().toISOString()
	};

	const events = await loadEvents();
	events.push(event);
	await saveEvents(events);

	return json({ ok: true, id: event.id });
};

export const GET: RequestHandler = async ({ url }) => {
	const events = await loadEvents();
	const category = url.searchParams.get('category');
	const filtered = category ? events.filter(e => e.category === category) : events;
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 500);
	return json(filtered.slice(-limit));
};
