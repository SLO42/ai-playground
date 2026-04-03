import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import StatusBar from './StatusBar.svelte';

describe('StatusBar', () => {
	it('renders default services', () => {
		render(StatusBar, { props: {} });
		expect(screen.getByText('Ollama')).toBeInTheDocument();
		expect(screen.getByText('Gateway')).toBeInTheDocument();
		expect(screen.getByText('Daemon')).toBeInTheDocument();
	});

	it('renders custom services', () => {
		const services = [
			{ label: 'API', status: 'online' as const },
			{ label: 'DB', status: 'offline' as const }
		];
		render(StatusBar, { props: { services } });
		expect(screen.getByText('API')).toBeInTheDocument();
		expect(screen.getByText('DB')).toBeInTheDocument();
	});

	it('renders lastSync text', () => {
		// Pass an ISO date — component formats it via toLocaleTimeString
		const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
		render(StatusBar, { props: { lastSync: fiveMinAgo } });
		// Should display a formatted time, not "just now"
		expect(screen.getByText(/Synced \d{1,2}:\d{2}/)).toBeInTheDocument();
	});

	it('renders default lastSync as "just now"', () => {
		render(StatusBar, { props: {} });
		expect(screen.getByText(/just now/)).toBeInTheDocument();
	});

	it('applies green dot for online status', () => {
		const services = [{ label: 'Test', status: 'online' as const }];
		const { container } = render(StatusBar, { props: { services } });
		const dot = container.querySelector('.rounded-full.bg-accent-green');
		expect(dot).toBeInTheDocument();
		expect(dot).toHaveClass('animate-pulse');
	});

	it('applies red dot for offline status', () => {
		const services = [{ label: 'Test', status: 'offline' as const }];
		const { container } = render(StatusBar, { props: { services } });
		const dot = container.querySelector('.rounded-full.bg-accent-red');
		expect(dot).toBeInTheDocument();
	});

	it('applies yellow dot for warning status', () => {
		const services = [{ label: 'Test', status: 'warning' as const }];
		const { container } = render(StatusBar, { props: { services } });
		const dot = container.querySelector('.rounded-full.bg-accent-yellow');
		expect(dot).toBeInTheDocument();
	});

	it('renders as a sticky header', () => {
		const { container } = render(StatusBar, { props: {} });
		const header = container.querySelector('header');
		expect(header).toHaveClass('sticky', 'top-0');
	});

	it('has correct height class', () => {
		const { container } = render(StatusBar, { props: {} });
		const header = container.querySelector('header');
		expect(header).toHaveClass('h-10');
	});
});
