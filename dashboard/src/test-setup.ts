import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

// Override requestAnimationFrame to fire synchronously in tests —
// BubbleGraph batches node/edge state through RAF, which never fires in JSDOM otherwise
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(performance.now()); return 0; };
globalThis.cancelAnimationFrame = () => {};

// Polyfill ResizeObserver for JSDOM (used by Svelte's bind:clientWidth in BubbleGraph etc.)
if (typeof globalThis.ResizeObserver === 'undefined') {
	globalThis.ResizeObserver = class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}

afterEach(() => {
	cleanup();
});
