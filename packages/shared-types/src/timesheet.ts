import { z } from 'zod';

import { cuid } from './common/id.js';

export const timeEntrySchema = z.object({
  id: cuid,
  userId: cuid,
  workspaceId: cuid,
  projectId: cuid.nullable(),
  projectLabel: z.string().nullable().optional(),
  taskId: cuid.nullable(),
  taskLabel: z.string().nullable().optional(),
  description: z.string().nullable(),
  startTime: z.coerce.date(),
  endTime: z.coerce.date().nullable(),
  durationMin: z.number().int().nullable(),
  /// Set while an active timer is paused; null when running or stopped.
  pausedAt: z.coerce.date().nullable().optional(),
  /// Cumulative minutes spent in the paused state. Subtracted from gross
  /// minutes on stop to produce `durationMin`. The DB column defaults to
  /// 0, so legacy rows that pre-date the pause feature also satisfy this.
  accumulatedPauseMin: z.number().int().nonnegative(),
  billable: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type TimeEntry = z.infer<typeof timeEntrySchema>;

/** Endpoint payloads for pause/resume - accept the cuid id only; the
 *  caller's session identifies the user. */
export const pauseTimerSchema = z.object({ id: cuid });
export type PauseTimerInput = z.infer<typeof pauseTimerSchema>;

export const resumeTimerSchema = z.object({ id: cuid });
export type ResumeTimerInput = z.infer<typeof resumeTimerSchema>;

/** YYYY-MM month string used by the admin CSV export query. */
export const exportTimesheetQuerySchema = z.object({
  userId: cuid,
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Must be in YYYY-MM format'),
});
export type ExportTimesheetQuery = z.infer<typeof exportTimesheetQuerySchema>;

export const timeEntryWithMetaSchema = timeEntrySchema.extend({
  project: z
    .object({
      id: cuid,
      name: z.string(),
      color: z.string().nullable(),
    })
    .nullable(),
  task: z
    .object({
      id: cuid,
      title: z.string(),
    })
    .nullable(),
  user: z
    .object({
      id: cuid,
      name: z.string(),
      email: z.string().email(),
      image: z.string().nullable(),
    })
    .nullable(),
});
export type TimeEntryWithMeta = z.infer<typeof timeEntryWithMetaSchema>;

export const startTimerSchema = z.object({
  projectId: cuid.optional(),
  /// Manual project label used when no `projectId` is provided - e.g. a
  /// brand-new user with no Project rows yet. Trimmed; empty strings drop.
  projectLabel: z.string().max(120).optional(),
  taskId: cuid.optional(),
  /// Manual task label used when no `taskId` is provided - pairs with
  /// `projectLabel` so users can describe work that doesn't exist as a
  /// Task row yet.
  taskLabel: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  billable: z.boolean().optional(),
});
export type StartTimerInput = z.infer<typeof startTimerSchema>;

export const createTimeEntrySchema = z
  .object({
    projectId: cuid.optional(),
    projectLabel: z.string().max(120).optional(),
    taskId: cuid.optional(),
    taskLabel: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    billable: z.boolean().optional(),
  })
  .refine((v) => v.endTime.getTime() > v.startTime.getTime(), {
    path: ['endTime'],
    message: 'End time must be after start time',
  });
export type CreateTimeEntryInput = z.infer<typeof createTimeEntrySchema>;

export const updateTimeEntrySchema = z
  .object({
    projectId: cuid.nullable().optional(),
    projectLabel: z.string().max(120).nullable().optional(),
    taskId: cuid.nullable().optional(),
    taskLabel: z.string().max(200).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    startTime: z.coerce.date().optional(),
    endTime: z.coerce.date().nullable().optional(),
    billable: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateTimeEntryInput = z.infer<typeof updateTimeEntrySchema>;

export const listTimesheetsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  projectId: cuid.optional(),
  userId: cuid.optional(),
  running: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListTimesheetsQuery = z.infer<typeof listTimesheetsQuerySchema>;

export const timesheetSummaryQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  userId: cuid.optional(),
});
export type TimesheetSummaryQuery = z.infer<typeof timesheetSummaryQuerySchema>;

export const timesheetSummaryRowSchema = z.object({
  projectId: cuid.nullable(),
  projectName: z.string().nullable(),
  projectColor: z.string().nullable(),
  totalMinutes: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
});
export type TimesheetSummaryRow = z.infer<typeof timesheetSummaryRowSchema>;

export const timesheetSummaryResponseSchema = z.object({
  totalMinutes: z.number().int().nonnegative(),
  byProject: z.array(timesheetSummaryRowSchema),
});
export type TimesheetSummaryResponse = z.infer<typeof timesheetSummaryResponseSchema>;

export const timesheetListResponseSchema = z.object({
  items: z.array(timeEntryWithMetaSchema),
});
export type TimesheetListResponse = z.infer<typeof timesheetListResponseSchema>;

// ============================================================================
// Admin (system-admin only) - cross-workspace, cross-user views
// ============================================================================

export const adminTimesheetsListQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  userId: cuid.optional(),
  workspaceId: cuid.optional(),
});
export type AdminTimesheetsListQuery = z.infer<typeof adminTimesheetsListQuerySchema>;

export const adminAttendanceQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});
export type AdminAttendanceQuery = z.infer<typeof adminAttendanceQuerySchema>;

export const adminAttendanceDayCellSchema = z.object({
  date: z.string(), // ISO yyyy-mm-dd
  totalMinutes: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
});
export type AdminAttendanceDayCell = z.infer<typeof adminAttendanceDayCellSchema>;

export const adminAttendanceRowSchema = z.object({
  user: z.object({
    id: cuid,
    name: z.string(),
    email: z.string().email(),
    image: z.string().nullable(),
  }),
  totalMinutes: z.number().int().nonnegative(),
  days: z.array(adminAttendanceDayCellSchema),
});
export type AdminAttendanceRow = z.infer<typeof adminAttendanceRowSchema>;

export const adminAttendanceResponseSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  /// Date strings (yyyy-mm-dd) inclusive between `from` and `to` - pre-computed
  /// server-side so the client doesn't have to reconstruct timezone-correct
  /// day boundaries.
  dateRange: z.array(z.string()),
  rows: z.array(adminAttendanceRowSchema),
});
export type AdminAttendanceResponse = z.infer<typeof adminAttendanceResponseSchema>;
