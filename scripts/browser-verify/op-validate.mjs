// op-validate — pure boundary validators for the browser-verify daemon ops
// (TASK 15.3 B9: the `press` + `text` ops added so codified verify-flows can
// drive keyboard-only UI (Ctrl+K palette) and assert page text truth).
//
// Pure + dependency-free so they unit-test in node (op-validate.test.ts) and
// the daemon stays the single place that touches the page. Every rejection is
// a NAMED error (D-016 boundary validation; "every error has a name").

/** @param {string} name @param {string} message */
function namedError(name, message) {
	const err = new Error(message);
	err.name = name;
	return err;
}

/**
 * Validate a Playwright keyboard key/chord (e.g. "Escape", "Enter",
 * "Control+KeyK", "Shift+Tab"). Segments are alphanumeric key names joined by
 * '+', max 4 segments, bounded length — nothing else reaches page.keyboard.
 *
 * Shadow paths: nil/non-string → press-key-invalid; empty → press-key-invalid.
 *
 * @param {unknown} raw
 * @returns {string} the validated key
 * @throws {Error} name `press-key-invalid`
 */
export function validatePressKey(raw) {
	if (typeof raw !== 'string' || raw.length === 0) {
		throw namedError('press-key-invalid', `press: key is required (got ${JSON.stringify(raw)})`);
	}
	if (raw.length > 40) {
		throw namedError('press-key-invalid', `press: key too long (${raw.length} > 40 chars)`);
	}
	if (!/^[A-Za-z0-9]+(\+[A-Za-z0-9]+){0,3}$/.test(raw)) {
		throw namedError(
			'press-key-invalid',
			`press: key must be a Playwright key/chord like "Escape" or "Control+KeyK", got ${JSON.stringify(raw)}`
		);
	}
	return raw;
}

/**
 * Validate a CSS selector string for the read-only `text` op. Bounds type and
 * length here; SYNTACTIC validity is judged in-page by querySelectorAll (the
 * browser is the authority on selector grammar) and surfaces as the same
 * named error from the daemon.
 *
 * Shadow paths: nil/non-string → text-selector-invalid; empty →
 * text-selector-invalid; control characters rejected.
 *
 * @param {unknown} raw
 * @returns {string} the validated selector
 * @throws {Error} name `text-selector-invalid`
 */
export function validateTextSelector(raw) {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw namedError(
			'text-selector-invalid',
			`text: a CSS selector is required (got ${JSON.stringify(raw)})`
		);
	}
	if (raw.length > 250) {
		throw namedError('text-selector-invalid', `text: selector too long (${raw.length} > 250 chars)`);
	}
	// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
	if (/[\u0000-\u001f\u007f]/.test(raw)) {
		throw namedError('text-selector-invalid', 'text: selector contains control characters');
	}
	return raw;
}
