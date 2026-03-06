export interface Service {
	id: string;
	name: string;
	type: string;
	configPath: string;
	pid: number | null;
	port: number | null;
	secondaryPort: number | null;
	status: 'running' | 'stopped' | 'errored';
	uptime: string | null;
	ram: string | null;
	cpu: string | null;
	errorMessage: string | null;
}

export type ServiceAction = 'start' | 'stop' | 'restart';

export interface ServiceActionResult {
	success: boolean;
	message: string;
}
