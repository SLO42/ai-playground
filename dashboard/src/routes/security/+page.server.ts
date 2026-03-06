import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { AuditStatus, SecurityFinding } from '$lib/types/security.js';
import type { SecurityPolicy } from '$lib/types/security.js';

interface ScanFindingsFile {
	scannedAt: string;
	findings: Array<{ severity: string; issue: string; detail: string }>;
}

export const load: PageServerLoad = async () => {
	const [audit, policy, scanFile] = await Promise.all([
		readJsonFile<AuditStatus>(PATHS.auditStatus),
		readYamlFile<SecurityPolicy>(PATHS.networkPolicy),
		readJsonFile<ScanFindingsFile>(PATHS.scanFindings)
	]);

	const scanFindings: SecurityFinding[] = (scanFile?.findings ?? []).map((f) => ({
		severity: f.severity as SecurityFinding['severity'],
		issue: f.issue,
		detail: f.detail,
		detected: scanFile?.scannedAt
	}));

	return { audit, policy, scanFindings };
};
