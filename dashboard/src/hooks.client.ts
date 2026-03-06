import * as Sentry from '@sentry/sveltekit';
import { handleErrorWithSentry } from '@sentry/sveltekit';

const dsn = import.meta.env.PUBLIC_SENTRY_DSN as string | undefined;

if (dsn) {
	Sentry.init({
		dsn,
		environment: import.meta.env.MODE,
		tracesSampleRate: 0.2,
		replaysSessionSampleRate: 0,
		replaysOnErrorSampleRate: 1.0
	});
}

export const handleError = handleErrorWithSentry();
