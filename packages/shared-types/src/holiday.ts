import { z } from 'zod';

import { cuid } from './common/id.js';

/**
 * Org-scoped public holiday. Distinct from `Leave` (personal time off
 * from a balance) — a Holiday applies to every member of the org and
 * the daily attendance cron stamps each member's `Attendance.status`
 * as `HOLIDAY` for that day automatically.
 */
export const holidaySchema = z.object({
  id: cuid,
  organizationId: cuid,
  /** UTC midnight of the holiday date. */
  date: z.coerce.date(),
  name: z.string().min(1).max(120),
  notes: z.string().max(255).nullable(),
  createdAt: z.coerce.date(),
  createdById: cuid,
});
export type Holiday = z.infer<typeof holidaySchema>;

/**
 * Create-holiday payload. The actor's organisation is read from the
 * session on the server — clients don't pass it explicitly.
 */
export const createHolidaySchema = z.object({
  date: z.coerce.date(),
  name: z.string().min(1).max(120),
  notes: z.string().max(255).optional(),
  /**
   * If true the server also retroactively stamps every existing user
   * in the org's Attendance row for that date as `HOLIDAY`. Useful when
   * HR adds a holiday after the cron has already run for the day; the
   * default is true so the UI's "Add holiday" affordance Just Works.
   */
  applyToAttendance: z.boolean().default(true),
});
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;

/**
 * What to set a holiday's HOLIDAY-stamped attendance rows to when unmarking.
 * `CLEAR` removes the rows entirely (the day becomes unmarked for everyone);
 * the others force every affected row to that single status. Omitting the
 * field falls back to per-user recomputation (leave/present/absent).
 */
export const holidayRevertStatusSchema = z.enum([
  'CLEAR',
  'PRESENT',
  'ABSENT',
  'LEAVE',
]);
export type HolidayRevertStatus = z.infer<typeof holidayRevertStatusSchema>;

/**
 * Body for `POST /holidays/:id/unmark`. HR picks what to do with the
 * holiday's attendance rows; when `status` is omitted the server recomputes
 * each user's natural status (the legacy behaviour).
 */
export const unmarkHolidaySchema = z.object({
  status: holidayRevertStatusSchema.optional(),
});
export type UnmarkHolidayInput = z.infer<typeof unmarkHolidaySchema>;

/** Update payload — name + notes only. The date is immutable. */
export const updateHolidaySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  notes: z.string().max(255).nullable().optional(),
});
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;

/** List-query: optional date-range filter for the admin calendar view. */
export const listHolidaysQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine(
    (v) => !v.from || !v.to || v.to.getTime() >= v.from.getTime(),
    { path: ['to'], message: '`to` must be on or after `from`' },
  );
export type ListHolidaysQuery = z.infer<typeof listHolidaysQuerySchema>;

export const holidayListResponseSchema = z.object({
  items: z.array(holidaySchema),
});
export type HolidayListResponse = z.infer<typeof holidayListResponseSchema>;

/**
 * Response shape for `POST /holidays` (and `POST /holidays/:id/apply`).
 * Reports how many Attendance rows were created or overwritten by the
 * retroactive apply pass so the admin gets an accurate toast.
 */
export const applyHolidayResponseSchema = z.object({
  holiday: holidaySchema,
  attendanceCreated: z.number().int().nonnegative(),
  attendanceUpdated: z.number().int().nonnegative(),
});
export type ApplyHolidayResponse = z.infer<typeof applyHolidayResponseSchema>;
