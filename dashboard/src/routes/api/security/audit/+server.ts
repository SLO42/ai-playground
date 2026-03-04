import { json } from '@sveltejs/kit';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { AuditStatus } from '$lib/types/security.js';

export async function GET() {
	const data = await readJsonFile<AuditStatus>(PATHS.auditStatus);
	return json(data);
}
