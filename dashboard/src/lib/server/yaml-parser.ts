import yaml from 'js-yaml';
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
