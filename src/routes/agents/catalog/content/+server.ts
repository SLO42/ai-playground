// /agents/catalog/content?path=<relPath> — lazy per-agent file content for the detail panel.
//
// Returns ONE library agent's when-to-use body + raw file on demand, so the catalog list load
// stays bounded (F-014) instead of shipping every body up-front. The `path` is the agent's
// relPath from the listing; readLibraryAgentContent CONFINES it under the agents dir (traversal
// fails closed) before reading. Honest 404 when the library is unresolvable or the path invalid
// (the panel renders "file not readable", never fabricated text — F-008).

import { json, error } from '@sveltejs/kit';
import { readLibraryAgentContent } from '$lib/server/agent-library';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('path') ?? '';
	if (!path.trim()) throw error(400, 'missing path');
	const content = readLibraryAgentContent(path);
	if (!content) throw error(404, 'agent file not found or unreadable');
	return json(content);
};
