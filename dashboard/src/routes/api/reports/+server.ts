import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { generateReport, listReports, getReport, generateTimeSeries, type ReportType } from '$lib/server/reports.js';

async function getTimeSeriesForReport(report: { periodStart: string; periodEnd: string }) {
	const periodStart = new Date(report.periodStart);
	const periodEnd = new Date(report.periodEnd);
	const daySpan = (periodEnd.getTime() - periodStart.getTime()) / 86400_000;
	if (daySpan >= 2) {
		return generateTimeSeries(periodStart, periodEnd);
	}
	return null;
}

export const GET: RequestHandler = async ({ url }) => {
	const type = url.searchParams.get('type') as ReportType | null;
	const date = url.searchParams.get('date');

	// Get specific report
	if (type && date) {
		const report = await getReport(type, date);
		if (!report) return json({ error: 'Report not found' }, { status: 404 });
		const timeSeries = await getTimeSeriesForReport(report);
		return json({ report, timeSeries });
	}

	// List all reports
	const reports = await listReports();
	return json({ reports });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const type = (body.type as ReportType) ?? 'daily';
	const validTypes: ReportType[] = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
	if (!validTypes.includes(type)) {
		return json({ error: `type must be one of: ${validTypes.join(', ')}` }, { status: 400 });
	}

	const report = await generateReport(type, { source: body.source as string });
	const timeSeries = await getTimeSeriesForReport(report);
	return json({ report, timeSeries }, { status: 201 });
};
