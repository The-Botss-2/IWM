import { z } from 'zod';

import { cuid } from './common/id.js';

export const TodoPriority = z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']);
export type TodoPriority = z.infer<typeof TodoPriority>;

export const todoSchema = z.object({
  id: cuid,
  /// Creator. For non-assigned todos, also the implicit assignee.
  userId: cuid,
  workspaceId: cuid,
  /// Optional project link inside the workspace.
  projectId: cuid.nullable().optional(),
  /// Optional explicit assignee. When set and different from `userId`,
  /// this todo was delegated and appears in the assignee's inbox.
  assigneeId: cuid.nullable().optional(),
  title: z.string(),
  notes: z.string().nullable(),
  dueDate: z.coerce.date().nullable(),
  priority: TodoPriority,
  done: z.boolean(),
  doneAt: z.coerce.date().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Todo = z.infer<typeof todoSchema>;

/**
 * Enriched row used by the cross-workspace todo view. Includes the
 * project + workspace + creator + assignee names so the client can
 * render the badges without N+1 lookups.
 */
export const todoWithRefsSchema = todoSchema.extend({
  workspace: z.object({ id: cuid, name: z.string() }).nullable().optional(),
  project: z
    .object({ id: cuid, name: z.string(), color: z.string().nullable() })
    .nullable()
    .optional(),
  creator: z
    .object({
      id: cuid,
      name: z.string(),
      email: z.string().email(),
      image: z.string().nullable(),
    })
    .nullable()
    .optional(),
  assignee: z
    .object({
      id: cuid,
      name: z.string(),
      email: z.string().email(),
      image: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type TodoWithRefs = z.infer<typeof todoWithRefsSchema>;

export const createTodoSchema = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  dueDate: z.coerce.date().nullable().optional(),
  priority: TodoPriority.optional(),
  /// Optional explicit workspace. Required when the caller wants to
  /// create the todo somewhere other than their current active workspace.
  workspaceId: cuid.optional(),
  /// Optional project inside the targeted workspace.
  projectId: cuid.optional(),
  /// Optional assignee. Must be a member of the targeted workspace.
  /// When omitted, the creator owns the todo themselves.
  assigneeId: cuid.optional(),
});
export type CreateTodoInput = z.infer<typeof createTodoSchema>;

export const updateTodoSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    notes: z.string().max(5000).nullable().optional(),
    dueDate: z.coerce.date().nullable().optional(),
    priority: TodoPriority.optional(),
    done: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    projectId: cuid.nullable().optional(),
    assigneeId: cuid.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;

export const todoDueFilterSchema = z.enum(['overdue', 'today', 'upcoming', 'today_and_no_date']);
export type TodoDueFilter = z.infer<typeof todoDueFilterSchema>;

export const listTodosQuerySchema = z.object({
  done: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  dueDate: todoDueFilterSchema.optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  /// 'org' aggregates across every workspace in the caller's organization.
  /// Omitting it preserves the legacy per-workspace behavior.
  aggregate: z.enum(['org']).optional(),
  /// Narrow to a single workspace.
  workspaceId: cuid.optional(),
  /// Narrow to a single project.
  projectId: cuid.optional(),
});
export type ListTodosQuery = z.infer<typeof listTodosQuerySchema>;
