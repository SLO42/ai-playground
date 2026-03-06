import { json } from '@sveltejs/kit';
import { readFile } from 'fs/promises';
import { PATHS } from '$lib/server/constants.js';

export async function GET() {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/current.json`, 'utf-8');
		const current = JSON.parse(raw);
		return json(current);
	} catch {
		return json({ id: null, status: 'none' });
	}
}
