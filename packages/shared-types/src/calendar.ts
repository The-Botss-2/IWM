import { z } from 'zod';

import { cuid } from './common/id.js';

export const CalendarEventType = z.enum(['task', 'todo', 'time']);
export type CalendarEventType = z.infer<typeof CalendarEventType>;

export const calendarEventSchema = z.object({
  id: z.string(),
  type: CalendarEventType,
  title: z.string(),
  start: z.coerce.date(),
  end: z.coerce.date().nullable(),
  color: z.string().nullable(),
  projectId: cuid.nullable(),
  projectName: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const calendarEventsResponseSchema = z.object({
  items: z.array(calendarEventSchema),
});
export type CalendarEventsResponse = z.infer<typeof calendarEventsResponseSchema>;

export const calendarEventsQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  types: z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    )
    .pipe(z.array(CalendarEventType))
    .optional(),
});
export type CalendarEventsQuery = z.infer<typeof calendarEventsQuerySchema>;
