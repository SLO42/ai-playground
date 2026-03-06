import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import HookList from './HookList.svelte';

const makeHook = (overrides: Partial<{ name: string; type: string; description: string; command: string; enabled: boolean }> = {}) => ({
	name: 'pre-commit',
	type: 'pre',
	description: 'Run before commit',
	command: 'npm run lint',
	enabled: true,
	...overrides
});

const baseProps = {
	hooks: [makeHook()],
	total: 1,
	currentPage: 1,
	totalPages: 1,
	pageSize: 10,
	loading: false,
	ondelete: vi.fn()
};

describe('HookList', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	// --- Rendering ---

	it('renders the registry heading with total count', () => {
		render(HookList, { props: { ...baseProps, total: 5 } });
		expect(screen.getByText('Hook Registry (5)')).toBeInTheDocument();
	});

	it('renders hook name', () => {
		render(HookList, { props: baseProps });
		expect(screen.getByText('pre-commit')).toBeInTheDocument();
	});

	it('renders hook type badge', () => {
		render(HookList, { props: baseProps });
		expect(screen.getByText('pre')).toBeInTheDocument();
	});

	it('renders hook description', () => {
		render(HookList, { props: baseProps });
		expect(screen.getByText('Run before commit')).toBeInTheDocument();
	});

	it('renders hook command when present', () => {
		render(HookList, { props: baseProps });
		expect(screen.getByText('npm run lint')).toBeInTheDocument();
	});

	it('does not render command when absent', () => {
		const hook = makeHook({ command: undefined });
		render(HookList, { props: { ...baseProps, hooks: [hook] } });
		expect(screen.queryByText('npm run lint')).not.toBeInTheDocument();
	});

	it('renders multiple hooks', () => {
		const hooks = [
			makeHook({ name: 'hook-a' }),
			makeHook({ name: 'hook-b' }),
			makeHook({ name: 'hook-c' })
		];
		render(HookList, { props: { ...baseProps, hooks, total: 3 } });
		expect(screen.getByText('hook-a')).toBeInTheDocument();
		expect(screen.getByText('hook-b')).toBeInTheDocument();
		expect(screen.getByText('hook-c')).toBeInTheDocument();
	});

	// --- Enabled / Disabled status ---

	it('shows enabled status for enabled hook', () => {
		render(HookList, { props: baseProps });
		expect(screen.getByText('enabled')).toBeInTheDocument();
	});

	it('shows disabled status for disabled hook', () => {
		const hook = makeHook({ enabled: false });
		render(HookList, { props: { ...baseProps, hooks: [hook] } });
		expect(screen.getByText('disabled')).toBeInTheDocument();
	});

	it('applies green class to enabled indicator dot', () => {
		const { container } = render(HookList, { props: baseProps });
		const dot = container.querySelector('.bg-accent-green.rounded-full');
		expect(dot).toBeInTheDocument();
	});

	// --- Type badge colors ---

	it('applies correct badge color for pre type', () => {
		const { container } = render(HookList, { props: baseProps });
		const badge = screen.getByText('pre');
		expect(badge).toHaveClass('bg-accent-blue/20');
	});

	it('applies correct badge color for post type', () => {
		const hook = makeHook({ type: 'post' });
		const { container } = render(HookList, { props: { ...baseProps, hooks: [hook] } });
		const badge = screen.getByText('post');
		expect(badge).toHaveClass('bg-accent-green/20');
	});

	it('applies fallback badge color for unknown type', () => {
		const hook = makeHook({ type: 'custom' });
		render(HookList, { props: { ...baseProps, hooks: [hook] } });
		const badge = screen.getByText('custom');
		expect(badge).toHaveClass('bg-bg-tertiary');
	});

	// --- Empty state ---

	it('renders empty state when no hooks', () => {
		render(HookList, { props: { ...baseProps, hooks: [], total: 0 } });
		expect(screen.getByText('No hooks configured')).toBeInTheDocument();
		expect(screen.getByText('Hooks let you run commands before or after key project events.')).toBeInTheDocument();
	});

	it('does not render Delete buttons in empty state', () => {
		render(HookList, { props: { ...baseProps, hooks: [], total: 0 } });
		expect(screen.queryByText('Delete')).not.toBeInTheDocument();
	});

	// --- Delete button ---

	it('renders a Delete button for each hook', () => {
		const hooks = [makeHook({ name: 'a' }), makeHook({ name: 'b' })];
		render(HookList, { props: { ...baseProps, hooks, total: 2 } });
		const deleteButtons = screen.getAllByText('Delete');
		expect(deleteButtons).toHaveLength(2);
	});

	it('calls ondelete with hook name when Delete is clicked', async () => {
		const ondelete = vi.fn();
		render(HookList, { props: { ...baseProps, ondelete } });
		await fireEvent.click(screen.getByText('Delete'));
		expect(ondelete).toHaveBeenCalledWith('pre-commit');
	});

	it('disables Delete button when loading', () => {
		render(HookList, { props: { ...baseProps, loading: true } });
		const btn = screen.getByText('Delete');
		expect(btn).toBeDisabled();
	});

	// --- Pagination ---

	it('does not render pagination when totalPages is 1', () => {
		render(HookList, { props: baseProps });
		expect(screen.queryByText('Prev')).not.toBeInTheDocument();
		expect(screen.queryByText('Next')).not.toBeInTheDocument();
	});

	it('renders pagination when totalPages > 1', () => {
		render(HookList, { props: { ...baseProps, total: 25, totalPages: 3, currentPage: 1 } });
		expect(screen.getByText('Prev')).toBeInTheDocument();
		expect(screen.getByText('Next')).toBeInTheDocument();
	});

	it('renders page number buttons', () => {
		render(HookList, { props: { ...baseProps, total: 25, totalPages: 3, currentPage: 2 } });
		expect(screen.getByText('1')).toBeInTheDocument();
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByText('3')).toBeInTheDocument();
	});

	it('shows correct showing range text', () => {
		render(HookList, { props: { ...baseProps, total: 25, totalPages: 3, currentPage: 2, pageSize: 10 } });
		expect(screen.getByText(/Showing 11–20 of 25/)).toBeInTheDocument();
	});

	it('disables Prev button on first page', () => {
		render(HookList, { props: { ...baseProps, total: 20, totalPages: 2, currentPage: 1 } });
		expect(screen.getByText('Prev')).toBeDisabled();
	});

	it('disables Next button on last page', () => {
		render(HookList, { props: { ...baseProps, total: 20, totalPages: 2, currentPage: 2 } });
		expect(screen.getByText('Next')).toBeDisabled();
	});

	it('highlights current page button', () => {
		render(HookList, { props: { ...baseProps, total: 20, totalPages: 2, currentPage: 2 } });
		const pageBtn = screen.getByText('2');
		expect(pageBtn).toHaveClass('bg-accent-blue');
	});
});
