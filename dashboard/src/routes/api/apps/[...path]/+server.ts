import { json } from '@sveltejs/kit';

export async function GET() {
	return json({ error: 'Not implemented' }, { status: 501 });
}

export async function POST() {
	return json({ error: 'Not implemented' }, { status: 501 });
}
