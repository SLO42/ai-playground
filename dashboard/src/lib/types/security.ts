export interface CveFix {
	description: string;
	fixedBy: string;
	fixedAt: string;
}

export interface AuditStatus {
	initialized: string;
	status: 'CLEAN' | 'PENDING' | 'VULNERABLE';
	cvesFixed: number;
	totalCves: number;
	lastScan: string;
	fixes: Record<string, CveFix>;
	additionalFixes: string[];
}

export interface FirewallRule {
	name: string;
	port?: number;
	protocol: string;
	source?: string;
	destination?: string;
	action: string;
}

export interface ValidationRule {
	name: string;
	description: string;
	action: string;
	severity: string;
}

export interface RbacRole {
	name: string;
	permissions: string[];
}

export interface SecurityPolicy {
	version: string;
	lastUpdated: string;
	firewall: {
		defaultAction: string;
		inbound: FirewallRule[];
		outbound: FirewallRule[];
	};
	inputValidation: {
		enabled: boolean;
		rules: ValidationRule[];
	};
	accessControl?: {
		rbac?: {
			roles: RbacRole[];
		};
		session?: Record<string, unknown>;
	};
	sandbox?: Record<string, unknown>;
}
