import { writable, derived } from 'svelte/store';

export interface GroceryProduct {
	id: string;
	name: string;
	brand?: string;
	price?: number;
	size?: string;
	imageUrl?: string;
	category?: string;
}

export interface CartItem {
	productId: string;
	name: string;
	quantity: number;
	price?: number;
}

export interface Coupon {
	id: string;
	title: string;
	description?: string;
	expiresAt?: string;
	clipped?: boolean;
	value?: string;
}

interface GroceryState {
	products: GroceryProduct[];
	cart: CartItem[];
	coupons: Coupon[];
	loadingProducts: boolean;
	loadingCart: boolean;
	loadingCoupons: boolean;
	error: string | null;
}

const API_BASE = '/api/apps/heb';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		...options,
		headers: { 'Content-Type': 'application/json', ...options?.headers },
		signal: options?.signal ?? AbortSignal.timeout(10000)
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
	}
	return res.json();
}

function createGroceryStore() {
	const store = writable<GroceryState>({
		products: [],
		cart: [],
		coupons: [],
		loadingProducts: false,
		loadingCart: false,
		loadingCoupons: false,
		error: null
	});

	async function searchProducts(query: string) {
		store.update((s) => ({ ...s, loadingProducts: true, error: null }));
		try {
			const result = await apiFetch<{ products: GroceryProduct[] }>(`/products/search?q=${encodeURIComponent(query)}`);
			store.update((s) => ({ ...s, products: result.products ?? [], loadingProducts: false }));
		} catch (e) {
			store.update((s) => ({
				...s,
				loadingProducts: false,
				error: e instanceof Error ? e.message : 'Search failed'
			}));
		}
	}

	async function getProduct(id: string): Promise<GroceryProduct | null> {
		try {
			return await apiFetch<GroceryProduct>(`/products/${encodeURIComponent(id)}`);
		} catch {
			return null;
		}
	}

	async function getCart() {
		store.update((s) => ({ ...s, loadingCart: true, error: null }));
		try {
			const result = await apiFetch<{ items: CartItem[] }>('/cart');
			store.update((s) => ({ ...s, cart: result.items ?? [], loadingCart: false }));
		} catch (e) {
			store.update((s) => ({
				...s,
				loadingCart: false,
				error: e instanceof Error ? e.message : 'Cart fetch failed'
			}));
		}
	}

	async function addToCart(productId: string, qty: number = 1) {
		store.update((s) => ({ ...s, loadingCart: true, error: null }));
		try {
			await apiFetch('/cart/add', {
				method: 'POST',
				body: JSON.stringify({ productId, quantity: qty })
			});
			await getCart();
		} catch (e) {
			store.update((s) => ({
				...s,
				loadingCart: false,
				error: e instanceof Error ? e.message : 'Add to cart failed'
			}));
		}
	}

	async function getCoupons() {
		store.update((s) => ({ ...s, loadingCoupons: true, error: null }));
		try {
			const result = await apiFetch<{ coupons: Coupon[] }>('/coupons');
			store.update((s) => ({ ...s, coupons: result.coupons ?? [], loadingCoupons: false }));
		} catch (e) {
			store.update((s) => ({
				...s,
				loadingCoupons: false,
				error: e instanceof Error ? e.message : 'Coupons fetch failed'
			}));
		}
	}

	async function clipCoupon(id: string) {
		try {
			await apiFetch(`/coupons/${encodeURIComponent(id)}/clip`, { method: 'POST' });
			await getCoupons();
		} catch (e) {
			store.update((s) => ({
				...s,
				error: e instanceof Error ? e.message : 'Clip coupon failed'
			}));
		}
	}

	const products = derived(store, ($s) => $s.products);
	const cart = derived(store, ($s) => $s.cart);
	const coupons = derived(store, ($s) => $s.coupons);
	const loading = derived(store, ($s) => $s.loadingProducts || $s.loadingCart || $s.loadingCoupons);

	return {
		subscribe: store.subscribe,
		products,
		cart,
		coupons,
		loading,
		searchProducts,
		getProduct,
		getCart,
		addToCart,
		getCoupons,
		clipCoupon
	};
}

export const grocery = createGroceryStore();
