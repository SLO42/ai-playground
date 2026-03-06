import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import MetricCard from './MetricCard.svelte';

describe('MetricCard', () => {
	it('renders label and value', () => {
		render(MetricCard, { props: { label: 'Total Users', value: 42 } });
		expect(screen.getByText('Total Users')).toBeInTheDocument();
		expect(screen.getByText('42')).toBeInTheDocument();
	});

	it('renders string values', () => {
		render(MetricCard, { props: { label: 'Status', value: 'Healthy' } });
		expect(screen.getByText('Healthy')).toBeInTheDocument();
	});

	it('renders subtitle when provided', () => {
		render(MetricCard, { props: { label: 'CPU', value: '72%', subtitle: 'Last 5 min' } });
		expect(screen.getByText('Last 5 min')).toBeInTheDocument();
	});

	it('does not render subtitle when not provided', () => {
		const { container } = render(MetricCard, { props: { label: 'CPU', value: '72%' } });
		const paragraphs = container.querySelectorAll('p');
		expect(paragraphs.length).toBe(2); // label + value, no subtitle
	});

	it('applies blue accent by default', () => {
		render(MetricCard, { props: { label: 'Test', value: 100 } });
		const valueEl = screen.getByText('100');
		expect(valueEl).toHaveClass('text-accent-blue');
	});

	it('applies green accent when specified', () => {
		render(MetricCard, { props: { label: 'Test', value: 100, accent: 'green' } });
		const valueEl = screen.getByText('100');
		expect(valueEl).toHaveClass('text-accent-green');
	});

	it('applies red accent when specified', () => {
		render(MetricCard, { props: { label: 'Errors', value: 3, accent: 'red' } });
		const valueEl = screen.getByText('3');
		expect(valueEl).toHaveClass('text-accent-red');
	});

	it('applies all supported accent colors', () => {
		const accents = ['blue', 'green', 'yellow', 'red', 'purple', 'cyan'] as const;
		for (const accent of accents) {
			const { container } = render(MetricCard, {
				props: { label: 'X', value: 1, accent }
			});
			const valueEl = container.querySelector('p.font-bold');
			expect(valueEl).toHaveClass(`text-accent-${accent}`);
			container.remove();
		}
	});

	it('label has correct styling', () => {
		render(MetricCard, { props: { label: 'Metric', value: 0 } });
		const label = screen.getByText('Metric');
		expect(label).toHaveClass('text-xs', 'uppercase', 'tracking-wider');
	});

	it('value has monospace font', () => {
		render(MetricCard, { props: { label: 'M', value: 99 } });
		const valueEl = screen.getByText('99');
		expect(valueEl).toHaveClass('font-mono', 'font-bold');
	});

	it('card has border and rounded corners', () => {
		const { container } = render(MetricCard, { props: { label: 'M', value: 0 } });
		const card = container.querySelector('div');
		expect(card).toHaveClass('border', 'rounded-lg');
	});
});
