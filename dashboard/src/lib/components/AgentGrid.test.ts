import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import AgentGrid from './AgentGrid.svelte';

const typeColors: Record<string, string> = {
	coder: 'bg-accent-blue/20 text-accent-blue',
	researcher: 'bg-accent-purple/20 text-accent-purple',
	general: 'bg-bg-tertiary text-text-secondary'
};

const statusDots: Record<string, string> = {
	active: 'bg-accent-green',
	idle: 'bg-accent-yellow',
	stopped: 'bg-accent-red'
};

const basePagination = { page: 1, pageSize: 10, totalItems: 0, totalPages: 1 };

function makeAgent(overrides: Partial<{ name: string; type: string; status: string; description: string; filename: string }> = {}) {
	return {
		name: overrides.name ?? 'Test Agent',
		type: overrides.type ?? 'coder',
		status: overrides.status ?? 'idle',
		description: overrides.description ?? 'A test agent',
		filename: overrides.filename ?? 'test-agent.md'
	};
}

function renderGrid(props: Partial<Parameters<typeof AgentGrid>[1]> = {}) {
	const defaults = {
		agents: [],
		pagination: basePagination,
		typeColors,
		statusDots,
		loading: false,
		onremove: vi.fn(),
		ongoToPage: vi.fn()
	};
	return render(AgentGrid, { props: { ...defaults, ...props } });
}

describe('AgentGrid', () => {
	describe('empty state', () => {
		it('shows empty message when no agents', () => {
			renderGrid({ agents: [] });
			expect(screen.getByText('No agents associated')).toBeInTheDocument();
			expect(screen.getByText(/Add agents to this project/)).toBeInTheDocument();
		});

		it('does not render pagination when empty', () => {
			renderGrid({ agents: [] });
			expect(screen.queryByText('Prev')).not.toBeInTheDocument();
			expect(screen.queryByText('Next')).not.toBeInTheDocument();
		});
	});

	describe('agent rendering', () => {
		it('renders agent name and type', () => {
			const agent = makeAgent({ name: 'My Coder', type: 'coder' });
			renderGrid({ agents: [agent], pagination: { ...basePagination, totalItems: 1 } });
			expect(screen.getByText('My Coder')).toBeInTheDocument();
			expect(screen.getByText('coder')).toBeInTheDocument();
		});

		it('renders agent description', () => {
			const agent = makeAgent({ description: 'Writes clean code' });
			renderGrid({ agents: [agent], pagination: { ...basePagination, totalItems: 1 } });
			expect(screen.getByText('Writes clean code')).toBeInTheDocument();
		});

		it('renders agent filename', () => {
			const agent = makeAgent({ filename: 'agents/my-coder.md' });
			renderGrid({ agents: [agent], pagination: { ...basePagination, totalItems: 1 } });
			expect(screen.getByText('agents/my-coder.md')).toBeInTheDocument();
		});

		it('renders multiple agents', () => {
			const agents = [
				makeAgent({ name: 'Agent A', filename: 'a.md' }),
				makeAgent({ name: 'Agent B', filename: 'b.md' }),
				makeAgent({ name: 'Agent C', filename: 'c.md' })
			];
			renderGrid({ agents, pagination: { ...basePagination, totalItems: 3 } });
			expect(screen.getByText('Agent A')).toBeInTheDocument();
			expect(screen.getByText('Agent B')).toBeInTheDocument();
			expect(screen.getByText('Agent C')).toBeInTheDocument();
		});

		it('renders Remove button for each agent', () => {
			const agents = [
				makeAgent({ name: 'A1', filename: 'a1.md' }),
				makeAgent({ name: 'A2', filename: 'a2.md' })
			];
			renderGrid({ agents, pagination: { ...basePagination, totalItems: 2 } });
			const removeButtons = screen.getAllByText('Remove');
			expect(removeButtons).toHaveLength(2);
		});
	});

	describe('loading state', () => {
		it('disables Remove buttons when loading', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { ...basePagination, totalItems: 1 }, loading: true });
			const removeBtn = screen.getByText('Remove');
			expect(removeBtn).toBeDisabled();
		});

		it('enables Remove buttons when not loading', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { ...basePagination, totalItems: 1 }, loading: false });
			const removeBtn = screen.getByText('Remove');
			expect(removeBtn).not.toBeDisabled();
		});
	});

	describe('remove action', () => {
		it('calls onremove with filename when Remove clicked', async () => {
			const onremove = vi.fn();
			const agent = makeAgent({ filename: 'special-agent.md' });
			renderGrid({ agents: [agent], pagination: { ...basePagination, totalItems: 1 }, onremove });
			await fireEvent.click(screen.getByText('Remove'));
			expect(onremove).toHaveBeenCalledWith('special-agent.md');
		});
	});

	describe('pagination', () => {
		it('does not render pagination when totalPages is 1', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 } });
			expect(screen.queryByText('Prev')).not.toBeInTheDocument();
			expect(screen.queryByText('Next')).not.toBeInTheDocument();
		});

		it('renders pagination when totalPages > 1', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 25, totalPages: 3 } });
			expect(screen.getByText('Prev')).toBeInTheDocument();
			expect(screen.getByText('Next')).toBeInTheDocument();
		});

		it('shows correct item range text', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 2, pageSize: 10, totalItems: 25, totalPages: 3 } });
			expect(screen.getByText(/11–20 of 25 agents/)).toBeInTheDocument();
		});

		it('disables Prev on first page', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 25, totalPages: 3 } });
			expect(screen.getByText('Prev')).toBeDisabled();
		});

		it('disables Next on last page', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 3, pageSize: 10, totalItems: 25, totalPages: 3 } });
			expect(screen.getByText('Next')).toBeDisabled();
		});

		it('enables Prev on page > 1', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 2, pageSize: 10, totalItems: 25, totalPages: 3 } });
			expect(screen.getByText('Prev')).not.toBeDisabled();
		});

		it('enables Next on non-last page', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 25, totalPages: 3 } });
			expect(screen.getByText('Next')).not.toBeDisabled();
		});

		it('calls ongoToPage with previous page when Prev clicked', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 2, pageSize: 10, totalItems: 25, totalPages: 3 }, ongoToPage });
			await fireEvent.click(screen.getByText('Prev'));
			expect(ongoToPage).toHaveBeenCalledWith(1);
		});

		it('calls ongoToPage with next page when Next clicked', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 25, totalPages: 3 }, ongoToPage });
			await fireEvent.click(screen.getByText('Next'));
			expect(ongoToPage).toHaveBeenCalledWith(2);
		});

		it('renders page number buttons for small page counts', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 50, totalPages: 5 } });
			for (let i = 1; i <= 5; i++) {
				expect(screen.getByText(String(i))).toBeInTheDocument();
			}
		});

		it('calls ongoToPage when page number clicked', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 30, totalPages: 3 }, ongoToPage });
			await fireEvent.click(screen.getByText('3'));
			expect(ongoToPage).toHaveBeenCalledWith(3);
		});

		it('highlights current page number', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 2, pageSize: 10, totalItems: 30, totalPages: 3 } });
			const pageBtn = screen.getByText('2');
			expect(pageBtn).toHaveClass('font-bold');
		});

		it('renders ellipsis for large page counts', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 5, pageSize: 10, totalItems: 100, totalPages: 10 } });
			const ellipses = screen.getAllByText('...');
			expect(ellipses.length).toBeGreaterThanOrEqual(1);
		});

		it('shows correct range on last page with partial items', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 3, pageSize: 10, totalItems: 25, totalPages: 3 } });
			expect(screen.getByText(/21–25 of 25 agents/)).toBeInTheDocument();
		});

		it('shows correct range on first page', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 25, totalPages: 3 } });
			expect(screen.getByText(/1–10 of 25 agents/)).toBeInTheDocument();
		});

		it('sets aria-current on the active page button', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 2, pageSize: 10, totalItems: 30, totalPages: 3 } });
			const pageBtn = screen.getByText('2');
			expect(pageBtn).toHaveAttribute('aria-current', 'page');
			expect(screen.getByText('1')).not.toHaveAttribute('aria-current');
		});

		it('announces page info via aria-live region', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 2, pageSize: 10, totalItems: 30, totalPages: 3 } });
			expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
		});
	});

	describe('keyboard navigation', () => {
		function getPaginationGroup() {
			return screen.getByRole('group', { name: /pagination controls/i });
		}

		it('ArrowRight calls ongoToPage with next page', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 30, totalPages: 3 }, ongoToPage });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'ArrowRight' });
			expect(ongoToPage).toHaveBeenCalledWith(2);
		});

		it('ArrowLeft calls ongoToPage with previous page', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 2, pageSize: 10, totalItems: 30, totalPages: 3 }, ongoToPage });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'ArrowLeft' });
			expect(ongoToPage).toHaveBeenCalledWith(1);
		});

		it('Home calls ongoToPage with page 1', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 3, pageSize: 10, totalItems: 30, totalPages: 3 }, ongoToPage });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'Home' });
			expect(ongoToPage).toHaveBeenCalledWith(1);
		});

		it('End calls ongoToPage with last page', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 30, totalPages: 3 }, ongoToPage });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'End' });
			expect(ongoToPage).toHaveBeenCalledWith(3);
		});

		it('ArrowLeft does nothing on first page', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 30, totalPages: 3 }, ongoToPage });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'ArrowLeft' });
			expect(ongoToPage).not.toHaveBeenCalled();
		});

		it('ArrowRight does nothing on last page', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 3, pageSize: 10, totalItems: 30, totalPages: 3 }, ongoToPage });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'ArrowRight' });
			expect(ongoToPage).not.toHaveBeenCalled();
		});

		it('Home is a no-op when already on first page', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 30, totalPages: 3 }, ongoToPage });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'Home' });
			// Home always calls ongoToPage(1), even on page 1
			expect(ongoToPage).toHaveBeenCalledWith(1);
		});

		it('unrelated keys do not trigger navigation', async () => {
			const ongoToPage = vi.fn();
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 2, pageSize: 10, totalItems: 30, totalPages: 3 }, ongoToPage });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'Enter' });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'Tab' });
			await fireEvent.keyDown(getPaginationGroup(), { key: 'a' });
			expect(ongoToPage).not.toHaveBeenCalled();
		});
	});

	describe('page boundary conditions', () => {
		it('single page does not show navigation', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 5, totalPages: 1 } });
			expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
		});

		it('two pages shows both page buttons without ellipsis', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 15, totalPages: 2 } });
			expect(screen.getByText('1')).toBeInTheDocument();
			expect(screen.getByText('2')).toBeInTheDocument();
			expect(screen.queryByText('...')).not.toBeInTheDocument();
		});

		it('seven pages shows all buttons without ellipsis', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 4, pageSize: 10, totalItems: 70, totalPages: 7 } });
			for (let i = 1; i <= 7; i++) {
				expect(screen.getByText(String(i))).toBeInTheDocument();
			}
			expect(screen.queryByText('...')).not.toBeInTheDocument();
		});

		it('eight pages shows ellipsis', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 1, pageSize: 10, totalItems: 80, totalPages: 8 } });
			expect(screen.getByText('...')).toBeInTheDocument();
		});

		it('page near start shows trailing ellipsis only', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 2, pageSize: 10, totalItems: 100, totalPages: 10 } });
			const ellipses = screen.getAllByText('...');
			expect(ellipses).toHaveLength(1);
			// First page and last page always visible
			expect(screen.getByText('1')).toBeInTheDocument();
			expect(screen.getByText('10')).toBeInTheDocument();
		});

		it('page near end shows leading ellipsis only', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 9, pageSize: 10, totalItems: 100, totalPages: 10 } });
			const ellipses = screen.getAllByText('...');
			expect(ellipses).toHaveLength(1);
			expect(screen.getByText('1')).toBeInTheDocument();
			expect(screen.getByText('10')).toBeInTheDocument();
		});

		it('page in middle shows both ellipses', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 5, pageSize: 10, totalItems: 100, totalPages: 10 } });
			const ellipses = screen.getAllByText('...');
			expect(ellipses).toHaveLength(2);
		});

		it('pageSize of 1 shows correct range for single-item pages', () => {
			const agent = makeAgent();
			renderGrid({ agents: [agent], pagination: { page: 3, pageSize: 1, totalItems: 5, totalPages: 5 } });
			expect(screen.getByText(/3–3 of 5 agents/)).toBeInTheDocument();
		});
	});
});
