import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
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

export async function writeJsonFile(path: string, data: unknown): Promise<boolean> {
	if (!isPathAllowed(path)) {
		console.error(`Path not allowed: ${path}`);
		return false;
	}
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
		return true;
	} catch (err) {
		console.error(`Failed to write ${path}:`, err);
		return false;
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
