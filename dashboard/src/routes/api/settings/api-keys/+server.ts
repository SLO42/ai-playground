/**
 * API keys settings — check which keys are set, update keys in .env file.
 * Data stored at: .env (project root). Only allows a whitelist of key names.
 */
import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { PATHS } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';

const ALLOWED_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN'];

export const GET: RequestHandler = async () => {
	const status = ALLOWED_KEYS.map((name) => ({
		name,
		set: !!process.env[name]
	}));
	return json(status);
};

export const PUT: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const name = body.name;
	const value = body.value;

	if (typeof name !== 'string' || typeof value !== 'string') {
		return json({ error: 'Missing name or value' }, { status: 400 });
	}

	if (!ALLOWED_KEYS.includes(name)) {
		return json({ error: 'Key not allowed' }, { status: 400 });
	}

	if (!value.trim()) {
		return json({ error: 'Value cannot be empty' }, { status: 400 });
	}

	try {
		// Read existing .env or start fresh
		let envContent = '';
		try {
			envContent = await readFile(PATHS.envFile, 'utf-8');
		} catch {
			// .env doesn't exist yet
		}

		// Parse existing lines, update or append the key
		const lines = envContent.split(/\r?\n/);
		const pattern = new RegExp(`^${name}=`);
		let found = false;
		for (let i = 0; i < lines.length; i++) {
			if (pattern.test(lines[i])) {
				lines[i] = `${name}=${value.trim()}`;
				found = true;
				break;
			}
		}
		if (!found) {
			// Append, ensuring there's a newline before if content exists
			if (envContent.length > 0 && !envContent.endsWith('\n')) {
				lines.push('');
			}
			lines.push(`${name}=${value.trim()}`);
		}

		await mkdir(dirname(PATHS.envFile), { recursive: true });
		await writeFile(PATHS.envFile, lines.join('\n'), 'utf-8');

		// Update process.env so subsequent reads reflect the change
		process.env[name] = value.trim();

		return json({ ok: true });
	} catch (e) {
		console.error('[api/settings/api-keys] PUT failed:', e);
		return json({ error: 'Failed to save API key' }, { status: 500 });
	}
};
