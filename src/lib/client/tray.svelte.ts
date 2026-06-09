/**
 * RightTray open/close state (TASK 10.2; UI-SPEC §3 right tray). Svelte 5 RUNES only
 * ($state) — never stores (D-005). A module singleton so the Topbar bell can toggle it
 * and the layout-mounted RightTray can read it reactively without prop-drilling — the
 * same surface pattern as the toast/confirm primitives.
 *
 * State only — the tray's DATA (notifications + activity, unread count) comes from the
 * layout server load (real rows; F-008) and updates live over the one SSE stream.
 */
class TrayStore {
	/** Whether the slide-over tray is open. */
	open = $state(false);

	show(): void {
		this.open = true;
	}
	hide(): void {
		this.open = false;
	}
	toggle(): void {
		this.open = !this.open;
	}
}

export const tray = new TrayStore();
