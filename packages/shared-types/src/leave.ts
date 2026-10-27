import { z } from 'zod';

import { cuid } from './common/id.js';

/** Mirrors Prisma's `LeaveType` enum verbatim. Order is significant -
 *  appended only, never reordered, to match historic DB values. */
export const LeaveType = z.enum(['SICK', 'CASUAL', 'ANNUAL', 'UNPAID']);
export type LeaveType = z.infer<typeof LeaveType>;

export const LeaveStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export type LeaveStatus = z.infer<typeof LeaveStatus>;

export const leaveSchema = z.object({
  id: cuid,
  userId: cuid,
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  type: LeaveType,
  status: LeaveStatus,
  reason: z.string().nullable(),
  approvedById: cuid.nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Leave = z.infer<typeof leaveSchema>;

export const leaveWithRefsSchema = leaveSchema.extend({
  user: z.object({
    id: cuid,
    name: z.string(),
    email: z.string().email(),
    image: z.string().nullable(),
  }),
  approvedBy: z
    .object({
      id: cuid,
      name: z.string(),
      email: z.string().email(),
    })
    .nullable(),
});
export type LeaveWithRefs = z.infer<typeof leaveWithRefsSchema>;

export const createLeaveSchema = z
  .object({
    /// Employees omit `userId` - server uses the caller. HR / admin can
    /// pass any user id to create a request on someone else's behalf.
    userId: cuid.optional(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    type: LeaveType,
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.endDate.getTime() >= v.startDate.getTime(), {
    path: ['endDate'],
    message: 'End date must be on or after start date',
  });
export type CreateLeaveInput = z.infer<typeof createLeaveSchema>;

export const updateLeaveStatusSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
});
export type UpdateLeaveStatusInput = z.infer<typeof updateLeaveStatusSchema>;

export const listLeavesQuerySchema = z.object({
  userId: cuid.optional(),
  status: LeaveStatus.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListLeavesQuery = z.infer<typeof listLeavesQuerySchema>;

export const leaveListResponseSchema = z.object({
  items: z.array(leaveWithRefsSchema),
});
export type LeaveListResponse = z.infer<typeof leaveListResponseSchema>;
