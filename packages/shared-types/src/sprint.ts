import { z } from 'zod';

import { cuid } from './common/id.js';
import { SprintStatus } from './enums.js';

export const sprintSchema = z.object({
  id: cuid,
  projectId: cuid,
  name: z.string().min(1).max(120),
  goal: z.string().max(500).nullable(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  status: SprintStatus,
  position: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Sprint = z.infer<typeof sprintSchema>;

const sprintFieldsSchema = z.object({
  name: z.string().min(1).max(120),
  goal: z.string().max(500).optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

/** A sprint may be a single day; it may not end before it starts. */
export const SPRINT_DATES_MESSAGE = "The end date can't be before the start date.";
const datesInOrder = (v: { startDate?: Date | undefined; endDate?: Date | undefined }): boolean =>
  !v.startDate || !v.endDate || v.endDate.getTime() >= v.startDate.getTime();

export const createSprintSchema = sprintFieldsSchema.refine(datesInOrder, {
  message: SPRINT_DATES_MESSAGE,
  path: ['endDate'],
});
export type CreateSprintInput = z.infer<typeof createSprintSchema>;

/**
 * Partial edit. `goal: null` clears it. When only one date is sent the
 * service checks it against the stored other one.
 */
export const updateSprintSchema = sprintFieldsSchema
  .partial()
  .extend({ goal: z.string().max(500).nullable().optional() })
  .refine(datesInOrder, { message: SPRINT_DATES_MESSAGE, path: ['endDate'] });
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;

export const sprintTaskSchema = z.object({
  id: cuid,
  sprintId: cuid,
  taskId: cuid,
  position: z.number().int().nonnegative(),
  addedAt: z.coerce.date(),
  addedById: cuid,
});
export type SprintTask = z.infer<typeof sprintTaskSchema>;

export const addSprintTaskSchema = z.object({
  sprintId: cuid,
  taskId: cuid,
});
export type AddSprintTaskInput = z.infer<typeof addSprintTaskSchema>;

/** Reorder a task within a sprint (drag inside a sprint card). */
export const reorderSprintTaskSchema = z.object({
  taskId: cuid,
  position: z.number().int().nonnegative(),
});
export type ReorderSprintTaskInput = z.infer<typeof reorderSprintTaskSchema>;

/** Move a task from one sprint to another (drag between sprint cards). */
export const moveSprintTaskSchema = z.object({
  taskId: cuid,
  fromSprintId: cuid,
  toSprintId: cuid,
  position: z.number().int().nonnegative().optional(),
});
export type MoveSprintTaskInput = z.infer<typeof moveSprintTaskSchema>;

/** Sprint plus a count + total estimate of its tasks (for the backlog UI). */
export const sprintWithStatsSchema = sprintSchema.extend({
  taskCount: z.number().int().nonnegative(),
  totalEstimateHours: z.number().nonnegative(),
  /** Member task ids in SprintTask.position order - drives Backlog DnD. */
  taskIds: z.array(cuid),
});
export type SprintWithStats = z.infer<typeof sprintWithStatsSchema>;
