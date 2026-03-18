import type { PageServerLoad } from './$types.js';
import { resolve } from 'path';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { AuditStatus, SecurityFinding, SecurityPolicy } from '$lib/types/security.js';

interface ScanFindingsFile {
	scannedAt: string;
	findings: Array<{ severity: string; issue: string; detail: string; component?: string }>;
}

export const load: PageServerLoad = async ({ params }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	const projectPath = project?.path ?? PATHS.root;

	// Try project-specific security files first, fall back to global
	const projectAuditPath = resolve(projectPath, '.playground', 'security-audit.json');
	const projectScanPath = resolve(projectPath, '.playground', 'security-findings.json');
	const projectPolicyPath = resolve(projectPath, 'config', 'security', 'network-policy.yaml');

	const [projectAudit, projectScan, projectPolicy, globalAudit, globalScan, globalPolicy] =
		await Promise.all([
			readJsonFile<AuditStatus>(projectAuditPath),
			readJsonFile<ScanFindingsFile>(projectScanPath),
			readYamlFile<SecurityPolicy>(projectPolicyPath),
			readJsonFile<AuditStatus>(PATHS.auditStatus),
			readJsonFile<ScanFindingsFile>(PATHS.scanFindings),
			readYamlFile<SecurityPolicy>(PATHS.networkPolicy)
		]);

	const audit = projectAudit ?? globalAudit;
	const scanFile = projectScan ?? globalScan;
	const policy = projectPolicy ?? globalPolicy;

	const scanFindings: SecurityFinding[] = (scanFile?.findings ?? []).map((f) => ({
		severity: f.severity as SecurityFinding['severity'],
		issue: f.issue,
		detail: f.detail,
		component: f.component,
		detected: scanFile?.scannedAt
	}));

	return {
		audit,
		policy,
		scanFindings,
		projectPath
	};
};
