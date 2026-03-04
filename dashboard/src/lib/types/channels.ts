export interface GatewayConfig {
	gateway: {
		host: string;
		port: number;
		protocol: string;
		verbose: boolean;
		tls: {
			enabled: boolean;
			minVersion: string;
		};
		auth: {
			mode: string;
			tokenRotationInterval: string;
			maxSessionDuration: string;
			requireMFA: boolean;
		};
		rateLimit: {
			enabled: boolean;
			maxRequestsPerMinute: number;
			maxConnectionsPerIP: number;
			burstLimit: number;
		};
		cors: {
			enabled: boolean;
			allowedOrigins: string[];
			allowedMethods: string[];
			allowCredentials: boolean;
		};
	};
	dm: {
		policy: string;
		pairingCodeExpiry: string;
		maxPairingAttempts: number;
		allowlist: string[];
		blocklist: string[];
	};
}

export interface ChannelConfig {
	channel: string;
	enabled: boolean;
	auth?: Record<string, string>;
	join?: string[];
	activation: string;
	requireMention: boolean;
	commandPrefix: string;
	users: {
		mode: string;
		allowlist: string[];
		ignoreUnknown: boolean;
		logDenied: boolean;
	};
	rateLimit: Record<string, number>;
	formatting: Record<string, unknown>;
}
