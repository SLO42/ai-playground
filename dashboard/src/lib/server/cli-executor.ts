import { execFileSync, execSync } from 'child_process';

export function execCli(args: string[], timeoutMs = 30000): string {
	try {
		// On Windows, execFileSync breaks when npx resolves to a path with spaces
		// (e.g. C:\Program Files\nodejs\npx). Use execSync with shell instead.
		if (process.platform === 'win32') {
			const escaped = args.map(a => `"${a}"`).join(' ');
			return execSync(`npx @claude-flow/cli@latest ${escaped}`, {
				encoding: 'utf-8',
				timeout: timeoutMs,
				cwd: process.cwd(),
				windowsHide: true
			});
		}
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
