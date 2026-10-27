import { z } from 'zod';
import {
  type AttendanceMatrixResponse,
  attendanceMatrixResponseSchema,
  type AttendanceSummaryResponse,
  attendanceSummaryResponseSchema,
  type AttendanceUsersResponse,
  attendanceUsersResponseSchema,
  type OverrideAttendanceInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.literal(true) });

export interface AttendanceSummaryArgs {
  userId: string;
  from: Date;
  to: Date;
}

export interface AttendanceMatrixArgs {
  from: Date;
  to: Date;
}

export class AttendanceResource {
  constructor(private readonly http: HttpClient) {}

  summary(args: AttendanceSummaryArgs): Promise<AttendanceSummaryResponse> {
    return this.http.get('/attendance/summary', attendanceSummaryResponseSchema, {
      userId: args.userId,
      from: args.from.toISOString(),
      to: args.to.toISOString(),
    });
  }

  matrix(args: AttendanceMatrixArgs): Promise<AttendanceMatrixResponse> {
    return this.http.get('/attendance/matrix', attendanceMatrixResponseSchema, {
      from: args.from.toISOString(),
      to: args.to.toISOString(),
    });
  }

  override(input: OverrideAttendanceInput) {
    return this.http.post('/attendance/override', okSchema, {
      ...input,
      date: input.date.toISOString(),
    });
  }

  listUsers(): Promise<AttendanceUsersResponse> {
    return this.http.get('/attendance/users', attendanceUsersResponseSchema);
  }

  /**
   * Build the URL for the monthly CSV export. Callers hand this to a
   * plain `<a download>` so the browser handles the file save - no
   * point routing the stream through `http.get`.
   */
  exportMonthlyUrl(userId: string, month: string): string {
    const params = new URLSearchParams({ userId, month });
    return `/admin/timesheets/export?${params.toString()}`;
  }
}
