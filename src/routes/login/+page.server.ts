// /login — sign in (verify password → set signed cookie) for non-loopback access,
// plus a change-password action for an authed (or loopback) operator.

import { fail, redirect } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	changePassword,
	credentialExists,
	readCredential,
	verifyPassword
} from '$lib/server/auth/credential';
import {
	AUTH_COOKIE,
	AUTH_COOKIE_OPTIONS,
	safeNext,
	signSessionToken,
	verifySessionToken
} from '$lib/server/auth/gate';
import type { Actions, PageServerLoad } from './$types';

const MIN_LEN = 8;

/** True iff this request may manage the password: loopback, or a valid session cookie. */
async function canManage(
	db: ReturnType<typeof tryGetDb>,
	cookieToken: string | undefined,
	isLoopback: boolean
): Promise<boolean> {
	if (isLoopback) return true;
	if (!db) return false;
	const cred = await readCredential(db).catch(() => null);
	return !!cred && verifySessionToken(cookieToken, cred.signSecret);
}

export const load: PageServerLoad = async ({ locals, cookies, url }) => {
	const db = tryGetDb();
	const exists = db ? await credentialExists(db).catch(() => false) : false;
	// First run (DB up, no credential) → there is nothing to sign into yet.
	if (db && !exists) throw redirect(303, '/setup');
	const manage = await canManage(db, cookies.get(AUTH_COOKIE), locals.auth.isLoopback);
	return {
		dbAvailable: !!db,
		isLoopback: locals.auth.isLoopback,
		canManage: manage,
		next: safeNext(url.searchParams.get('next'))
	};
};

export const actions: Actions = {
	// Verify the password and, on success, set the signed session cookie. Named (not
	// `default`) because this page also exposes `changePassword`, and SvelteKit forbids
	// mixing a default action with named ones.
	login: async ({ request, cookies, locals }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { login: { error: 'Database unavailable — try again shortly.' } });
		const cred = await readCredential(db).catch(() => null);
		if (!cred) throw redirect(303, '/setup');

		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const next = safeNext(String(form.get('next') ?? '/'));
		if (!verifyPassword(password, cred.passwordHash, cred.passwordSalt)) {
			// Honest, non-enumerating message; never echo the attempt.
			return fail(401, { login: { error: 'Incorrect password.' } });
		}
		cookies.set(AUTH_COOKIE, signSessionToken(cred.signSecret), { ...AUTH_COOKIE_OPTIONS });
		locals.auth.authed = true;
		throw redirect(303, next);
	},

	// Change the password — only for a loopback or already-authed operator.
	changePassword: async ({ request, cookies, locals }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { manage: { error: 'Database unavailable — try again shortly.' } });
		if (!(await canManage(db, cookies.get(AUTH_COOKIE), locals.auth.isLoopback))) {
			return fail(403, { manage: { error: 'Sign in (or use the local machine) to change the password.' } });
		}
		if (!(await credentialExists(db).catch(() => false))) throw redirect(303, '/setup');

		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const confirm = String(form.get('confirm') ?? '');
		if (password.length < MIN_LEN) {
			return fail(400, { manage: { error: `Password must be at least ${MIN_LEN} characters.` } });
		}
		if (password !== confirm) return fail(400, { manage: { error: 'Passwords do not match.' } });

		// Keeps the existing sign-secret, so the current cookie stays valid (no re-login).
		await changePassword(db, password);
		return { manage: { ok: true } };
	}
};
