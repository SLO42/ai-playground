// /logout — clear the signed session cookie, then send the browser to /login.
//
// POST is the primary (CSRF-safe with sameSite=lax) path used by a logout button.
// GET is supported too so a plain link works for the single operator — low-risk for
// casual gating (worst case: someone makes you re-enter your password).

import { redirect } from '@sveltejs/kit';
import { AUTH_COOKIE } from '$lib/server/auth/gate';
import type { RequestHandler } from './$types';

function clearAndRedirect(cookies: Parameters<RequestHandler>[0]['cookies']): never {
	cookies.delete(AUTH_COOKIE, { path: '/' });
	throw redirect(303, '/login');
}

export const POST: RequestHandler = ({ cookies }) => clearAndRedirect(cookies);
export const GET: RequestHandler = ({ cookies }) => clearAndRedirect(cookies);
