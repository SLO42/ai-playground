export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export interface Task {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	priority: TaskPriority;
	flagDiscussion: boolean;
	assignee: string | null;
	tags: string[];
	/** Feature/milestone grouping — tasks in the same feature ship together. */
	feature: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	/** Task IDs that must be completed/cancelled before this task can be worked. */
	blockedBy?: string[];
	/** Runtime-only: which project this task belongs to (set by heartbeat scanner, not persisted). */
	_sourceProjectId?: string;
	/** Runtime-only: absolute path to the project root (set by heartbeat scanner, not persisted). */
	_sourceProjectPath?: string;
}
