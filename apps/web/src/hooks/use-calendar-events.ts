'use client';

import { useQuery } from '@tanstack/react-query';
import type { CalendarEventType } from '@botss/shared-types';

import { getApi } from '@/lib/api';

export interface UseCalendarEventsArgs {
  from: Date;
  to: Date;
  types?: CalendarEventType[];
}

export function useCalendarEvents(args: UseCalendarEventsArgs) {
  return useQuery({
    queryKey: [
      'calendar',
      'events',
      {
        from: args.from.toISOString(),
        to: args.to.toISOString(),
        types: args.types ?? null,
      },
    ] as const,
    queryFn: () => getApi().calendar.events(args),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
