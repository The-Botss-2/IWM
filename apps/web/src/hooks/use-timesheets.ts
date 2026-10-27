'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  CreateTimeEntryInput,
  StartTimerInput,
  UpdateTimeEntryInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';

export interface UseTimesheetsArgs {
  from?: Date;
  to?: Date;
  projectId?: string;
  userId?: string;
  running?: boolean;
}

const timesheetsKey = (args: UseTimesheetsArgs) => [
  'timesheets',
  'list',
  {
    ...args,
    from: args.from?.toISOString() ?? null,
    to: args.to?.toISOString() ?? null,
  },
] as const;

export function useTimesheets(args: UseTimesheetsArgs = {}) {
  return useQuery({
    queryKey: timesheetsKey(args),
    queryFn: () => getApi().timesheets.list(args),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

export function useTimesheetSummary(args: { from: Date; to: Date; userId?: string }) {
  return useQuery({
    queryKey: [
      'timesheets',
      'summary',
      { from: args.from.toISOString(), to: args.to.toISOString(), userId: args.userId ?? null },
    ] as const,
    queryFn: () => getApi().timesheets.summary(args),
    staleTime: 30_000,
  });
}

export function useStartTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartTimerInput) => getApi().timesheets.start(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timesheets'] });
    },
    meta: { errorTitle: "Couldn't start timer" },
  });
}

export function useStopTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().timesheets.stop(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timesheets'] });
    },
    meta: { errorTitle: "Couldn't stop timer" },
  });
}

/** Pause an active timer. Server stamps `pausedAt`; subsequent reads
 *  reflect the paused state and the widget swaps Pause → Resume. */
export function usePauseTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().timesheets.pause(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timesheets'] });
    },
    meta: { errorTitle: "Couldn't pause timer" },
  });
}

/** Resume a paused timer. Server folds the elapsed pause window into
 *  `accumulatedPauseMin` and clears `pausedAt`. */
export function useResumeTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().timesheets.resume(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timesheets'] });
    },
    meta: { errorTitle: "Couldn't resume timer" },
  });
}

export function useCreateTimeEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTimeEntryInput) => getApi().timesheets.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timesheets'] });
    },
    meta: { errorTitle: "Couldn't save entry" },
  });
}

export function useUpdateTimeEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTimeEntryInput }) =>
      getApi().timesheets.update(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timesheets'] });
    },
    meta: { errorTitle: "Couldn't save entry" },
  });
}

export function useDeleteTimeEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().timesheets.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timesheets'] });
    },
    meta: { successMessage: 'Entry deleted.', errorTitle: "Couldn't delete entry" },
  });
}

// ---- Picker options for the time-entry dialogs ---------------------------

const EMPTY: never[] = [];

/** Projects offered by the timer / time-entry project picker. */
export function useTimesheetProjectOptions() {
  const q = useQuery({
    queryKey: ['projects', 'lite'],
    queryFn: () => getApi().projects.list({ pageSize: 200 }),
    staleTime: 5 * 60_000,
  });
  return q.data?.items ?? EMPTY;
}

/** Tasks offered by the timer / time-entry task picker (id, title, project). */
export function useTimesheetTaskOptions() {
  const q = useQuery({
    queryKey: ['tasks', 'lite'],
    queryFn: () => getApi().tasks.list({ pageSize: 500 }),
    staleTime: 60_000,
  });
  return useMemo(
    () =>
      q.data?.items?.map((t) => ({
        id: t.id,
        title: t.title,
        projectId: t.projectId,
      })) ?? [],
    [q.data],
  );
}
