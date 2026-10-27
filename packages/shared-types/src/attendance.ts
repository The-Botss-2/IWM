import { z } from 'zod';

import { cuid } from './common/id.js';

export const AttendanceStatus = z.enum(['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY']);
export type AttendanceStatus = z.infer<typeof AttendanceStatus>;

export const attendanceSchema = z.object({
  id: cuid,
  userId: cuid,
  /// UTC midnight for the day this row pertains to.
  date: z.coerce.date(),
  status: AttendanceStatus,
  notes: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Attendance = z.infer<typeof attendanceSchema>;

/** Admin / HR manual override payload. The (userId, date) tuple is the
 *  upsert key on the server side. */
export const overrideAttendanceSchema = z.object({
  userId: cuid,
  date: z.coerce.date(),
  status: AttendanceStatus,
  notes: z.string().max(255).optional(),
});
export type OverrideAttendanceInput = z.infer<typeof overrideAttendanceSchema>;

/** Date-range report query for a single user. */
export const attendanceReportQuerySchema = z
  .object({
    userId: cuid,
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((v) => v.to.getTime() >= v.from.getTime(), {
    path: ['to'],
    message: '`to` must be on or after `from`',
  });
export type AttendanceReportQuery = z.infer<typeof attendanceReportQuerySchema>;

/** Combined per-user attendance + tracked-time summary for the dashboard. */
export const attendanceSummaryResponseSchema = z.object({
  user: z.object({
    id: cuid,
    name: z.string(),
    email: z.string().email(),
    image: z.string().nullable(),
  }),
  range: z.object({ from: z.coerce.date(), to: z.coerce.date() }),
  totalTrackedMinutes: z.number().int().nonnegative(),
  daysPresent: z.number().int().nonnegative(),
  daysAbsent: z.number().int().nonnegative(),
  daysLeave: z.number().int().nonnegative(),
  daysHoliday: z.number().int().nonnegative(),
  /// Per-day breakdown for the heatmap / anomaly highlighter on the
  /// summary dashboard. Sorted ascending by date.
  days: z.array(
    z.object({
      date: z.string(), // ISO YYYY-MM-DD
      status: AttendanceStatus.nullable(), // null = no attendance row recorded yet
      minutes: z.number().int().nonnegative(),
      anomaly: z.enum(['NONE', 'PRESENT_LOW_HOURS', 'ABSENT_HAS_HOURS']),
    }),
  ),
});
export type AttendanceSummaryResponse = z.infer<typeof attendanceSummaryResponseSchema>;

export const attendanceMatrixQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((v) => v.to.getTime() >= v.from.getTime(), {
    path: ['to'],
    message: '`to` must be on or after `from`',
  });
export type AttendanceMatrixQuery = z.infer<typeof attendanceMatrixQuerySchema>;

/** Cross-user attendance grid for the admin matrix page. */
export const attendanceMatrixRowSchema = z.object({
  user: z.object({
    id: cuid,
    name: z.string(),
    email: z.string().email(),
    image: z.string().nullable(),
  }),
  cells: z.array(
    z.object({
      date: z.string(),
      status: AttendanceStatus.nullable(),
    }),
  ),
});
export type AttendanceMatrixRow = z.infer<typeof attendanceMatrixRowSchema>;

export const attendanceMatrixResponseSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  dateRange: z.array(z.string()),
  rows: z.array(attendanceMatrixRowSchema),
});
export type AttendanceMatrixResponse = z.infer<typeof attendanceMatrixResponseSchema>;

/** List of users selectable in the Attendance Summary dashboard. The
 *  admin/HR dropdown needs to see everyone with an active account, not
 *  just members of the current workspace. */
export const attendanceUserSchema = z.object({
  id: cuid,
  name: z.string(),
  email: z.string().email(),
  image: z.string().nullable(),
});
export type AttendanceUser = z.infer<typeof attendanceUserSchema>;

export const attendanceUsersResponseSchema = z.array(attendanceUserSchema);
export type AttendanceUsersResponse = z.infer<typeof attendanceUsersResponseSchema>;
