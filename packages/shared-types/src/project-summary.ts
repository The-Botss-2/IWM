import { z } from 'zod';

import { cuid } from './common/id.js';
import { TaskPriority, TaskStatus } from './enums.js';
import { userSummarySchema } from './user.js';

/** Aggregated dashboard payload returned by GET /projects/:id/summary. */
export const projectSummarySchema = z.object({
  totals: z.object({
    tasks: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
  }),
  byStatus: z.array(
    z.object({
      status: TaskStatus,
      count: z.number().int().nonnegative(),
    }),
  ),
  byAssignee: z.array(
    z.object({
      user: userSummarySchema.nullable(),
      count: z.number().int().nonnegative(),
    }),
  ),
  byPriority: z.array(
    z.object({
      priority: TaskPriority,
      count: z.number().int().nonnegative(),
    }),
  ),
  upcomingDeadline: z
    .object({
      taskId: cuid,
      title: z.string(),
      dueDate: z.coerce.date(),
    })
    .nullable(),
  activeSprint: z
    .object({
      id: cuid,
      name: z.string(),
      endDate: z.coerce.date(),
      taskCount: z.number().int().nonnegative(),
    })
    .nullable(),
  recentActivity: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['task_created', 'task_completed', 'sprint_started', 'goal_updated']),
      title: z.string(),
      at: z.coerce.date(),
    }),
  ),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
