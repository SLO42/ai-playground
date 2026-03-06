import { json } from '@sveltejs/kit';
import { syncMemoryBridge } from '$lib/server/memory-bridge.js';

/** POST /api/memory/sync — manually trigger memory bridge sync */
export async function POST() {
	try {
		const result = await syncMemoryBridge();
		return json(result);
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'sync failed';
		return json({ error: msg }, { status: 500 });
	}
}
