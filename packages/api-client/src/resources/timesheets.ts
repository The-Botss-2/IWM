import { z } from 'zod';
import {
  type AdminAttendanceResponse,
  adminAttendanceResponseSchema,
  type CreateTimeEntryInput,
  type StartTimerInput,
  type TimeEntryWithMeta,
  timeEntryWithMetaSchema,
  type TimesheetListResponse,
  timesheetListResponseSchema,
  type TimesheetSummaryResponse,
  timesheetSummaryResponseSchema,
  type UpdateTimeEntryInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.literal(true) });

export interface ListTimesheetsArgs {
  from?: Date;
  to?: Date;
  projectId?: string;
  userId?: string;
  running?: boolean;
}

export interface TimesheetSummaryArgs {
  from: Date;
  to: Date;
  userId?: string;
}

export class TimesheetsResource {
  constructor(private readonly http: HttpClient) {}

  list(args: ListTimesheetsArgs = {}): Promise<TimesheetListResponse> {
    const query: Record<string, unknown> = {};
    if (args.from) query.from = args.from.toISOString();
    if (args.to) query.to = args.to.toISOString();
    if (args.projectId) query.projectId = args.projectId;
    if (args.userId) query.userId = args.userId;
    if (args.running !== undefined) query.running = String(args.running);
    return this.http.get('/timesheets', timesheetListResponseSchema, query);
  }

  summary(args: TimesheetSummaryArgs): Promise<TimesheetSummaryResponse> {
    return this.http.get('/timesheets/summary', timesheetSummaryResponseSchema, {
      from: args.from.toISOString(),
      to: args.to.toISOString(),
      ...(args.userId ? { userId: args.userId } : {}),
    });
  }

  start(input: StartTimerInput): Promise<TimeEntryWithMeta> {
    return this.http.post('/timesheets/start', timeEntryWithMetaSchema, input);
  }

  stop(id: string): Promise<TimeEntryWithMeta> {
    return this.http.post(`/timesheets/stop/${id}`, timeEntryWithMetaSchema, {});
  }

  /** Mark a running timer as paused. Server stamps `pausedAt`. */
  pause(id: string): Promise<TimeEntryWithMeta> {
    return this.http.post(`/timesheets/pause/${id}`, timeEntryWithMetaSchema, {});
  }

  /** Resume a paused timer. Folds elapsed pause into the accumulator. */
  resume(id: string): Promise<TimeEntryWithMeta> {
    return this.http.post(`/timesheets/resume/${id}`, timeEntryWithMetaSchema, {});
  }

  create(input: CreateTimeEntryInput): Promise<TimeEntryWithMeta> {
    return this.http.post('/timesheets', timeEntryWithMetaSchema, {
      ...input,
      startTime: input.startTime.toISOString(),
      endTime: input.endTime.toISOString(),
    });
  }

  update(id: string, input: UpdateTimeEntryInput): Promise<TimeEntryWithMeta> {
    const body: Record<string, unknown> = { ...input };
    if (input.startTime instanceof Date) body.startTime = input.startTime.toISOString();
    if (input.endTime instanceof Date) body.endTime = input.endTime.toISOString();
    return this.http.patch(`/timesheets/${id}`, timeEntryWithMetaSchema, body);
  }

  remove(id: string) {
    return this.http.delete(`/timesheets/${id}`, okSchema);
  }

  adminList(args: AdminListTimesheetsArgs = {}): Promise<TimesheetListResponse> {
    const query: Record<string, unknown> = {};
    if (args.from) query.from = args.from.toISOString();
    if (args.to) query.to = args.to.toISOString();
    if (args.userId) query.userId = args.userId;
    if (args.workspaceId) query.workspaceId = args.workspaceId;
    return this.http.get('/timesheets/admin/list', timesheetListResponseSchema, query);
  }

  adminAttendance(args: AdminAttendanceArgs): Promise<AdminAttendanceResponse> {
    return this.http.get('/timesheets/admin/attendance', adminAttendanceResponseSchema, {
      from: args.from.toISOString(),
      to: args.to.toISOString(),
    });
  }
}

export interface AdminListTimesheetsArgs {
  from?: Date;
  to?: Date;
  userId?: string;
  workspaceId?: string;
}

export interface AdminAttendanceArgs {
  from: Date;
  to: Date;
}
