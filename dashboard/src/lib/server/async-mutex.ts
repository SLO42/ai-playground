/**
 * Per-key async mutex to prevent concurrent read-modify-write races on JSON files.
 * Usage: await withLock('path/to/file.json', async () => { read, modify, write });
 */
const locks = new Map<string, Promise<void>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(key) ?? Promise.resolve();
	let release: () => void;
	const next = new Promise<void>(r => { release = r; });
	locks.set(key, next);
	await prev;
	try {
		return await fn();
	} finally {
		release!();
		if (locks.get(key) === next) locks.delete(key);
	}
}
