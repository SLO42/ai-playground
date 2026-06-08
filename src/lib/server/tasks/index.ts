// server/tasks — public barrel (TASK 1.3; ARCHITECTURE §2/§3, depends on: db, events).
//
// DB-backed CRUD for the `task` table + the status STATE MACHINE that guards every
// transition. A task status change is the primary orchestrator trigger: the live
// query on `task` (owned by events/watchTable, §2.11) republishes the change onto
// the one events bus — this module never opens its own live query or publishes.

export {
	// CRUD
	createTask,
	getTask,
	listTasks,
	listTasksByProject,
	updateTask,
	deleteTask,
	// status machine
	setStatus,
	canTransition,
	nextStatuses,
	InvalidTransitionError,
	// enums
	TASK_STATUSES,
	TASK_PRIORITIES,
	TASK_ORIGINS,
	// types
	type TaskRow,
	type TaskStatus,
	type TaskPriority,
	type TaskOrigin,
	type CreateTaskInput,
	type UpdateTaskInput
} from './repo';
