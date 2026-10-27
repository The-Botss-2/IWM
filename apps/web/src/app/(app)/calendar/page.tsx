'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';

import { GlobalCalendarView } from '@/components/calendar/global-calendar-view';

function CalendarInner() {
  const params = useSearchParams();
  const dateParam = params.get('date');
  const initialDate = useMemo(() => {
    if (!dateParam) return undefined;
    const d = new Date(dateParam);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }, [dateParam]);
  return (
    <div className="h-[var(--app-content-h,calc(100vh-4rem))]">
      <GlobalCalendarView initialDate={initialDate} />
    </div>
  );
}

export default function CalendarPage() {
  return (
    <Suspense fallback={null}>
      <CalendarInner />
    </Suspense>
  );
}
