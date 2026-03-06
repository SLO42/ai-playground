import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import StatusBar from './StatusBar.svelte';

describe('StatusBar', () => {
	it('renders default services', () => {
		render(StatusBar, { props: {} });
		expect(screen.getByText(/Gateway/)).toBeInTheDocument();
		expect(screen.getByText(/Ollama/)).toBeInTheDocument();
		expect(screen.getByText(/Memory DB/)).toBeInTheDocument();
		expect(screen.getByText(/Swarm/)).toBeInTheDocument();
	});

	it('renders default service status texts', () => {
		render(StatusBar, { props: {} });
		expect(screen.getByText('Online')).toBeInTheDocument();
		expect(screen.getByText('Running')).toBeInTheDocument();
		expect(screen.getByText('Connected')).toBeInTheDocument();
		expect(screen.getByText('Active')).toBeInTheDocument();
	});

	it('renders custom services', () => {
		const services = [
			{ label: 'API', status: 'online' as const, text: 'Healthy' },
			{ label: 'DB', status: 'offline' as const, text: 'Down' }
		];
		render(StatusBar, { props: { services } });
		expect(screen.getByText(/API/)).toBeInTheDocument();
		expect(screen.getByText('Healthy')).toBeInTheDocument();
		expect(screen.getByText(/DB/)).toBeInTheDocument();
		expect(screen.getByText('Down')).toBeInTheDocument();
	});

	it('renders lastSync text', () => {
		render(StatusBar, { props: { lastSync: '5 min ago' } });
		expect(screen.getByText(/5 min ago/)).toBeInTheDocument();
	});

	it('renders default lastSync as "just now"', () => {
		render(StatusBar, { props: {} });
		expect(screen.getByText(/just now/)).toBeInTheDocument();
	});

	it('applies green dot for online status', () => {
		const services = [{ label: 'Test', status: 'online' as const, text: 'OK' }];
		const { container } = render(StatusBar, { props: { services } });
		const dot = container.querySelector('.w-2.h-2.rounded-full');
		expect(dot).toHaveClass('bg-accent-green');
	});

	it('applies red dot for offline status', () => {
		const services = [{ label: 'Test', status: 'offline' as const, text: 'Down' }];
		const { container } = render(StatusBar, { props: { services } });
		const dot = container.querySelector('.w-2.h-2.rounded-full');
		expect(dot).toHaveClass('bg-accent-red');
	});

	it('applies yellow dot for warning status', () => {
		const services = [{ label: 'Test', status: 'warning' as const, text: 'Degraded' }];
		const { container } = render(StatusBar, { props: { services } });
		const dot = container.querySelector('.w-2.h-2.rounded-full');
		expect(dot).toHaveClass('bg-accent-yellow');
	});

	it('renders as a sticky header', () => {
		const { container } = render(StatusBar, { props: {} });
		const header = container.querySelector('header');
		expect(header).toHaveClass('sticky', 'top-0');
	});

	it('has correct height class', () => {
		const { container } = render(StatusBar, { props: {} });
		const header = container.querySelector('header');
		expect(header).toHaveClass('h-12');
	});
});
