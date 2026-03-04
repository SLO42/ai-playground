export async function fetchApi<T>(path: string): Promise<T | null> {
	try {
		const res = await fetch(path);
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}
