import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import TimelineChart from './TimelineChart.svelte';

function makeItem(overrides: Partial<{ name: string; schedule: string; priority: number }> = {}) {
	return {
		name: overrides.name ?? 'Deploy service',
		schedule: overrides.schedule ?? '2026-03-05 10:00',
		priority: overrides.priority ?? 3
	};
}

describe('TimelineChart', () => {
	it('renders all items', () => {
		const items = [
			makeItem({ name: 'Task A' }),
			makeItem({ name: 'Task B' }),
			makeItem({ name: 'Task C' })
		];
		render(TimelineChart, { props: { items } });
		expect(screen.getByText('Task A')).toBeInTheDocument();
		expect(screen.getByText('Task B')).toBeInTheDocument();
		expect(screen.getByText('Task C')).toBeInTheDocument();
	});

	it('displays schedule text', () => {
		render(TimelineChart, { props: { items: [makeItem({ schedule: 'daily at 9am' })] } });
		expect(screen.getByText('daily at 9am')).toBeInTheDocument();
	});

	it('displays priority label', () => {
		render(TimelineChart, { props: { items: [makeItem({ priority: 2 })] } });
		expect(screen.getByText('P2')).toBeInTheDocument();
	});

	it('sorts items by priority (ascending)', () => {
		const items = [
			makeItem({ name: 'Low', priority: 5 }),
			makeItem({ name: 'High', priority: 1 }),
			makeItem({ name: 'Mid', priority: 3 })
		];
		const { container } = render(TimelineChart, { props: { items } });
		const names = Array.from(container.querySelectorAll('p.text-sm')).map((el) => el.textContent);
		expect(names).toEqual(['High', 'Mid', 'Low']);
	});

	it('applies red color bar for priority 1', () => {
		const { container } = render(TimelineChart, { props: { items: [makeItem({ priority: 1 })] } });
		const bar = container.querySelector('div[style]');
		expect(bar?.getAttribute('style')).toContain('239, 68, 68');
	});

	it('applies yellow color bar for priority 2', () => {
		const { container } = render(TimelineChart, { props: { items: [makeItem({ priority: 2 })] } });
		const bar = container.querySelector('div[style]');
		expect(bar?.getAttribute('style')).toContain('234, 179, 8');
	});

	it('applies blue color bar for priority 3', () => {
		const { container } = render(TimelineChart, { props: { items: [makeItem({ priority: 3 })] } });
		const bar = container.querySelector('div[style]');
		expect(bar?.getAttribute('style')).toContain('59, 130, 246');
	});

	it('applies green color bar for priority 4', () => {
		const { container } = render(TimelineChart, { props: { items: [makeItem({ priority: 4 })] } });
		const bar = container.querySelector('div[style]');
		expect(bar?.getAttribute('style')).toContain('34, 197, 94');
	});

	it('applies gray fallback for priority 5', () => {
		const { container } = render(TimelineChart, { props: { items: [makeItem({ priority: 5 })] } });
		const bar = container.querySelector('div[style]');
		expect(bar?.getAttribute('style')).toContain('148, 163, 184');
	});

	it('applies gray fallback for unknown priority', () => {
		const { container } = render(TimelineChart, { props: { items: [makeItem({ priority: 99 })] } });
		const bar = container.querySelector('div[style]');
		expect(bar?.getAttribute('style')).toContain('148, 163, 184');
	});

	it('renders empty list without errors', () => {
		const { container } = render(TimelineChart, { props: { items: [] } });
		expect(container.querySelector('div')).toBeInTheDocument();
	});

	it('name text is truncated via CSS class', () => {
		render(TimelineChart, { props: { items: [makeItem()] } });
		const name = screen.getByText('Deploy service');
		expect(name).toHaveClass('truncate');
	});

	it('schedule has monospace font', () => {
		render(TimelineChart, { props: { items: [makeItem({ schedule: 'cron' })] } });
		const schedule = screen.getByText('cron');
		expect(schedule).toHaveClass('font-mono');
	});
});
