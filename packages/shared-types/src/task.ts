import { z } from 'zod';

import { cuid } from './common/id.js';
import { paginationQuerySchema, sortOrderSchema } from './common/pagination.js';
import { TaskPriority, TaskStatus } from './enums.js';
import { userSummarySchema } from './user.js';

export const taskSchema = z.object({
  id: cuid,
  projectId: cuid,
  parentTaskId: cuid.nullable(),
  createdById: cuid,
  assigneeId: cuid.nullable(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  status: TaskStatus,
  priority: TaskPriority,
  position: z.number().int(),
  startDate: z.coerce.date().nullable(),
  dueDate: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  /** Decimal as string for safe serialization; coerce on the client. */
  estimateHours: z.string().nullable(),
  /** Client portal: listed for the project's client when the project shows
   *  marked tasks only (absent reads as false). Read-only here; changed
   *  through `PATCH /tasks/:id/portal-visibility`, never the generic update. */
  portalVisible: z.boolean().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskWithPeopleSchema = taskSchema.extend({
  createdBy: userSummarySchema,
  assignee: userSummarySchema.nullable(),
  sprintTasks: z
    .array(
      z.object({
        sprint: z.object({ id: cuid, name: z.string() }),
      }),
    )
    .optional(),
  project: z
    .object({
      id: cuid,
      name: z.string(),
      key: z.string().optional(),
      color: z.string().nullable().optional(),
      workspace: z.object({ id: cuid, name: z.string() }).optional(),
    })
    .optional(),
});
export type TaskWithPeople = z.infer<typeof taskWithPeopleSchema>;

/**
 * HTML `<input type="date">` returns `""` (empty string) when the user clears
 * the value. `z.coerce.date()` on `""` produces an Invalid Date and the
 * validator rejects the field even when it's marked `.optional()`. Preprocess
 * the empty/null/undefined cases to `undefined` so the optional check fires
 * first.
 */
const optionalDate = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.date().optional(),
);

export const createTaskSchema = z.object({
  projectId: cuid,
  parentTaskId: cuid.optional(),
  assigneeId: cuid.optional(),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  position: z.number().int().optional(),
  startDate: optionalDate,
  dueDate: optionalDate,
  estimateHours: z.coerce.string().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  position: z.number().int().optional(),
  assigneeId: cuid.nullable().optional(),
  parentTaskId: cuid.nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  completedAt: z.coerce.date().nullable().optional(),
  estimateHours: z.coerce.string().nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/** Single drag-and-drop reorder operation for the kanban board. */
export const reorderTaskSchema = z.object({
  taskId: cuid,
  status: TaskStatus,
  position: z.number().int(),
});
export type ReorderTaskInput = z.infer<typeof reorderTaskSchema>;

/** Which task date a list's `from`/`to` range filters on. */
export const TaskDateField = z.enum(['due', 'created', 'completed']);
export type TaskDateField = z.infer<typeof TaskDateField>;

export const listTasksQuerySchema = paginationQuerySchema
  .extend({
    projectId: cuid.optional(),
    /// Phase 4 org-layer: optional explicit workspace filter. When present
    /// AND the caller is a member of the workspace's organization, the
    /// list narrows to that workspace. Omit to use the legacy current-
    /// workspace (header) scope, or pair with `aggregate='org'` to widen
    /// the view to every workspace in the caller's organization.
    workspaceId: cuid.optional(),
    /// Phase 4 org-layer: when set to 'org', the list is aggregated
    /// across all workspaces the caller's organization owns. Without it
    /// the legacy header-scoped behavior is preserved exactly.
    aggregate: z.enum(['org']).optional(),
    status: z.union([TaskStatus, z.array(TaskStatus)]).optional(),
    priority: z.union([TaskPriority, z.array(TaskPriority)]).optional(),
    assigneeId: z.union([cuid, z.array(cuid)]).optional(),
    assigneeIds: z.union([cuid, z.array(cuid)]).optional(),
    assignedToMe: z
      .union([z.literal('true'), z.literal('false')])
      .transform((v) => v === 'true')
      .optional(),
    /// Also match tasks with no assignee. OR'd with `assigneeId(s)` when both
    /// are given ("Alice, Bob or unassigned"); alone it lists unassigned tasks
    /// only. `assignedToMe` still overrides every assignee filter.
    unassigned: z
      .union([z.literal('true'), z.literal('false')])
      .transform((v) => v === 'true')
      .optional(),
    dueBefore: z.coerce.date().optional(),
    dueAfter: z.coerce.date().optional(),
    /// Only tasks without a due date. Combined with `dueBefore`/`dueAfter` it
    /// matches nothing, as you would expect.
    noDueDate: z
      .union([z.literal('true'), z.literal('false')])
      .transform((v) => v === 'true')
      .optional(),
    /// Generic date range: `from`/`to` are inclusive UTC instants applied to the
    /// column `dateField` names (default `due`). `completed` falls back to
    /// `updatedAt` for DONE tasks completed before `completedAt` was tracked.
    /// Independent of (and ANDed with) `dueBefore`/`dueAfter`.
    dateField: TaskDateField.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    search: z.string().optional(),
    sort: z.enum(['position', 'createdAt', 'updatedAt', 'dueDate', 'priority']).default('position'),
    order: sortOrderSchema,
  })
  .refine((q) => !q.from || !q.to || q.from.getTime() <= q.to.getTime(), {
    message: '`from` must not be after `to`.',
    path: ['from'],
  });
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

/**
 * Bulk task operations issued from Board/List multi-select. A single endpoint
 * wraps the entire batch in a Prisma transaction so partial failures don't
 * leave the cache out of sync with the database.
 */
export const bulkTaskOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), status: TaskStatus }),
  z.object({ kind: z.literal('priority'), priority: TaskPriority }),
  z.object({ kind: z.literal('assignee'), assigneeId: cuid.nullable() }),
  z.object({ kind: z.literal('delete') }),
]);
export type BulkTaskOperation = z.infer<typeof bulkTaskOperationSchema>;

export const bulkTaskRequestSchema = z.object({
  ids: z.array(cuid).min(1).max(500),
  operation: bulkTaskOperationSchema,
});
export type BulkTaskRequest = z.infer<typeof bulkTaskRequestSchema>;

export const bulkTaskResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
});
export type BulkTaskResponse = z.infer<typeof bulkTaskResponseSchema>;
