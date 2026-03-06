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
}
