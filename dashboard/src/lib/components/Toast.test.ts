import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import Toast from './Toast.svelte';

function makeToast(overrides: Partial<{
	id: string;
	variant: 'success' | 'error' | 'warning' | 'info';
	title: string;
	message: string;
	timestamp: string;
}> = {}) {
	return {
		id: overrides.id ?? 'toast-1',
		variant: overrides.variant ?? 'info',
		title: overrides.title ?? 'Test Toast',
		message: overrides.message,
		timestamp: overrides.timestamp
	};
}

describe('Toast', () => {
	it('renders nothing when toasts array is empty', () => {
		const { container } = render(Toast, { props: { toasts: [] } });
		expect(container.querySelector('.fixed')).not.toBeInTheDocument();
	});

	it('renders nothing with default empty toasts', () => {
		const { container } = render(Toast, { props: {} });
		expect(container.querySelector('.fixed')).not.toBeInTheDocument();
	});

	it('renders toast title', () => {
		render(Toast, { props: { toasts: [makeToast({ title: 'Deployed!' })] } });
		expect(screen.getByText('Deployed!')).toBeInTheDocument();
	});

	it('renders toast message when provided', () => {
		render(Toast, { props: { toasts: [makeToast({ message: 'Service is live' })] } });
		expect(screen.getByText('Service is live')).toBeInTheDocument();
	});

	it('does not render message when not provided', () => {
		const { container } = render(Toast, { props: { toasts: [makeToast()] } });
		const texts = container.querySelectorAll('p');
		// Only title, no message paragraph
		expect(texts.length).toBe(1);
	});

	it('renders timestamp when provided', () => {
		render(Toast, { props: { toasts: [makeToast({ timestamp: '2m ago' })] } });
		expect(screen.getByText('2m ago')).toBeInTheDocument();
	});

	it('renders multiple toasts', () => {
		const toasts = [
			makeToast({ id: '1', title: 'First' }),
			makeToast({ id: '2', title: 'Second' }),
			makeToast({ id: '3', title: 'Third' })
		];
		render(Toast, { props: { toasts } });
		expect(screen.getByText('First')).toBeInTheDocument();
		expect(screen.getByText('Second')).toBeInTheDocument();
		expect(screen.getByText('Third')).toBeInTheDocument();
	});

	it('applies green border for success variant', () => {
		const { container } = render(Toast, {
			props: { toasts: [makeToast({ variant: 'success' })] }
		});
		const card = container.querySelector('.border-l-4');
		expect(card).toHaveClass('border-l-accent-green');
	});

	it('applies red border for error variant', () => {
		const { container } = render(Toast, {
			props: { toasts: [makeToast({ variant: 'error' })] }
		});
		const card = container.querySelector('.border-l-4');
		expect(card).toHaveClass('border-l-accent-red');
	});

	it('applies yellow border for warning variant', () => {
		const { container } = render(Toast, {
			props: { toasts: [makeToast({ variant: 'warning' })] }
		});
		const card = container.querySelector('.border-l-4');
		expect(card).toHaveClass('border-l-accent-yellow');
	});

	it('applies blue border for info variant', () => {
		const { container } = render(Toast, {
			props: { toasts: [makeToast({ variant: 'info' })] }
		});
		const card = container.querySelector('.border-l-4');
		expect(card).toHaveClass('border-l-accent-blue');
	});

	it('calls onDismiss with toast id when dismiss button is clicked', async () => {
		const handler = vi.fn();
		const { container } = render(Toast, {
			props: { toasts: [makeToast({ id: 'dismiss-me' })], onDismiss: handler }
		});
		const dismissBtn = container.querySelector('button');
		await fireEvent.click(dismissBtn!);
		expect(handler).toHaveBeenCalledWith('dismiss-me');
	});

	it('renders dismiss button with times symbol', () => {
		const { container } = render(Toast, {
			props: { toasts: [makeToast()] }
		});
		const btn = container.querySelector('button');
		expect(btn?.textContent?.trim()).toBe('\u00d7');
	});

	it('container is fixed positioned at bottom-right', () => {
		const { container } = render(Toast, {
			props: { toasts: [makeToast()] }
		});
		const wrapper = container.querySelector('.fixed');
		expect(wrapper).toHaveClass('bottom-6', 'right-6');
	});
});
