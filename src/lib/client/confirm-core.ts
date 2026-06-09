/**
 * Confirm + gate state-machine core — pure (no Svelte runes), unit-testable in
 * the node vitest env. The reactive wrapper (`confirm.svelte.ts`) holds `$state`
 * and re-publishes this core's plain fields on every change via `onChange`.
 *
 * Two distinct primitives (UI-SPEC §8 / §165, D-010 / D-018 / D-024):
 *   • ConfirmDialog  — a BLOCKING modal confirm with a summary and an optional
 *     unified diff (the D-010 "diff + confirm" for config writes). Promise-based:
 *     `confirm(req)` resolves true (confirmed) / false (cancelled).
 *   • GateBanner     — a NON-BLOCKING banner announcing a gate decision: `warn`
 *     (soft — agent was allowed but flagged) or `block` (hard — action denied,
 *     D-018/D-024). Dismissible; multiple may stack.
 */

/** A single line of a unified diff (for the config-write confirm, D-010). */
export interface DiffLine {
	kind: 'add' | 'remove' | 'context';
	text: string;
}

export interface ConfirmRequest {
	/** Imperative title ("Save config", "Stop agent"). */
	title: string;
	/** Plain-language summary of what will happen. */
	message?: string;
	/** Label for the confirm button (verb+object, §11). Default "Confirm". */
	confirmLabel?: string;
	/** Label for the cancel button. Default "Cancel". */
	cancelLabel?: string;
	/** Marks a destructive action — the confirm button uses the danger style (§8). */
	danger?: boolean;
	/** Optional unified diff to show before confirming (D-010 mandatory for config). */
	diff?: DiffLine[];
}

/** The active confirm dialog (request + the resolver to settle the promise). */
interface ActiveConfirm {
	request: ConfirmRequest;
	resolve: (ok: boolean) => void;
}

export type GateSeverity = 'warn' | 'block';

export interface GateBannerItem {
	id: number;
	severity: GateSeverity;
	/** What gate fired (e.g. "path-confinement", "dangerous-bash") — D-018. */
	gate: string;
	/** Human explanation of what was blocked/flagged and why (§254). */
	message: string;
	/** Optional detail (the offending command/path), shown mono. */
	detail?: string;
}

export class ConfirmCore {
	/** The active blocking confirm, or null when none is open. */
	active: ActiveConfirm | null = null;
	/** The stack of non-blocking gate banners. */
	gates: GateBannerItem[] = [];

	#seq = 0;
	#onChange: () => void;

	constructor(onChange: () => void = () => {}) {
		this.#onChange = onChange;
	}

	/**
	 * Open a blocking confirm. Resolves true if confirmed, false if cancelled.
	 * If a confirm is already open, the new request is rejected as `false` (we
	 * never silently stack blocking modals — the caller should await the first).
	 */
	confirm(request: ConfirmRequest): Promise<boolean> {
		if (this.active) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			this.active = { request, resolve };
			this.#onChange();
		});
	}

	/** Settle the active confirm. Idempotent (a double-call is ignored). */
	resolve(ok: boolean): void {
		const a = this.active;
		if (!a) return;
		this.active = null;
		this.#onChange();
		a.resolve(ok);
	}

	/** Convenience: the user accepted / rejected the active confirm. */
	accept(): void {
		this.resolve(true);
	}
	cancel(): void {
		this.resolve(false);
	}

	/** Raise a non-blocking gate banner; returns its id. */
	raiseGate(item: Omit<GateBannerItem, 'id'>): number {
		const id = ++this.#seq;
		this.gates = [...this.gates, { ...item, id }];
		this.#onChange();
		return id;
	}

	/** Dismiss a gate banner. Idempotent. */
	dismissGate(id: number): void {
		const had = this.gates.some((g) => g.id === id);
		this.gates = this.gates.filter((g) => g.id !== id);
		if (had) this.#onChange();
	}

	/** Clear all gate banners. */
	clearGates(): void {
		if (this.gates.length === 0) return;
		this.gates = [];
		this.#onChange();
	}
}
