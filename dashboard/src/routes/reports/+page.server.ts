import type { PageServerLoad } from './$types.js';
import { listReports, getReport, generateTimeSeries } from '$lib/server/reports.js';

export const load: PageServerLoad = async ({ url }) => {
	const reports = await listReports();

	// Load the most recent report, or the one requested
	const requestedType = url.searchParams.get('type') ?? 'daily';
	const requestedDate = url.searchParams.get('date');

	let activeReport = null;
	if (requestedDate) {
		activeReport = await getReport(requestedType as any, requestedDate);
	} else if (reports.length > 0) {
		activeReport = await getReport(reports[0].type, reports[0].date);
	}

	// Generate time-series data for the active report's period
	let timeSeries = null;
	if (activeReport) {
		const periodStart = new Date(activeReport.periodStart);
		const periodEnd = new Date(activeReport.periodEnd);
		// Only generate charts for weekly+ reports (2+ days)
		const daySpan = (periodEnd.getTime() - periodStart.getTime()) / 86400_000;
		if (daySpan >= 2) {
			timeSeries = await generateTimeSeries(periodStart, periodEnd);
		}
	}

	return {
		reports,
		activeReport,
		timeSeries
	};
};
