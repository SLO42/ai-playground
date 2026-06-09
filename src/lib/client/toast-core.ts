/**
 * Toast state-machine core — pure (no Svelte runes), so it is unit-testable in
 * the node vitest env. The reactive wrapper (`toast.svelte.ts`) holds the `$state`
 * and re-publishes this core's plain `items` array on every change via `onChange`.
 */

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastInput {
	kind: ToastKind;
	/** Short title — past-tense + specific for success ("Config saved"). */
	title: string;
	/** Optional detail line — for errors, the real message (§8). */
	detail?: string;
	/**
	 * Auto-dismiss after this many ms. 0 / null ⇒ sticky (manual close only).
	 * Defaults: info/success 4500ms, error 8000ms (errors linger longer, §11).
	 */
	duration?: number | null;
}

export interface Toast extends ToastInput {
	id: number;
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
	success: 4500,
	info: 4500,
	error: 8000
};

/** Cap the stack so a burst never floods the screen (UI-SPEC §7 ~10-15 cap). */
export const MAX_VISIBLE = 5;

export class ToastCore {
	/** The live stack, newest last. */
	items: Toast[] = [];

	#seq = 0;
	#timers = new Map<number, ReturnType<typeof setTimeout>>();
	#onChange: () => void;

	constructor(onChange: () => void = () => {}) {
		this.#onChange = onChange;
	}

	/** Push a toast; returns its id. Auto-dismisses unless duration is 0/null. */
	push(input: ToastInput): number {
		const id = ++this.#seq;
		const duration = input.duration === undefined ? DEFAULT_DURATION[input.kind] : input.duration;
		this.items = [...this.items, { ...input, id }];

		// Trim the oldest beyond the visible cap (and clear their timers).
		if (this.items.length > MAX_VISIBLE) {
			const overflow = this.items.slice(0, this.items.length - MAX_VISIBLE);
			for (const t of overflow) this.#clearTimer(t.id);
			this.items = this.items.slice(this.items.length - MAX_VISIBLE);
		}

		if (duration && duration > 0) {
			this.#timers.set(
				id,
				setTimeout(() => this.dismiss(id), duration)
			);
		}
		this.#onChange();
		return id;
	}

	/** Remove a toast (manual close or auto-dismiss). Idempotent. */
	dismiss(id: number): void {
		const had = this.items.some((t) => t.id === id);
		this.#clearTimer(id);
		this.items = this.items.filter((t) => t.id !== id);
		if (had) this.#onChange();
	}

	/** Clear everything (e.g. on route teardown / tests). */
	clear(): void {
		for (const h of this.#timers.values()) clearTimeout(h);
		this.#timers.clear();
		this.items = [];
		this.#onChange();
	}

	#clearTimer(id: number): void {
		const h = this.#timers.get(id);
		if (h) {
			clearTimeout(h);
			this.#timers.delete(id);
		}
	}
}
