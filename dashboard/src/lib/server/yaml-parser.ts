import yaml from 'js-yaml';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { readTextFile } from './file-reader.js';

export async function readYamlFile<T>(path: string): Promise<T | null> {
	const content = await readTextFile(path);
	if (!content) return null;
	try {
		return yaml.load(content) as T;
	} catch {
		return null;
	}
}

export async function writeYamlFile(path: string, header: string, data: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const content = header + yaml.dump(data, { lineWidth: 120, noRefs: true });
	await writeFile(path, content, 'utf-8');
}
