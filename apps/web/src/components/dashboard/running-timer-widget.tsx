'use client';

import { Pause, Play, Square } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useAppActivity } from '@/hooks/use-app-activity';
import {
  usePauseTimer,
  useResumeTimer,
  useStopTimer,
  useTimesheets,
} from '@/hooks/use-timesheets';
import { cn } from '@/lib/utils';

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Live elapsed for the running timer. We compute it client-side so the
 * number ticks every second without re-fetching. Net minutes = gross
 * (now - start) minus the server-acknowledged `accumulatedPauseMin`,
 * plus the currently-open pause window when the entry is paused. Two
 * sources of truth could drift slightly; the next refetch reconciles
 * via the mutation `onSuccess` hooks.
 */
function elapsedNetMinutes(
  startTime: Date,
  accumulatedPauseMin: number,
  pausedAt: Date | null | undefined,
  now: number,
): number {
  const gross = Math.max(0, Math.floor((now - startTime.getTime()) / 60_000));
  const openPause = pausedAt
    ? Math.max(0, Math.floor((now - pausedAt.getTime()) / 60_000))
    : 0;
  return Math.max(0, gross - accumulatedPauseMin - openPause);
}

export function RunningTimerWidget() {
  const { data, isLoading, isError, refetch } = useTimesheets({ running: true });
  const stop = useStopTimer();
  const pause = usePauseTimer();
  const resume = useResumeTimer();
  const entry = data?.items[0] ?? null;

  const activity = useAppActivity();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // No point ticking the clock for a hidden window (tray / backgrounded) -
    // resync once on return. Visible+idle still ticks so the number stays live.
    if (!entry || activity === 'hidden') return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [entry, activity]);

  const isPaused = !!entry?.pausedAt;
  const elapsed = useMemo(() => {
    if (!entry) return 0;
    return elapsedNetMinutes(
      new Date(entry.startTime),
      entry.accumulatedPauseMin,
      entry.pausedAt ? new Date(entry.pausedAt) : null,
      now,
    );
  }, [entry, now]);

  return (
    <WidgetShell
      id="widget-running-timer"
      title="Running Timer"
      icon={Play}
      linkHref="/timesheets"
    >
      {isLoading ? (
        <div className="flex justify-center">
          <Loader size="sm" label="Loading" />
        </div>
      ) : isError ? (
        <QueryError compact onRetry={() => void refetch()} />
      ) : !entry ? (
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <WidgetEmpty icon={Play} message="No timer running." />
          <Button asChild size="sm" variant="secondary">
            <Link href="/timesheets">Start a timer</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-sm font-medium text-ink">
            {entry.task?.title ||
              entry.project?.name ||
              entry.description ||
              'Tracked time'}
          </div>
          <div
            className={cn(
              'text-2xl font-semibold transition-opacity',
              isPaused ? 'text-ink-muted animate-pulse' : 'text-brand-teal',
            )}
          >
            {fmt(elapsed)}
            {isPaused ? (
              <span className="ml-2 align-middle text-[10px] uppercase tracking-wide text-brand-orange">
                Paused
              </span>
            ) : null}
          </div>
          {entry.project ? (
            <div className="inline-flex items-center gap-1 text-xs text-ink-muted">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: entry.project.color ?? '#94a3b8' }}
                aria-hidden
              />
              {entry.project.name}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            {isPaused ? (
              <Button
                size="sm"
                onClick={() => resume.mutate(entry.id)}
                disabled={resume.isPending}
                className="bg-brand-gradient"
              >
                <Play className="h-3.5 w-3.5" />
                Resume
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => pause.mutate(entry.id)}
                disabled={pause.isPending}
              >
                <Pause className="h-3.5 w-3.5" />
                Pause
              </Button>
            )}
            <Button
              id="widget-stop-timer"
              size="sm"
              onClick={() => stop.mutate(entry.id)}
              disabled={stop.isPending}
              className="bg-state-error hover:bg-state-error"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </Button>
          </div>
        </div>
      )}
    </WidgetShell>
  );
}
