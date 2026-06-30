// /setup — FIRST-RUN ONLY: set the operator password for the non-loopback login gate.
//
// TOFU caveat (trust-on-first-use): before any password is set, this page is reachable
// by anyone who can hit the listener — including the first LAN visitor, who could claim
// the credential. The mitigations: the control plane binds loopback only (D-025), so on
// a normal local-only run no LAN client can reach it at all; and the operator is expected
// to set the password locally before exposing the LAN listener. The on-page note states
// this. (Setting the password from loopback is always login-free.)

import { fail, redirect } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { credentialExists, setCredential } from '$lib/server/auth/credential';
import { AUTH_COOKIE, AUTH_COOKIE_OPTIONS, signSessionToken } from '$lib/server/auth/gate';
import type { Actions, PageServerLoad } from './$types';

const MIN_LEN = 8;

export const load: PageServerLoad = async ({ locals }) => {
	const db = tryGetDb();
	const exists = db ? await credentialExists(db).catch(() => false) : false;
	// Already configured → there is nothing to set up; send the operator to sign in.
	if (exists) throw redirect(303, '/login');
	return { dbAvailable: !!db, isLoopback: locals.auth.isLoopback };
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { error: 'Database unavailable — cannot set the password right now.' });
		// Re-check under the action (a credential may have appeared since the load).
		if (await credentialExists(db).catch(() => false)) {
			return fail(409, { error: 'A password is already set. Sign in instead.' });
		}
		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const confirm = String(form.get('confirm') ?? '');
		if (password.length < MIN_LEN) {
			return fail(400, { error: `Password must be at least ${MIN_LEN} characters.` });
		}
		if (password !== confirm) return fail(400, { error: 'Passwords do not match.' });

		// Store the salted scrypt hash + mint the HMAC sign-secret, then sign this
		// browser straight in (the plaintext is never persisted — D-026).
		const { signSecret } = await setCredential(db, password);
		cookies.set(AUTH_COOKIE, signSessionToken(signSecret), { ...AUTH_COOKIE_OPTIONS });
		throw redirect(303, '/');
	}
};
