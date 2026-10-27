import { z } from 'zod';

import { cuid } from './common/id.js';
import { GoalStatus, KeyResultMetric } from './enums.js';
import { userSummarySchema } from './user.js';

export const goalSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  projectId: cuid.nullable(),
  parentGoalId: cuid.nullable(),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).nullable(),
  ownerId: cuid,
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  status: GoalStatus,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Goal = z.infer<typeof goalSchema>;

export const createGoalSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  ownerId: cuid,
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  parentGoalId: cuid.optional(),
});
export type CreateGoalInput = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = createGoalSchema.partial().extend({
  status: GoalStatus.optional(),
});
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

// Decimals come back from the API as strings to preserve precision.
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);

export const keyResultSchema = z.object({
  id: cuid,
  goalId: cuid,
  title: z.string().min(1).max(200),
  metricType: KeyResultMetric,
  targetValue: decimalString,
  currentValue: decimalString,
  unit: z.string().max(20).nullable(),
  position: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type KeyResult = z.infer<typeof keyResultSchema>;

export const createKeyResultSchema = z.object({
  title: z.string().min(1).max(200),
  metricType: KeyResultMetric,
  targetValue: z.union([z.number(), z.string()]),
  currentValue: z.union([z.number(), z.string()]).optional(),
  unit: z.string().max(20).optional(),
});
export type CreateKeyResultInput = z.infer<typeof createKeyResultSchema>;

export const updateKeyResultSchema = createKeyResultSchema.partial();
export type UpdateKeyResultInput = z.infer<typeof updateKeyResultSchema>;

export const goalUpdateSchema = z.object({
  id: cuid,
  goalId: cuid,
  keyResultId: cuid.nullable(),
  authorId: cuid,
  body: z.string().min(1).max(2000),
  valueAt: decimalString.nullable(),
  createdAt: z.coerce.date(),
});
export type GoalUpdate = z.infer<typeof goalUpdateSchema>;

export const createGoalUpdateSchema = z.object({
  body: z.string().min(1).max(2000),
  keyResultId: cuid.optional(),
  valueAt: z.union([z.number(), z.string()]).optional(),
});
export type CreateGoalUpdateInput = z.infer<typeof createGoalUpdateSchema>;

/** Goal joined with its KRs + owner + computed progress for the goals list. */
export const goalWithDetailsSchema = goalSchema.extend({
  owner: userSummarySchema,
  keyResults: z.array(keyResultSchema),
  /** 0..1 - average of each KR's currentValue/targetValue, capped at 1. */
  progress: z.number().min(0).max(1),
});
export type GoalWithDetails = z.infer<typeof goalWithDetailsSchema>;
