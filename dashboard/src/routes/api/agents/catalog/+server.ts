import { json } from '@sveltejs/kit';
import type { AgentDefinition } from '$lib/types/agents.js';
import { scanAgents } from '$lib/server/agent-scanner.js';

let cache: { data: AgentDefinition[]; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

export async function GET() {
	if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
		return json(cache.data);
	}

	try {
		const agents = await scanAgents();
		cache = { data: agents, timestamp: Date.now() };
		return json(agents);
	} catch {
		return json([], { status: 500 });
	}
}
