// server/scanner — public barrel (TASK 1.1; ARCHITECTURE §2.7, depends on: db).
//
// Ecosystem/mod detection (pure) + project registry upsert (db-backed). The
// registry IS the SurrealDB `project` table (no registry.json).

export {
	detectEcosystem,
	readRepoUrl,
	slugify,
	type Detection
} from './detect';

export {
	scanProject,
	confineToRoot,
	PathConfinementError,
	type ProjectRow,
	type ScanOptions
} from './registry';

export {
	scanSecurity,
	type SecurityFinding,
	type Severity,
	type SecurityScanOptions
} from './security';

export {
	scanProjectSecurity,
	writeFindings,
	listFindings,
	listAllFindings,
	archiveActiveFindings,
	type FindingRow,
	type ScanSecurityOptions
} from './findings-repo';
