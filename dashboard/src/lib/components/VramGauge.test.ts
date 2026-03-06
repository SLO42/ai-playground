import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import VramGauge from './VramGauge.svelte';

describe('VramGauge', () => {
	it('renders VRAM Usage label', () => {
		render(VramGauge, { props: { usedGb: 12, totalGb: 24 } });
		expect(screen.getByText('VRAM Usage')).toBeInTheDocument();
	});

	it('renders used / total GB text', () => {
		render(VramGauge, { props: { usedGb: 12.5, totalGb: 24 } });
		expect(screen.getByText('12.5 / 24 GB')).toBeInTheDocument();
	});

	it('formats used GB to one decimal place', () => {
		render(VramGauge, { props: { usedGb: 8.123, totalGb: 24 } });
		expect(screen.getByText('8.1 / 24 GB')).toBeInTheDocument();
	});

	it('renders model name when provided', () => {
		render(VramGauge, { props: { usedGb: 10, totalGb: 24, modelName: 'GPT-OSS 20B' } });
		expect(screen.getByText('GPT-OSS 20B')).toBeInTheDocument();
	});

	it('does not render model name when not provided', () => {
		const { container } = render(VramGauge, { props: { usedGb: 10, totalGb: 24 } });
		const modelPs = container.querySelectorAll('p.font-mono');
		expect(modelPs.length).toBe(0);
	});

	it('applies green bar color when usage is <= 70%', () => {
		const { container } = render(VramGauge, { props: { usedGb: 12, totalGb: 24 } }); // 50%
		const bar = container.querySelector('.h-full.rounded-full');
		expect(bar).toHaveClass('bg-accent-green');
	});

	it('applies yellow bar color when usage is 71-90%', () => {
		const { container } = render(VramGauge, { props: { usedGb: 20, totalGb: 24 } }); // 83%
		const bar = container.querySelector('.h-full.rounded-full');
		expect(bar).toHaveClass('bg-accent-yellow');
	});

	it('applies red bar color when usage is > 90%', () => {
		const { container } = render(VramGauge, { props: { usedGb: 23, totalGb: 24 } }); // 96%
		const bar = container.querySelector('.h-full.rounded-full');
		expect(bar).toHaveClass('bg-accent-red');
	});

	it('handles 0 total GB without error', () => {
		const { container } = render(VramGauge, { props: { usedGb: 0, totalGb: 0 } });
		expect(container.querySelector('div')).toBeInTheDocument();
	});

	it('bar width reflects usage percentage', () => {
		const { container } = render(VramGauge, { props: { usedGb: 6, totalGb: 24 } }); // 25%
		const bar = container.querySelector('.h-full.rounded-full');
		expect(bar?.getAttribute('style')).toContain('width: 25%');
	});

	it('card has border and rounded corners', () => {
		const { container } = render(VramGauge, { props: { usedGb: 0, totalGb: 24 } });
		const card = container.firstElementChild;
		expect(card).toHaveClass('border', 'rounded-lg');
	});
});
