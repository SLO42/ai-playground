/**
 * Task Suggestion Inbox — a shared drop-off point for improvement tasks.
 *
 * Any system component (sub-agents, heartbeat, daemon, API callers) can
 * write suggestions here. The heartbeat processes them each cycle,
 * creating real tasks after deduplication.
 *
 * File: .playground/task-suggestions.json
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { PATHS } from './constants.js';
import { createTask, getAllTasks } from './task-store.js';
import { pushNotification } from './notifications.js';

// ── Types ────────────────────────────────────────────────────────────

export interface TaskSuggestion {
	title: string;
	description?: string;
	priority?: 'critical' | 'high' | 'medium' | 'low';
	tags?: string[];
	feature?: string;
	source: string;           // who suggested it: 'agent:<taskId>', 'heartbeat', 'daemon', 'user', etc.
	suggestedAt?: string;     // ISO timestamp
}

interface SuggestionFile {
	suggestions: TaskSuggestion[];
}

// ── Storage ──────────────────────────────────────────────────────────

const SUGGESTIONS_PATH = resolve(PATHS.root, '.playground/task-suggestions.json');

async function readSuggestions(): Promise<SuggestionFile> {
	try {
		const raw = await readFile(SUGGESTIONS_PATH, 'utf-8');
		const data = JSON.parse(raw);
		if (Array.isArray(data.suggestions)) return data;
		// Legacy: bare array
		if (Array.isArray(data)) return { suggestions: data };
		return { suggestions: [] };
	} catch {
		return { suggestions: [] };
	}
}

async function writeSuggestions(file: SuggestionFile): Promise<void> {
	await mkdir(dirname(SUGGESTIONS_PATH), { recursive: true });
	await writeFile(SUGGESTIONS_PATH, JSON.stringify(file, null, '\t'), 'utf-8');
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Add one or more suggestions to the inbox.
 * Safe to call from any context (agents, heartbeat, API handlers).
 */
export async function suggestTasks(suggestions: TaskSuggestion[]): Promise<number> {
	if (suggestions.length === 0) return 0;

	const file = await readSuggestions();
	const now = new Date().toISOString();

	for (const s of suggestions) {
		if (!s.title?.trim()) continue;
		file.suggestions.push({
			...s,
			title: s.title.trim(),
			suggestedAt: s.suggestedAt ?? now
		});
	}

	await writeSuggestions(file);
	return suggestions.filter(s => s.title?.trim()).length;
}

/**
 * Process the suggestion inbox — create real tasks, dedup, and clear.
 * Called by the heartbeat each cycle.
 * Returns the number of tasks created.
 */
export async function processSuggestions(projectPath?: string): Promise<{ created: number; skipped: number; sources: string[] }> {
	const root = projectPath ?? PATHS.root;
	const file = await readSuggestions();

	if (file.suggestions.length === 0) {
		return { created: 0, skipped: 0, sources: [] };
	}

	// Load existing tasks for dedup
	const existing = await getAllTasks(root);
	const existingTitles = new Set(existing.map(t => t.title.toLowerCase().trim()));

	let created = 0;
	let skipped = 0;
	const sources = new Set<string>();

	for (const suggestion of file.suggestions) {
		if (!suggestion.title?.trim()) {
			skipped++;
			continue;
		}

		// Dedup by title
		if (existingTitles.has(suggestion.title.toLowerCase().trim())) {
			skipped++;
			continue;
		}

		try {
			await createTask(root, {
				title: suggestion.title,
				description: suggestion.description,
				priority: suggestion.priority ?? 'medium',
				tags: [...(suggestion.tags ?? []), 'auto-suggested'],
				feature: suggestion.feature ?? null,
				assignee: 'claw',
				createdBy: suggestion.source ?? 'system'
			});

			existingTitles.add(suggestion.title.toLowerCase().trim());
			sources.add(suggestion.source ?? 'unknown');
			created++;
		} catch {
			skipped++;
		}
	}

	// Clear the inbox
	await writeSuggestions({ suggestions: [] });

	// Notify if tasks were created
	if (created > 0) {
		const sourceList = [...sources].join(', ');
		await pushNotification({
			severity: 'info',
			category: 'task',
			title: `${created} improvement task(s) suggested`,
			message: `From: ${sourceList}`,
			source: 'claw',
			link: '/tasks',
			linkLabel: 'View Tasks'
		}).catch(() => {});
	}

	return { created, skipped, sources: [...sources] };
}

/**
 * Get current inbox size (for display/monitoring).
 */
export async function getSuggestionCount(): Promise<number> {
	const file = await readSuggestions();
	return file.suggestions.length;
}

/**
 * Peek at current suggestions without processing them.
 */
export async function peekSuggestions(): Promise<TaskSuggestion[]> {
	const file = await readSuggestions();
	return file.suggestions;
}
