import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

// Polyfill requestAnimationFrame for JSDOM — fire callbacks synchronously
// so RAF-batched Svelte state (e.g. BubbleGraph's batchedNodes) resolves in tests
if (typeof globalThis.requestAnimationFrame === 'undefined') {
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(performance.now()); return 0; };
	globalThis.cancelAnimationFrame = () => {};
}

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
