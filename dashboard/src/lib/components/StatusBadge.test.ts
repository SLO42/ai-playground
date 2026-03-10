import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import StatusBadge from './StatusBadge.svelte';

describe('StatusBadge', () => {
	it('renders the status dot', () => {
		const { container } = render(StatusBadge, { props: { status: 'online' } });
		const dot = container.querySelector('span span');
		expect(dot).toBeInTheDocument();
		expect(dot).toHaveClass('rounded-full');
	});

	it('applies green color for online status', () => {
		const { container } = render(StatusBadge, { props: { status: 'online' } });
		const dot = container.querySelector('span span');
		expect(dot).toHaveClass('bg-accent-green');
	});

	it('applies green color for clean status', () => {
		const { container } = render(StatusBadge, { props: { status: 'clean' } });
		const dot = container.querySelector('span span');
		expect(dot).toHaveClass('bg-accent-green');
	});

	it('applies red color for offline status', () => {
		const { container } = render(StatusBadge, { props: { status: 'offline' } });
		const dot = container.querySelector('span span');
		expect(dot).toHaveClass('bg-accent-red');
	});

	it('applies red color for error status', () => {
		const { container } = render(StatusBadge, { props: { status: 'error' } });
		const dot = container.querySelector('span span');
		expect(dot).toHaveClass('bg-accent-red');
	});

	it('applies yellow color for warning status', () => {
		const { container } = render(StatusBadge, { props: { status: 'warning' } });
		const dot = container.querySelector('span span');
		expect(dot).toHaveClass('bg-accent-yellow');
	});

	it('applies yellow color for pending status', () => {
		const { container } = render(StatusBadge, { props: { status: 'pending' } });
		const dot = container.querySelector('span span');
		expect(dot).toHaveClass('bg-accent-yellow');
	});

	it('renders label text when provided', () => {
		render(StatusBadge, { props: { status: 'online', label: 'Active' } });
		expect(screen.getByText('Active')).toBeInTheDocument();
	});

	it('does not render label text when not provided', () => {
		const { container } = render(StatusBadge, { props: { status: 'online' } });
		const spans = container.querySelectorAll('span > span');
		expect(spans.length).toBe(1); // only the dot
	});

	it('uses small size by default', () => {
		const { container } = render(StatusBadge, { props: { status: 'online' } });
		const wrapper = container.querySelector('span');
		expect(wrapper).toHaveClass('text-xs');
	});

	it('uses medium size when specified', () => {
		const { container } = render(StatusBadge, { props: { status: 'online', size: 'md' } });
		const wrapper = container.querySelector('span');
		expect(wrapper).toHaveClass('text-sm');
	});

	it('applies correct text color to label', () => {
		render(StatusBadge, { props: { status: 'online', label: 'Active' } });
		const label = screen.getByText('Active');
		expect(label).toHaveClass('text-green-400');
	});

	it('label has uppercase tracking', () => {
		render(StatusBadge, { props: { status: 'warning', label: 'Warn' } });
		const label = screen.getByText('Warn');
		expect(label).toHaveClass('uppercase', 'tracking-wider', 'font-medium');
	});
});
