import { z } from 'zod';
import {
  type ApplyHolidayResponse,
  applyHolidayResponseSchema,
  type CreateHolidayInput,
  type HolidayListResponse,
  holidayListResponseSchema,
  type HolidayRevertStatus,
  holidaySchema,
  type UpdateHolidayInput,
  type Holiday,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.literal(true) });

export interface ListHolidaysArgs {
  from?: Date;
  to?: Date;
}

export class HolidaysResource {
  constructor(private readonly http: HttpClient) {}

  list(args: ListHolidaysArgs = {}): Promise<HolidayListResponse> {
    return this.http.get('/holidays', holidayListResponseSchema, {
      ...(args.from ? { from: args.from.toISOString() } : {}),
      ...(args.to ? { to: args.to.toISOString() } : {}),
    });
  }

  create(input: CreateHolidayInput): Promise<ApplyHolidayResponse> {
    return this.http.post('/holidays', applyHolidayResponseSchema, {
      ...input,
      date: input.date.toISOString(),
    });
  }

  update(id: string, input: UpdateHolidayInput): Promise<Holiday> {
    return this.http.patch(`/holidays/${id}`, holidaySchema, input);
  }

  remove(id: string) {
    return this.http.delete(`/holidays/${id}`, okSchema);
  }

  apply(id: string): Promise<ApplyHolidayResponse> {
    return this.http.post(`/holidays/${id}/apply`, applyHolidayResponseSchema, {});
  }

  unmark(id: string, status?: HolidayRevertStatus) {
    return this.http.post(`/holidays/${id}/unmark`, okSchema, status ? { status } : {});
  }
}
