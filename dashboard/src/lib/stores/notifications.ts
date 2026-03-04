import { writable, derived } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
	id: string;
	type: ToastType;
	title: string;
	message: string;
	createdAt: number;
	duration: number;
}

export interface Alert {
	id: string;
	type: ToastType;
	title: string;
	message: string;
	createdAt: number;
	read: boolean;
}

interface NotificationsState {
	toasts: Toast[];
	alerts: Alert[];
}

const DEFAULT_DURATION = 5000;

function createNotificationsStore() {
	const store = writable<NotificationsState>({ toasts: [], alerts: [] });
	const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

	function generateId(): string {
		return `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	function push(type: ToastType, title: string, message: string, duration = DEFAULT_DURATION) {
		const id = generateId();
		const toast: Toast = { id, type, title, message, createdAt: Date.now(), duration };

		store.update((s) => ({ ...s, toasts: [...s.toasts, toast] }));

		if (duration > 0) {
			const timer = setTimeout(() => dismiss(id), duration);
			dismissTimers.set(id, timer);
		}

		return id;
	}

	function dismiss(id: string) {
		const timer = dismissTimers.get(id);
		if (timer) {
			clearTimeout(timer);
			dismissTimers.delete(id);
		}
		store.update((s) => ({
			...s,
			toasts: s.toasts.filter((t) => t.id !== id)
		}));
	}

	function clearAllToasts() {
		for (const timer of dismissTimers.values()) {
			clearTimeout(timer);
		}
		dismissTimers.clear();
		store.update((s) => ({ ...s, toasts: [] }));
	}

	function addAlert(type: ToastType, title: string, message: string) {
		const alert: Alert = {
			id: generateId(),
			type,
			title,
			message,
			createdAt: Date.now(),
			read: false
		};
		store.update((s) => ({ ...s, alerts: [alert, ...s.alerts] }));
		return alert.id;
	}

	function markAlertRead(id: string) {
		store.update((s) => ({
			...s,
			alerts: s.alerts.map((a) => (a.id === id ? { ...a, read: true } : a))
		}));
	}

	function dismissAlert(id: string) {
		store.update((s) => ({
			...s,
			alerts: s.alerts.filter((a) => a.id !== id)
		}));
	}

	function clearAllAlerts() {
		store.update((s) => ({ ...s, alerts: [] }));
	}

	const toasts = derived(store, ($s) => $s.toasts);
	const alerts = derived(store, ($s) => $s.alerts);
	const unreadCount = derived(store, ($s) => $s.alerts.filter((a) => !a.read).length);

	return {
		subscribe: store.subscribe,
		toasts,
		alerts,
		unreadCount,
		push,
		dismiss,
		clearAllToasts,
		addAlert,
		markAlertRead,
		dismissAlert,
		clearAllAlerts
	};
}

export const notifications = createNotificationsStore();
