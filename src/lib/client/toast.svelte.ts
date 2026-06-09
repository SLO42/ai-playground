/**
 * Toast notification store (UI-SPEC §8 "Toasts + tray", §11 microcopy).
 *
 * Transient success/error/info notifications emitted from actions: auto-dismiss
 * + manual close, stacked. Svelte 5 RUNES only ($state) — never stores (D-005).
 * A module singleton so any action (a page, a palette command, an SSE handler)
 * can `toasts.push(...)` without prop-drilling; the ToastHost in the shell renders
 * `toasts.items` reactively and announces them via the app-root aria-live region.
 *
 * The reactive `$state` lives ONLY in this file; the testable state-machine
 * (push / dismiss / cap / timers) lives in the plain `./toast-core.ts` so it runs
 * in the node vitest env without the Svelte compiler. This thin wrapper bridges
 * the two: the core mutates a plain array, then re-publishes it into `$state`.
 *
 * Honest (F-008): a toast reports what actually happened — errors carry the real
 * message; we never fabricate a success. Microcopy is the caller's responsibility
 * (verb+object / past-tense success / blame-free errors, §11).
 */

import { ToastCore, type Toast, type ToastInput, type ToastKind } from './toast-core';

export type { Toast, ToastInput, ToastKind };

class ToastStore {
	/** The live stack, newest last. ToastHost renders these. */
	items = $state<Toast[]>([]);

	#core = new ToastCore(() => {
		// Re-publish the core's plain array into reactive state (new ref → triggers $derived).
		this.items = [...this.#core.items];
	});

	push(input: ToastInput): number {
		return this.#core.push(input);
	}
	success(title: string, detail?: string): number {
		return this.#core.push({ kind: 'success', title, detail });
	}
	error(title: string, detail?: string): number {
		return this.#core.push({ kind: 'error', title, detail });
	}
	info(title: string, detail?: string): number {
		return this.#core.push({ kind: 'info', title, detail });
	}
	dismiss(id: number): void {
		this.#core.dismiss(id);
	}
	clear(): void {
		this.#core.clear();
	}
}

/** App-wide singleton (one stack per tab). */
export const toasts = new ToastStore();
