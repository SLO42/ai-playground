/**
 * Confirm + gate reactive store (UI-SPEC §8 / §165; D-010 diff+confirm;
 * D-018/D-024 gates). Svelte 5 RUNES only ($state) — never stores (D-005).
 *
 * The state-machine lives in the pure `./confirm-core.ts` (node-testable); this
 * thin wrapper holds the `$state` and re-publishes the core's fields on change.
 * A module singleton so any action can `await confirm.confirm({...})` (blocking)
 * or `confirm.raiseGate({...})` (non-blocking) without prop-drilling; the shell
 * mounts the ConfirmDialog + GateBanner host reading these reactively.
 */

import {
	ConfirmCore,
	type ConfirmRequest,
	type DiffLine,
	type GateBannerItem,
	type GateSeverity
} from './confirm-core';

export type { ConfirmRequest, DiffLine, GateBannerItem, GateSeverity };

class ConfirmStore {
	/** The active blocking confirm request (null when none open). */
	request = $state<ConfirmRequest | null>(null);
	/** The non-blocking gate banner stack. */
	gates = $state<GateBannerItem[]>([]);

	#core = new ConfirmCore(() => {
		this.request = this.#core.active?.request ?? null;
		this.gates = [...this.#core.gates];
	});

	/** Open a blocking confirm; resolves true (confirmed) / false (cancelled). */
	confirm(request: ConfirmRequest): Promise<boolean> {
		return this.#core.confirm(request);
	}
	accept(): void {
		this.#core.accept();
	}
	cancel(): void {
		this.#core.cancel();
	}

	/** Raise / dismiss / clear non-blocking gate banners. */
	raiseGate(item: Omit<GateBannerItem, 'id'>): number {
		return this.#core.raiseGate(item);
	}
	dismissGate(id: number): void {
		this.#core.dismissGate(id);
	}
	clearGates(): void {
		this.#core.clearGates();
	}
}

export const confirm = new ConfirmStore();
