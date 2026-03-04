import { readFile } from 'fs/promises';
import { isPathAllowed } from './constants.js';

export async function readJsonFile<T>(path: string): Promise<T | null> {
	if (!isPathAllowed(path)) {
		console.error(`Path not allowed: ${path}`);
		return null;
	}
	try {
		const content = await readFile(path, 'utf-8');
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

export async function readTextFile(path: string): Promise<string | null> {
	if (!isPathAllowed(path)) {
		console.error(`Path not allowed: ${path}`);
		return null;
	}
	try {
		return await readFile(path, 'utf-8');
	} catch {
		return null;
	}
}
