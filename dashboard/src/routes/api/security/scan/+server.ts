import { json } from '@sveltejs/kit';
import { execCli } from '$lib/server/cli-executor.js';

export async function POST() {
	try {
		const result = execCli(['security', 'scan'], 30000);
		return json({ success: true, output: result });
	} catch (err) {
		return json({ success: false, error: String(err) }, { status: 500 });
	}
}
