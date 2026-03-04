import { execFileSync } from 'child_process';

export function execCli(args: string[], timeoutMs = 30000): string {
	try {
		const result = execFileSync('npx', ['@claude-flow/cli@latest', ...args], {
			encoding: 'utf-8',
			timeout: timeoutMs,
			cwd: process.cwd(),
			windowsHide: true
		});
		return result;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'CLI execution failed';
		throw new Error(message);
	}
}
