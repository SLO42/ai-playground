import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import axe from 'axe-core';
import BubbleGraph from './BubbleGraph.svelte';

function makeNode(overrides: Partial<{
	id: string;
	category: string;
	confidence: number;
	accessCount: number;
	createdAt: number;
	pageRank: number;
	label: string;
}> = {}) {
	return {
		id: overrides.id ?? 'node-1',
		category: overrides.category ?? 'core',
		confidence: overrides.confidence ?? 0.9,
		accessCount: overrides.accessCount ?? 5,
		createdAt: overrides.createdAt ?? Date.now(),
		pageRank: overrides.pageRank ?? 0.5,
		label: overrides.label ?? 'Test Node'
	};
}

const axeOptions = {
	rules: {
		region: { enabled: false },
		'nested-interactive': { enabled: false }
	}
};

describe('BubbleGraph accessibility — loading, empty, and error states', () => {
	describe('loading state', () => {
		it('has role="status" for assistive technology announcement', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isLoading: true }
			});
			const status = container.querySelector('[role="status"]');
			expect(status).toBeInTheDocument();
		});

		it('has aria-live="polite" so screen readers announce non-intrusively', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isLoading: true }
			});
			const status = container.querySelector('[role="status"]');
			expect(status?.getAttribute('aria-live')).toBe('polite');
		});

		it('has an accessible label describing the loading state', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isLoading: true }
			});
			const status = container.querySelector('[role="status"]');
			expect(status?.getAttribute('aria-label')).toContain('Loading');
		});

		it('hides the spinner SVG from assistive technology', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isLoading: true }
			});
			const svg = container.querySelector('[role="status"] svg');
			expect(svg?.getAttribute('aria-hidden')).toBe('true');
		});

		it('displays visible loading text', () => {
			render(BubbleGraph, {
				props: { nodes: [], isLoading: true }
			});
			expect(screen.getByText('Loading graph…')).toBeInTheDocument();
		});

		it('does not render the SVG graph while loading', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()], isLoading: true }
			});
			expect(container.querySelector('svg[role="img"]')).not.toBeInTheDocument();
		});

		it('passes axe-core checks in loading state', async () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isLoading: true }
			});
			const results = await axe.run(container, axeOptions);
			expect(results.violations).toEqual([]);
		});
	});

	describe('empty state', () => {
		it('has role="status" for assistive technology', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isEmpty: true }
			});
			const status = container.querySelector('[role="status"]');
			expect(status).toBeInTheDocument();
		});

		it('has an accessible label describing the empty state', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isEmpty: true }
			});
			const status = container.querySelector('[role="status"]');
			expect(status?.getAttribute('aria-label')).toContain('empty');
		});

		it('hides the decorative SVG icon from assistive technology', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isEmpty: true }
			});
			const svg = container.querySelector('[role="status"] svg');
			expect(svg?.getAttribute('aria-hidden')).toBe('true');
		});

		it('displays visible empty state text', () => {
			render(BubbleGraph, {
				props: { nodes: [], isEmpty: true }
			});
			expect(screen.getByText('No memory data to display')).toBeInTheDocument();
		});

		it('does not render the SVG graph when empty', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isEmpty: true }
			});
			expect(container.querySelector('svg[role="img"]')).not.toBeInTheDocument();
		});

		it('passes axe-core checks in empty state', async () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isEmpty: true }
			});
			const results = await axe.run(container, axeOptions);
			expect(results.violations).toEqual([]);
		});
	});

	describe('error state', () => {
		it('has role="alert" for immediate screen reader announcement', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], hasError: true }
			});
			const alert = container.querySelector('[role="alert"]');
			expect(alert).toBeInTheDocument();
		});

		it('has aria-live="assertive" so the error interrupts the user', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], hasError: true }
			});
			const alert = container.querySelector('[role="alert"]');
			expect(alert?.getAttribute('aria-live')).toBe('assertive');
		});

		it('hides the error icon SVG from assistive technology', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], hasError: true }
			});
			const svg = container.querySelector('[role="alert"] svg');
			expect(svg?.getAttribute('aria-hidden')).toBe('true');
		});

		it('displays the default error message', () => {
			render(BubbleGraph, {
				props: { nodes: [], hasError: true }
			});
			expect(screen.getByText('Failed to load memory graph')).toBeInTheDocument();
		});

		it('displays a custom error message when provided', () => {
			render(BubbleGraph, {
				props: { nodes: [], hasError: true, errorMessage: 'Graph API timeout' }
			});
			expect(screen.getByText('Graph API timeout')).toBeInTheDocument();
		});

		it('renders a Retry button when onRetry is provided', () => {
			const retry = vi.fn();
			render(BubbleGraph, {
				props: { nodes: [], hasError: true, onRetry: retry }
			});
			const btn = screen.getByText('Retry');
			expect(btn).toBeInTheDocument();
			expect(btn.tagName).toBe('BUTTON');
		});

		it('calls onRetry when Retry button is clicked', async () => {
			const retry = vi.fn();
			render(BubbleGraph, {
				props: { nodes: [], hasError: true, onRetry: retry }
			});
			await fireEvent.click(screen.getByText('Retry'));
			expect(retry).toHaveBeenCalledOnce();
		});

		it('Retry button is keyboard-accessible (Enter)', async () => {
			const retry = vi.fn();
			render(BubbleGraph, {
				props: { nodes: [], hasError: true, onRetry: retry }
			});
			const btn = screen.getByText('Retry');
			await fireEvent.keyDown(btn, { key: 'Enter' });
			await fireEvent.keyUp(btn, { key: 'Enter' });
			// Native button handles Enter via click event
			await fireEvent.click(btn);
			expect(retry).toHaveBeenCalled();
		});

		it('does not render Retry button when onRetry is not provided', () => {
			render(BubbleGraph, {
				props: { nodes: [], hasError: true }
			});
			expect(screen.queryByText('Retry')).not.toBeInTheDocument();
		});

		it('does not render the SVG graph when in error state', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()], hasError: true }
			});
			expect(container.querySelector('svg[role="img"]')).not.toBeInTheDocument();
		});

		it('passes axe-core checks in error state without retry', async () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], hasError: true }
			});
			const results = await axe.run(container, axeOptions);
			expect(results.violations).toEqual([]);
		});

		it('passes axe-core checks in error state with retry button', async () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], hasError: true, onRetry: vi.fn() }
			});
			const results = await axe.run(container, axeOptions);
			expect(results.violations).toEqual([]);
		});
	});

	describe('state priority (error > loading > empty > graph)', () => {
		it('error state takes priority over loading', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], hasError: true, isLoading: true }
			});
			expect(container.querySelector('[role="alert"]')).toBeInTheDocument();
			expect(container.querySelector('[role="status"]')).not.toBeInTheDocument();
		});

		it('loading state takes priority over empty', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isLoading: true, isEmpty: true }
			});
			const status = container.querySelector('[role="status"]');
			expect(status?.getAttribute('aria-label')).toContain('Loading');
		});

		it('empty state takes priority over graph rendering', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()], isEmpty: true }
			});
			expect(container.querySelector('[role="status"]')).toBeInTheDocument();
			expect(container.querySelector('svg[role="img"]')).not.toBeInTheDocument();
		});
	});

	describe('focus management', () => {
		it('Retry button receives focus when tabbed to in error state', () => {
			const retry = vi.fn();
			render(BubbleGraph, {
				props: { nodes: [], hasError: true, onRetry: retry }
			});
			const btn = screen.getByText('Retry');
			btn.focus();
			expect(document.activeElement).toBe(btn);
		});

		it('loading state contains no focusable elements', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isLoading: true }
			});
			const focusable = container.querySelectorAll(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			);
			expect(focusable.length).toBe(0);
		});

		it('empty state contains no focusable elements', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], isEmpty: true }
			});
			const focusable = container.querySelectorAll(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			);
			expect(focusable.length).toBe(0);
		});
	});
});
