'use client';

// Facade: the task hooks were split into `./tasks/*` (one mutation per file plus
// shared optimistic-cache helpers). Keep this module as the stable import path
// so the Board/List/Calendar/Timeline/detail views don't need to change.
export { tasksKey } from './tasks/query-helpers';
export { useTasks } from './tasks/use-tasks-query';
export { useCreateTask } from './tasks/use-create-task';
export { useUpdateTask } from './tasks/use-update-task';
export { useReorderTask } from './tasks/use-reorder-task';
export { useDeleteTask } from './tasks/use-delete-task';
export { useBulkTasks } from './tasks/use-bulk-tasks';
export { useWorkspaceMembers } from './use-workspace-members';
