import { json } from '@sveltejs/kit';

export async function GET() {
	return json({
		id: crypto.randomUUID().slice(0, 8),
		startedAt: new Date().toISOString(),
		status: 'active'
	});
}
