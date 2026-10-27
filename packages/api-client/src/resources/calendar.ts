import {
  type CalendarEventType,
  type CalendarEventsResponse,
  calendarEventsResponseSchema,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

export interface CalendarEventsArgs {
  from: Date;
  to: Date;
  types?: CalendarEventType[];
}

export class CalendarResource {
  constructor(private readonly http: HttpClient) {}

  events(args: CalendarEventsArgs): Promise<CalendarEventsResponse> {
    const query: Record<string, unknown> = {
      from: args.from.toISOString(),
      to: args.to.toISOString(),
    };
    if (args.types && args.types.length > 0) query.types = args.types.join(',');
    return this.http.get('/calendar/events', calendarEventsResponseSchema, query);
  }
}
