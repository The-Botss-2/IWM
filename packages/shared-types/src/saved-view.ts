import { z } from 'zod';

import { cuid } from './common/id.js';
import { SavedViewScope, TaskPriority, TaskStatus } from './enums.js';

/**
 * The filter + display config saved with a SavedView. Open-ended so adding a
 * new control later (group-by, density, ...) doesn't require a migration.
 */
export const savedViewConfigSchema = z
  .object({
    viewType: z.enum(['board', 'list', 'calendar', 'timeline', 'backlog']).optional(),
    filter: z
      .object({
        status: z.array(TaskStatus).optional(),
        priority: z.array(TaskPriority).optional(),
        assigneeIds: z.array(cuid).optional(),
        search: z.string().optional(),
      })
      .optional(),
    columns: z.array(z.string()).optional(),
    groupBy: z.enum(['none', 'status', 'assignee', 'priority', 'sprint']).optional(),
  })
  .strict();
export type SavedViewConfig = z.infer<typeof savedViewConfigSchema>;

export const savedViewSchema = z.object({
  id: cuid,
  projectId: cuid.nullable(),
  workspaceId: cuid,
  createdById: cuid,
  name: z.string().min(1).max(80),
  icon: z.string().max(40).nullable(),
  scope: SavedViewScope,
  isShared: z.boolean(),
  config: savedViewConfigSchema,
  position: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type SavedView = z.infer<typeof savedViewSchema>;

export const createSavedViewSchema = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().max(40).optional(),
  scope: SavedViewScope,
  isShared: z.boolean(),
  config: savedViewConfigSchema,
});
export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;

export const updateSavedViewSchema = createSavedViewSchema.partial().extend({
  position: z.number().int().nonnegative().optional(),
});
export type UpdateSavedViewInput = z.infer<typeof updateSavedViewSchema>;
