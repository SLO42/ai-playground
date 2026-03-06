import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import TaskDetail from './TaskDetail.svelte';
import type { Task } from '$lib/types/tasks.js';

function makeTask(overrides: Partial<Task & { projectId?: string; projectName?: string; githubIssue?: number; githubUrl?: string }> = {}): Task & { projectId?: string; projectName?: string; githubIssue?: number; githubUrl?: string } {
	return {
		id: 'task-1',
		title: 'Test task',
		description: 'A test description',
		status: 'pending',
		priority: 'medium',
		flagDiscussion: false,
		assignee: null,
		tags: ['bug', 'frontend'],
		feature: null,
		createdBy: 'user',
		createdAt: '2026-01-15T10:30:00Z',
		updatedAt: '2026-01-15T12:00:00Z',
		completedAt: null,
		...overrides
	};
}

describe('TaskDetail', () => {
	const baseProps = {
		task: makeTask(),
		agentNames: ['claw', 'researcher'],
		onupdate: vi.fn(),
		ondelete: vi.fn()
	};

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('renders task detail heading', () => {
		render(TaskDetail, { props: baseProps });
		expect(screen.getByText('Task Detail')).toBeInTheDocument();
	});

	it('renders task id', () => {
		render(TaskDetail, { props: baseProps });
		expect(screen.getByText('task-1')).toBeInTheDocument();
	});

	it('renders title input with task title', () => {
		render(TaskDetail, { props: baseProps });
		const input = screen.getByDisplayValue('Test task');
		expect(input).toBeInTheDocument();
	});

	it('renders description textarea', () => {
		render(TaskDetail, { props: baseProps });
		const textarea = screen.getByDisplayValue('A test description');
		expect(textarea).toBeInTheDocument();
	});

	it('calls onupdate when title changes', async () => {
		const onupdate = vi.fn();
		render(TaskDetail, { props: { ...baseProps, onupdate } });
		const input = screen.getByDisplayValue('Test task');
		await fireEvent.change(input, { target: { value: 'Updated title' } });
		expect(onupdate).toHaveBeenCalledWith('title', 'Updated title');
	});

	it('calls onupdate when description changes', async () => {
		const onupdate = vi.fn();
		render(TaskDetail, { props: { ...baseProps, onupdate } });
		const textarea = screen.getByDisplayValue('A test description');
		await fireEvent.change(textarea, { target: { value: 'New desc' } });
		expect(onupdate).toHaveBeenCalledWith('description', 'New desc');
	});

	it('renders priority select with current value', () => {
		const { container } = render(TaskDetail, { props: baseProps });
		const selects = container.querySelectorAll('select');
		const prioritySelect = selects[0];
		expect(prioritySelect).toHaveValue('medium');
	});

	it('calls onupdate when priority changes', async () => {
		const onupdate = vi.fn();
		const { container } = render(TaskDetail, { props: { ...baseProps, onupdate } });
		const selects = container.querySelectorAll('select');
		await fireEvent.change(selects[0], { target: { value: 'critical' } });
		expect(onupdate).toHaveBeenCalledWith('priority', 'critical');
	});

	it('renders status select with current value', () => {
		const { container } = render(TaskDetail, { props: baseProps });
		const selects = container.querySelectorAll('select');
		const statusSelect = selects[1];
		expect(statusSelect).toHaveValue('pending');
	});

	it('calls onupdate when status changes', async () => {
		const onupdate = vi.fn();
		const { container } = render(TaskDetail, { props: { ...baseProps, onupdate } });
		const selects = container.querySelectorAll('select');
		await fireEvent.change(selects[1], { target: { value: 'completed' } });
		expect(onupdate).toHaveBeenCalledWith('status', 'completed');
	});

	it('renders assignee select with agent names', () => {
		render(TaskDetail, { props: baseProps });
		expect(screen.getByText('claw')).toBeInTheDocument();
		expect(screen.getByText('researcher')).toBeInTheDocument();
	});

	it('renders tags input', () => {
		render(TaskDetail, { props: baseProps });
		expect(screen.getByDisplayValue('bug, frontend')).toBeInTheDocument();
	});

	it('calls onupdate with parsed tags on change', async () => {
		const onupdate = vi.fn();
		render(TaskDetail, { props: { ...baseProps, onupdate } });
		const tagsInput = screen.getByDisplayValue('bug, frontend');
		await fireEvent.change(tagsInput, { target: { value: 'api, backend' } });
		expect(onupdate).toHaveBeenCalledWith('tags', ['api', 'backend']);
	});

	it('renders flag for discussion checkbox', () => {
		render(TaskDetail, { props: baseProps });
		expect(screen.getByText('Flag for Discussion')).toBeInTheDocument();
	});

	it('calls onupdate when flag checkbox toggled', async () => {
		const onupdate = vi.fn();
		render(TaskDetail, { props: { ...baseProps, onupdate } });
		const checkbox = screen.getByRole('checkbox');
		await fireEvent.change(checkbox);
		expect(onupdate).toHaveBeenCalledWith('flagDiscussion', true);
	});

	it('renders timestamps', () => {
		const { container } = render(TaskDetail, { props: baseProps });
		const labels = container.querySelectorAll('.uppercase.tracking-wider');
		const labelTexts = Array.from(labels).map((el) => el.textContent);
		expect(labelTexts).toContain('Created');
		expect(labelTexts).toContain('Updated');
		expect(labelTexts).toContain('Completed');
	});

	it('shows em dash for null completedAt', () => {
		const { container } = render(TaskDetail, { props: baseProps });
		const labels = container.querySelectorAll('.uppercase.tracking-wider');
		const completedLabel = Array.from(labels).find((el) => el.textContent === 'Completed');
		const value = completedLabel?.parentElement?.querySelector('.font-mono');
		expect(value?.textContent).toBe('\u2014');
	});

	it('shows Start button for pending tasks', () => {
		render(TaskDetail, { props: baseProps });
		expect(screen.getByText('Start')).toBeInTheDocument();
	});

	it('does not show Start button for non-pending tasks', () => {
		render(TaskDetail, {
			props: { ...baseProps, task: makeTask({ status: 'in_progress' }) }
		});
		expect(screen.queryByText('Start')).not.toBeInTheDocument();
	});

	it('shows Mark Complete button for non-completed tasks', () => {
		render(TaskDetail, { props: baseProps });
		expect(screen.getByText('Mark Complete')).toBeInTheDocument();
	});

	it('shows Reopen button for completed tasks', () => {
		render(TaskDetail, {
			props: { ...baseProps, task: makeTask({ status: 'completed' }) }
		});
		expect(screen.getByText('Reopen')).toBeInTheDocument();
	});

	it('calls onupdate with completed status when Mark Complete clicked', async () => {
		const onupdate = vi.fn();
		render(TaskDetail, { props: { ...baseProps, onupdate } });
		await fireEvent.click(screen.getByText('Mark Complete'));
		expect(onupdate).toHaveBeenCalledWith('status', 'completed');
	});

	it('calls onupdate with pending status when Reopen clicked', async () => {
		const onupdate = vi.fn();
		render(TaskDetail, {
			props: { ...baseProps, task: makeTask({ status: 'completed' }), onupdate }
		});
		await fireEvent.click(screen.getByText('Reopen'));
		expect(onupdate).toHaveBeenCalledWith('status', 'pending');
	});

	it('renders Delete button', () => {
		render(TaskDetail, { props: baseProps });
		expect(screen.getByText('Delete')).toBeInTheDocument();
	});

	it('calls ondelete when Delete clicked', async () => {
		const ondelete = vi.fn();
		render(TaskDetail, { props: { ...baseProps, ondelete } });
		await fireEvent.click(screen.getByText('Delete'));
		expect(ondelete).toHaveBeenCalled();
	});

	it('renders project link when showProjectLink and projectId set', () => {
		render(TaskDetail, {
			props: {
				...baseProps,
				showProjectLink: true,
				task: makeTask({ projectId: 'p1', projectName: 'My Project' })
			}
		});
		expect(screen.getByText('My Project')).toBeInTheDocument();
		expect(screen.getByText('Open in Project')).toBeInTheDocument();
	});

	it('renders github issue link when present', () => {
		render(TaskDetail, {
			props: {
				...baseProps,
				task: makeTask({ githubIssue: 99, githubUrl: 'https://github.com/org/repo/issues/99' })
			}
		});
		expect(screen.getByText('#99')).toBeInTheDocument();
	});

	it('handles Start button click with fetch', async () => {
		const onupdate = vi.fn();
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ task: makeTask({ status: 'in_progress' }) })
		});
		vi.stubGlobal('fetch', mockFetch);

		render(TaskDetail, { props: { ...baseProps, onupdate } });
		await fireEvent.click(screen.getByText('Start'));

		// Allow the async handler to complete
		await vi.advanceTimersByTimeAsync(0);

		expect(mockFetch).toHaveBeenCalledWith('/api/tasks/task-1/start', { method: 'POST' });
		expect(onupdate).toHaveBeenCalledWith('status', 'in_progress');
	});

	it('shows error when Start fails', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			json: () => Promise.resolve({ error: 'Server error' })
		});
		vi.stubGlobal('fetch', mockFetch);

		render(TaskDetail, { props: baseProps });
		await fireEvent.click(screen.getByText('Start'));
		await vi.advanceTimersByTimeAsync(0);

		expect(screen.getByText('Server error')).toBeInTheDocument();
	});

	it('shows polling indicator for in_progress tasks', () => {
		render(TaskDetail, {
			props: { ...baseProps, task: makeTask({ status: 'in_progress' }) }
		});
		expect(screen.getByText('Polling status...')).toBeInTheDocument();
	});
});
