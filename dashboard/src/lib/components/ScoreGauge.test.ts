import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import ScoreGauge from './ScoreGauge.svelte';

const defaultBreakdown = [
	{ label: 'Coverage', score: 85, weight: 0.4, detail: 'Unit test coverage' },
	{ label: 'Quality', score: 70, weight: 0.3, detail: 'Code quality score' },
	{ label: 'Security', score: 90, weight: 0.3, detail: 'Security audit' }
];

function renderGauge(overrides: Partial<{
	label: string;
	score: number;
	grade: string;
	breakdown: typeof defaultBreakdown;
	accent: string;
}> = {}) {
	return render(ScoreGauge, {
		props: {
			label: overrides.label ?? 'Health Score',
			score: overrides.score ?? 82,
			grade: overrides.grade ?? 'B',
			breakdown: overrides.breakdown ?? defaultBreakdown,
			...('accent' in overrides ? { accent: overrides.accent } : {})
		}
	});
}

describe('ScoreGauge', () => {
	it('renders the label', () => {
		renderGauge({ label: 'Project Health' });
		expect(screen.getByText('Project Health')).toBeInTheDocument();
	});

	it('renders the numeric score', () => {
		renderGauge({ score: 95 });
		expect(screen.getByText('95')).toBeInTheDocument();
	});

	it('renders / 100 denominator', () => {
		renderGauge();
		expect(screen.getByText('/ 100')).toBeInTheDocument();
	});

	it('renders the grade letter', () => {
		renderGauge({ grade: 'A' });
		expect(screen.getByText('A')).toBeInTheDocument();
	});

	it('shows Excellent descriptor for score >= 90', () => {
		renderGauge({ score: 92 });
		expect(screen.getByText('Excellent')).toBeInTheDocument();
	});

	it('shows Good descriptor for score 75-89', () => {
		renderGauge({ score: 82 });
		expect(screen.getByText('Good')).toBeInTheDocument();
	});

	it('shows Fair descriptor for score 60-74', () => {
		renderGauge({ score: 65 });
		expect(screen.getByText('Fair')).toBeInTheDocument();
	});

	it('shows Needs Work descriptor for score 40-59', () => {
		renderGauge({ score: 50 });
		expect(screen.getByText('Needs Work')).toBeInTheDocument();
	});

	it('shows Critical descriptor for score < 40', () => {
		renderGauge({ score: 20 });
		expect(screen.getByText('Critical')).toBeInTheDocument();
	});

	it('renders SVG gauge ring', () => {
		const { container } = renderGauge();
		const svg = container.querySelector('svg');
		expect(svg).toBeInTheDocument();
		const circles = svg?.querySelectorAll('circle');
		expect(circles?.length).toBe(2); // background + score arc
	});

	it('renders breakdown labels', () => {
		renderGauge();
		expect(screen.getAllByText(/Coverage/).length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText(/Quality/).length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText(/Security/).length).toBeGreaterThanOrEqual(1);
	});

	it('renders breakdown scores', () => {
		renderGauge();
		expect(screen.getByText('85')).toBeInTheDocument();
		expect(screen.getByText('70')).toBeInTheDocument();
		expect(screen.getByText('90')).toBeInTheDocument();
	});

	it('renders breakdown detail text', () => {
		renderGauge();
		expect(screen.getByText('Unit test coverage')).toBeInTheDocument();
		expect(screen.getByText('Code quality score')).toBeInTheDocument();
		expect(screen.getByText('Security audit')).toBeInTheDocument();
	});

	it('renders weight percentages', () => {
		renderGauge();
		expect(screen.getAllByText(/40%/).length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText(/30%/).length).toBeGreaterThanOrEqual(1);
	});

	it('applies green grade color for grade A', () => {
		const { container } = renderGauge({ grade: 'A', score: 95 });
		const gradeEl = Array.from(container.querySelectorAll('span')).find(
			(el) => el.textContent === 'A' && el.classList.contains('text-4xl')
		);
		expect(gradeEl).toHaveClass('text-accent-green');
	});

	it('applies cyan grade color for grade B', () => {
		const { container } = renderGauge({ grade: 'B', score: 82 });
		const gradeEl = Array.from(container.querySelectorAll('span')).find(
			(el) => el.textContent === 'B' && el.classList.contains('text-4xl')
		);
		expect(gradeEl).toHaveClass('text-accent-cyan');
	});

	it('applies yellow grade color for grade C', () => {
		const { container } = renderGauge({ grade: 'C', score: 65 });
		const gradeEl = Array.from(container.querySelectorAll('span')).find(
			(el) => el.textContent === 'C' && el.classList.contains('text-4xl')
		);
		expect(gradeEl).toHaveClass('text-accent-yellow');
	});

	it('applies red grade color for grade D', () => {
		const { container } = renderGauge({ grade: 'D', score: 45 });
		const gradeEl = Array.from(container.querySelectorAll('span')).find(
			(el) => el.textContent === 'D' && el.classList.contains('text-4xl')
		);
		expect(gradeEl).toHaveClass('text-accent-red');
	});

	it('applies green stroke for high score arc', () => {
		const { container } = renderGauge({ score: 85 });
		const circles = container.querySelectorAll('svg circle');
		const scoreCircle = circles[1];
		expect(scoreCircle).toHaveClass('stroke-accent-green');
	});

	it('applies yellow stroke for medium score arc', () => {
		const { container } = renderGauge({ score: 65 });
		const circles = container.querySelectorAll('svg circle');
		const scoreCircle = circles[1];
		expect(scoreCircle).toHaveClass('stroke-accent-yellow');
	});

	it('applies red stroke for low score arc', () => {
		const { container } = renderGauge({ score: 30 });
		const circles = container.querySelectorAll('svg circle');
		const scoreCircle = circles[1];
		expect(scoreCircle).toHaveClass('stroke-accent-red');
	});

	it('breakdown bars use green for high scores', () => {
		const breakdown = [{ label: 'X', score: 85, weight: 1, detail: 'test' }];
		const { container } = renderGauge({ breakdown });
		const bar = container.querySelector('.bg-accent-green.h-full');
		expect(bar).toBeInTheDocument();
	});

	it('breakdown bars use yellow for medium scores', () => {
		const breakdown = [{ label: 'X', score: 65, weight: 1, detail: 'test' }];
		const { container } = renderGauge({ breakdown });
		const bar = container.querySelector('.bg-accent-yellow.h-full');
		expect(bar).toBeInTheDocument();
	});

	it('breakdown bars use red for low scores', () => {
		const breakdown = [{ label: 'X', score: 40, weight: 1, detail: 'test' }];
		const { container } = renderGauge({ breakdown });
		const bar = container.querySelector('.bg-accent-red.h-full');
		expect(bar).toBeInTheDocument();
	});
});
