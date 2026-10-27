import { z } from 'zod';
import {
  type CreateLeaveInput,
  type LeaveListResponse,
  leaveListResponseSchema,
  type LeaveStatus,
  type LeaveWithRefs,
  leaveWithRefsSchema,
  type UpdateLeaveStatusInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.literal(true) });

export interface ListLeavesArgs {
  userId?: string;
  status?: LeaveStatus;
  from?: Date;
  to?: Date;
}

export class LeavesResource {
  constructor(private readonly http: HttpClient) {}

  list(args: ListLeavesArgs = {}): Promise<LeaveListResponse> {
    const q: Record<string, unknown> = {};
    if (args.userId) q.userId = args.userId;
    if (args.status) q.status = args.status;
    if (args.from) q.from = args.from.toISOString();
    if (args.to) q.to = args.to.toISOString();
    return this.http.get('/leaves', leaveListResponseSchema, q);
  }

  create(input: CreateLeaveInput): Promise<LeaveWithRefs> {
    return this.http.post('/leaves', leaveWithRefsSchema, {
      ...input,
      startDate: input.startDate.toISOString(),
      endDate: input.endDate.toISOString(),
    });
  }

  updateStatus(id: string, input: UpdateLeaveStatusInput): Promise<LeaveWithRefs> {
    return this.http.patch(`/leaves/${id}/status`, leaveWithRefsSchema, input);
  }

  remove(id: string) {
    return this.http.delete(`/leaves/${id}`, okSchema);
  }
}
