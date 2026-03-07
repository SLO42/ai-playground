import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import PageFallback from './PageFallback.svelte';

describe('PageFallback', () => {
	it('renders the title text', () => {
		render(PageFallback, { props: { title: 'No data yet' } });
		expect(screen.getByTestId('fallback-title')).toHaveTextContent('No data yet');
	});

	it('renders the message when provided', () => {
		render(PageFallback, { props: { title: 'Error', message: 'Something went wrong' } });
		expect(screen.getByTestId('fallback-message')).toHaveTextContent('Something went wrong');
	});

	it('does not render message element when message is empty', () => {
		render(PageFallback, { props: { title: 'No data yet' } });
		expect(screen.queryByTestId('fallback-message')).not.toBeInTheDocument();
	});

	it('defaults to empty variant', () => {
		render(PageFallback, { props: { title: 'Empty' } });
		const container = screen.getByTestId('page-fallback');
		expect(container).toHaveAttribute('data-variant', 'empty');
	});

	it('sets role to status for loading variant', () => {
		render(PageFallback, { props: { title: 'Loading...', variant: 'loading' } });
		const container = screen.getByTestId('page-fallback');
		expect(container).toHaveAttribute('role', 'status');
	});

	it('sets role to alert for error variant', () => {
		render(PageFallback, { props: { title: 'Error', variant: 'error' } });
		const container = screen.getByTestId('page-fallback');
		expect(container).toHaveAttribute('role', 'alert');
	});

	it('sets role to alert for empty variant', () => {
		render(PageFallback, { props: { title: 'Empty' } });
		const container = screen.getByTestId('page-fallback');
		expect(container).toHaveAttribute('role', 'alert');
	});

	it('applies centered flex layout styles', () => {
		render(PageFallback, { props: { title: 'Test' } });
		const container = screen.getByTestId('page-fallback');
		expect(container).toHaveClass('flex', 'flex-col', 'items-center', 'justify-center');
	});

	it('renders data-variant attribute matching the variant prop', () => {
		render(PageFallback, { props: { title: 'Oops', variant: 'error' } });
		expect(screen.getByTestId('page-fallback')).toHaveAttribute('data-variant', 'error');
	});

	it('has aria-live polite for accessibility', () => {
		render(PageFallback, { props: { title: 'Loading', variant: 'loading' } });
		expect(screen.getByTestId('page-fallback')).toHaveAttribute('aria-live', 'polite');
	});
});
