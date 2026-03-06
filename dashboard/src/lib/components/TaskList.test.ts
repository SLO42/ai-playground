import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import TaskList from './TaskList.svelte';
import type { Task } from '$lib/types/tasks.js';

function makeTask(overrides: Partial<Task & { projectId?: string; projectName?: string; githubIssue?: number }> = {}): Task & { projectId?: string; projectName?: string; githubIssue?: number } {
	return {
		id: 'task-1',
		title: 'Test task',
		description: 'A test task',
		status: 'pending',
		priority: 'medium',
		flagDiscussion: false,
		assignee: null,
		tags: [],
		feature: null,
		createdBy: 'user',
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		completedAt: null,
		...overrides
	};
}

describe('TaskList', () => {
	const baseProps = {
		tasks: [makeTask()],
		selectedId: null,
		filter: 'active' as const,
		onselect: vi.fn(),
		onfilter: vi.fn()
	};

	it('renders task title', () => {
		render(TaskList, { props: baseProps });
		expect(screen.getByText('Test task')).toBeInTheDocument();
	});

	it('renders empty state when no tasks', () => {
		render(TaskList, { props: { ...baseProps, tasks: [] } });
		expect(screen.getByText('No tasks found')).toBeInTheDocument();
		expect(screen.getByText('Create a task to get started.')).toBeInTheDocument();
	});

	it('renders filter tabs', () => {
		render(TaskList, { props: baseProps });
		expect(screen.getByText('Active')).toBeInTheDocument();
		expect(screen.getByText('Completed')).toBeInTheDocument();
		expect(screen.getByText('All')).toBeInTheDocument();
	});

	it('calls onfilter when tab clicked', async () => {
		const onfilter = vi.fn();
		render(TaskList, { props: { ...baseProps, onfilter } });
		await fireEvent.click(screen.getByText('Completed'));
		expect(onfilter).toHaveBeenCalledWith('completed');
	});

	it('calls onselect when task clicked', async () => {
		const onselect = vi.fn();
		render(TaskList, { props: { ...baseProps, onselect } });
		await fireEvent.click(screen.getByText('Test task'));
		expect(onselect).toHaveBeenCalledWith('task-1');
	});

	it('highlights selected task', () => {
		const { container } = render(TaskList, { props: { ...baseProps, selectedId: 'task-1' } });
		const selected = container.querySelector('.border-l-accent-blue');
		expect(selected).toBeInTheDocument();
	});

	it('renders priority dot with correct color', () => {
		const { container } = render(TaskList, {
			props: { ...baseProps, tasks: [makeTask({ priority: 'critical' })] }
		});
		const dot = container.querySelector('.bg-accent-red');
		expect(dot).toBeInTheDocument();
	});

	it('renders high priority dot', () => {
		const { container } = render(TaskList, {
			props: { ...baseProps, tasks: [makeTask({ priority: 'high' })] }
		});
		expect(container.querySelector('.bg-accent-yellow')).toBeInTheDocument();
	});

	it('renders low priority dot', () => {
		const { container } = render(TaskList, {
			props: { ...baseProps, tasks: [makeTask({ priority: 'low' })] }
		});
		expect(container.querySelector('.bg-border')).toBeInTheDocument();
	});

	it('shows flag icon for flagDiscussion tasks', () => {
		const { container } = render(TaskList, {
			props: { ...baseProps, tasks: [makeTask({ flagDiscussion: true })] }
		});
		const svg = container.querySelector('svg');
		expect(svg).toBeInTheDocument();
	});

	it('renders assignee badge', () => {
		render(TaskList, {
			props: { ...baseProps, tasks: [makeTask({ assignee: 'claw' })] }
		});
		expect(screen.getByText('claw')).toBeInTheDocument();
	});

	it('renders tags (max 2)', () => {
		render(TaskList, {
			props: { ...baseProps, tasks: [makeTask({ tags: ['bug', 'frontend', 'urgent'] })] }
		});
		expect(screen.getByText('bug')).toBeInTheDocument();
		expect(screen.getByText('frontend')).toBeInTheDocument();
		expect(screen.queryByText('urgent')).not.toBeInTheDocument();
	});

	it('renders github issue badge', () => {
		render(TaskList, {
			props: { ...baseProps, tasks: [makeTask({ githubIssue: 42 })] }
		});
		expect(screen.getByText('#42')).toBeInTheDocument();
	});

	it('shows Start button for pending tasks when onstart provided', () => {
		render(TaskList, {
			props: { ...baseProps, onstart: vi.fn() }
		});
		expect(screen.getByText('Start')).toBeInTheDocument();
	});

	it('does not show Start button without onstart', () => {
		render(TaskList, { props: baseProps });
		expect(screen.queryByText('Start')).not.toBeInTheDocument();
	});

	it('does not show Start button for non-pending tasks', () => {
		render(TaskList, {
			props: { ...baseProps, tasks: [makeTask({ status: 'in_progress' })], onstart: vi.fn() }
		});
		expect(screen.queryByText('Start')).not.toBeInTheDocument();
	});

	it('calls onstart when Start button clicked', async () => {
		const onstart = vi.fn();
		render(TaskList, { props: { ...baseProps, onstart } });
		await fireEvent.click(screen.getByText('Start'));
		expect(onstart).toHaveBeenCalledWith('task-1');
	});

	it('shows pulse indicator for in_progress tasks', () => {
		const { container } = render(TaskList, {
			props: { ...baseProps, tasks: [makeTask({ status: 'in_progress' })] }
		});
		expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
	});

	it('renders project badge when showProjectBadge is true', () => {
		render(TaskList, {
			props: {
				...baseProps,
				showProjectBadge: true,
				tasks: [makeTask({ projectName: 'My Project' })]
			}
		});
		expect(screen.getByText('My Project')).toBeInTheDocument();
	});

	it('renders project filter dropdown when conditions met', () => {
		const { container } = render(TaskList, {
			props: {
				...baseProps,
				showProjectBadge: true,
				projects: [{ id: 'p1', name: 'Project 1' }],
				onprojectfilter: vi.fn()
			}
		});
		expect(container.querySelector('select')).toBeInTheDocument();
		expect(screen.getByText('All projects')).toBeInTheDocument();
		expect(screen.getByText('Project 1')).toBeInTheDocument();
	});

	it('renders multiple tasks', () => {
		render(TaskList, {
			props: {
				...baseProps,
				tasks: [
					makeTask({ id: 't1', title: 'First task' }),
					makeTask({ id: 't2', title: 'Second task' })
				]
			}
		});
		expect(screen.getByText('First task')).toBeInTheDocument();
		expect(screen.getByText('Second task')).toBeInTheDocument();
	});

	it('highlights active filter tab', () => {
		render(TaskList, { props: { ...baseProps, filter: 'completed' } });
		const completedBtn = screen.getByText('Completed');
		expect(completedBtn).toHaveClass('text-accent-blue');
	});
});
