import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { AuditStatus } from '$lib/types/security.js';
import type { SecurityPolicy } from '$lib/types/security.js';

export const load: PageServerLoad = async () => {
	const [audit, policy] = await Promise.all([
		readJsonFile<AuditStatus>(PATHS.auditStatus),
		readYamlFile<SecurityPolicy>(PATHS.networkPolicy)
	]);

	return { audit, policy };
};
