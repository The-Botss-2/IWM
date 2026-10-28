'use client';

import { useMemo, useState } from 'react';
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  createLeaveSchema,
  type CreateLeaveInput,
  type LeaveListResponse,
  type LeaveStatus,
  type LeaveType,
  type LeaveWithRefs,
  type UpdateLeaveStatusInput,
} from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import type { ComboboxOption } from '@/components/ui/combobox';
import { useAttendanceUsers } from '@/hooks/use-attendance';
import { getApi } from '@/lib/api';
import { leaveDayCount, pickedDayToUtc } from '@/lib/leave';
import { toastError, toastSuccess } from '@/lib/toast';

export interface UseLeavesArgs {
  userId?: string;
  status?: LeaveStatus;
  from?: Date;
  to?: Date;
}

/** The filters a `['leaves', …]` cache entry was fetched with. */
interface LeavesKeyFilters {
  userId: string | null;
  status: LeaveStatus | null;
  from: string | null;
  to: string | null;
}

const leavesKey = (args: UseLeavesArgs) =>
  [
    'leaves',
    {
      userId: args.userId ?? null,
      status: args.status ?? null,
      from: args.from?.toISOString() ?? null,
      to: args.to?.toISOString() ?? null,
    } satisfies LeavesKeyFilters,
  ] as const;

/**
 * Leave requests. The server scopes them: an employee only ever gets their
 * own, whatever `userId` says; HR gets their organization's.
 */
export function useLeaves(args: UseLeavesArgs = {}, opts: { enabled?: boolean } = {}) {
  return useQuery<LeaveListResponse>({
    queryKey: leavesKey(args),
    queryFn: () => getApi().leaves.list(args),
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
  });
}

/** The signed-in person's own requests (the employee "Time off" page). */
export function useMyLeaves() {
  const session = useSessionContext();
  const userId = session.data?.user.id;
  return useLeaves({ userId }, { enabled: Boolean(userId) });
}

// --- cache helpers ----------------------------------------------------------
// Leave lists are patched in place, never refetched by a mutation, like the
// task caches. Each cached list knows its filters from its key, so a row
// lands only in the lists it belongs to.

/** Server order: PENDING, APPROVED, REJECTED, then latest start first. */
const STATUS_ORDER: Record<LeaveStatus, number> = { PENDING: 0, APPROVED: 1, REJECTED: 2 };
function compareLeaves(a: LeaveWithRefs, b: LeaveWithRefs): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
  );
}

function belongsIn(row: LeaveWithRefs, f: LeavesKeyFilters | undefined): boolean {
  if (!f) return true;
  if (f.userId && row.userId !== f.userId) return false;
  if (f.status && row.status !== f.status) return false;
  const start = new Date(row.startDate).getTime();
  if (f.from && start < new Date(f.from).getTime()) return false;
  if (f.to && start > new Date(f.to).getTime()) return false;
  return true;
}

/** Rewrite every cached leave list with `fn(items, filters)`. */
function patchLeaveLists(
  qc: QueryClient,
  fn: (items: LeaveWithRefs[], filters: LeavesKeyFilters | undefined) => LeaveWithRefs[],
): void {
  for (const [key, data] of qc.getQueriesData<LeaveListResponse>({ queryKey: ['leaves'] })) {
    if (!data) continue;
    const filters = key[1] as LeavesKeyFilters | undefined;
    qc.setQueryData<LeaveListResponse>(key, { items: fn(data.items, filters) });
  }
}

/** Where one leave sat in each cached list before an optimistic change. */
type LeaveRowRollback = Array<{ key: readonly unknown[]; row: LeaveWithRefs; index: number }>;

/**
 * Optimistically replace (or, with `null`, remove) one leave in every list
 * that holds it. Returns just that row's previous state per list, so a
 * failed call rolls back its own row and never undoes another decision that
 * finished in the meantime (a whole-list snapshot would).
 */
function patchLeaveRow(
  qc: QueryClient,
  id: string,
  next: (row: LeaveWithRefs, filters: LeavesKeyFilters | undefined) => LeaveWithRefs | null,
): LeaveRowRollback {
  const rollback: LeaveRowRollback = [];
  for (const [key, data] of qc.getQueriesData<LeaveListResponse>({ queryKey: ['leaves'] })) {
    const index = data?.items.findIndex((l) => l.id === id) ?? -1;
    if (!data || index === -1) continue;
    const row = data.items[index]!;
    rollback.push({ key, row, index });
    const replacement = next(row, key[1] as LeavesKeyFilters | undefined);
    const items = [...data.items];
    if (replacement) items[index] = replacement;
    else items.splice(index, 1);
    qc.setQueryData<LeaveListResponse>(key, { items });
  }
  return rollback;
}

/** Put one leave back where it was in each list, leaving every other row alone. */
function rollbackLeaveRow(
  qc: QueryClient,
  id: string,
  rollback: LeaveRowRollback | undefined,
): void {
  for (const { key, row, index } of rollback ?? []) {
    qc.setQueryData<LeaveListResponse>(key, (data) => {
      if (!data) return data;
      const items = data.items.filter((l) => l.id !== id);
      items.splice(Math.min(index, items.length), 0, row);
      return { items };
    });
  }
}

/** Put the server's row into every list it belongs to (and out of the rest). */
function mergeLeave(qc: QueryClient, row: LeaveWithRefs): void {
  patchLeaveLists(qc, (items, filters) => {
    const rest = items.filter((l) => l.id !== row.id);
    return belongsIn(row, filters) ? [...rest, row].sort(compareLeaves) : rest;
  });
}

const STATUS_MUTATION_KEY = ['leaves', 'update-status'] as const;
const DELETE_MUTATION_KEY = ['leaves', 'delete'] as const;

/**
 * The attendance matrix and summaries overlay approved leaves on the fly, so
 * a decision has to refresh them for LEAVE to appear (or go away). Those are
 * read-only grids, so a refetch is safe here.
 */
function refreshAttendance(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['attendance'] });
}

// --- mutations --------------------------------------------------------------

export function useCreateLeave() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't submit leave request" },
    mutationFn: (input: CreateLeaveInput) => getApi().leaves.create(input),
    onSuccess: (row) => {
      mergeLeave(qc, row);
      // HR recording leave for someone is approved straight away.
      if (row.status === 'APPROVED') refreshAttendance(qc);
    },
  });
}

export function useUpdateLeaveStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: STATUS_MUTATION_KEY,
    mutationFn: ({ id, input }: { id: string; input: UpdateLeaveStatusInput }) =>
      getApi().leaves.updateStatus(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: ['leaves'] });
      const rollback = patchLeaveRow(qc, id, (row, filters) => {
        const next = { ...row, status: input.status };
        return belongsIn(next, filters) ? next : null;
      });
      return { rollback };
    },
    onError: (err, { id, input }, ctx) => {
      rollbackLeaveRow(qc, id, ctx?.rollback);
      toastError(
        err,
        input.status === 'APPROVED'
          ? "Couldn't approve leave request"
          : "Couldn't reject leave request",
      );
    },
    onSuccess: (row) => {
      mergeLeave(qc, row);
      refreshAttendance(qc);
      toastSuccess(row.status === 'APPROVED' ? 'Leave approved' : 'Leave rejected');
    },
  });
}

export function useDeleteLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: DELETE_MUTATION_KEY,
    mutationFn: (id: string) => getApi().leaves.remove(id),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ['leaves'] });
      return { rollback: patchLeaveRow(qc, id, () => null) };
    },
    onError: (err, id, ctx) => {
      rollbackLeaveRow(qc, id, ctx?.rollback);
      toastError(err, "Couldn't remove leave request");
    },
    onSuccess: () => refreshAttendance(qc),
  });
}

// --- HR review ----------------------------------------------------------------

export type LeaveStatusFilter = LeaveStatus | 'ALL';

/**
 * Everything the HR "Leave requests" page needs: filters, the filtered list,
 * the people to filter by, and the decide / delete actions. Mount it only for
 * someone holding `hr.leave.approve` (the people list is HR-only).
 */
export function useLeaveReview() {
  const session = useSessionContext();
  const myId = session.data?.user.id ?? null;
  const [status, setStatus] = useState<LeaveStatusFilter>('PENDING');
  const [userId, setUserId] = useState<string | null>(null);
  const leaves = useLeaves({
    status: status === 'ALL' ? undefined : status,
    userId: userId ?? undefined,
  });
  const users = useAttendanceUsers();
  const people = useMemo<ComboboxOption[]>(
    () => (users.data ?? []).map((u) => ({ value: u.id, label: u.name, description: u.email })),
    [users.data],
  );
  const update = useUpdateLeaveStatus();
  const remove = useDeleteLeave();
  // Every leave with a decision or delete in flight, not just the latest call,
  // so a row's buttons stay disabled until its own request settles.
  const deciding = useMutationState({
    filters: { mutationKey: STATUS_MUTATION_KEY, status: 'pending' },
    select: (m) => (m.state.variables as { id: string } | undefined)?.id,
  });
  const deleting = useMutationState({
    filters: { mutationKey: DELETE_MUTATION_KEY, status: 'pending' },
    select: (m) => m.state.variables as string | undefined,
  });
  const busy = new Set([...deciding, ...deleting]);

  return {
    status,
    setStatus,
    userId,
    setUserId,
    leaves,
    people,
    /** Pending, and not your own: the server refuses deciding your own request. */
    canDecide: (leave: LeaveWithRefs) => leave.status === 'PENDING' && leave.userId !== myId,
    isBusy: (leave: LeaveWithRefs) => busy.has(leave.id),
    approve: (leave: LeaveWithRefs) =>
      update.mutate({ id: leave.id, input: { status: 'APPROVED' } }),
    reject: (leave: LeaveWithRefs) =>
      update.mutate({ id: leave.id, input: { status: 'REJECTED' } }),
    remove: (leave: LeaveWithRefs) => remove.mutate(leave.id),
  };
}

// --- request form -----------------------------------------------------------

/** Mirrors `createLeaveSchema.reason`. */
const LEAVE_REASON_MAX = 500;

/**
 * State + validation for the "Request leave" / "Record leave" dialog. The
 * shared `createLeaveSchema` (the one the API applies) decides when Submit is
 * enabled. `forUserId` is set when HR records leave for someone else, which
 * the server approves on creation.
 */
export function useLeaveRequestForm(opts: { onDone: () => void; forSomeone?: boolean }) {
  const create = useCreateLeave();
  const [type, setType] = useState<LeaveType>('ANNUAL');
  const [start, setStart] = useState<Date | null>(null);
  const [end, setEnd] = useState<Date | null>(null);
  const [reason, setReason] = useState('');
  const [forUserId, setForUserId] = useState<string | null>(null);

  const startDay = start ? pickedDayToUtc(start) : null;
  const endDay = end ? pickedDayToUtc(end) : null;
  const parsed = createLeaveSchema.safeParse({
    type,
    startDate: startDay ?? undefined,
    endDate: endDay ?? undefined,
    reason: reason.trim() || undefined,
    userId: forUserId ?? undefined,
  });
  const endBeforeStart =
    startDay !== null && endDay !== null && endDay.getTime() < startDay.getTime();

  function setStartDate(d: Date | null): void {
    setStart(d);
    // Picking a start after the current end moves the end along with it.
    if (d && end && pickedDayToUtc(end).getTime() < pickedDayToUtc(d).getTime()) setEnd(d);
    if (d && !end) setEnd(d);
  }

  function reset(): void {
    setType('ANNUAL');
    setStart(null);
    setEnd(null);
    setReason('');
    setForUserId(null);
    create.reset();
  }

  function submit(): void {
    if (!parsed.success || create.isPending) return;
    create.mutate(parsed.data, {
      onSuccess: (row) => {
        toastSuccess(row.status === 'APPROVED' ? 'Leave recorded' : 'Leave request sent');
        reset();
        opts.onDone();
      },
    });
  }

  return {
    type,
    setType,
    start,
    setStart: setStartDate,
    end,
    setEnd,
    reason,
    setReason,
    forUserId,
    setForUserId,
    endBeforeStart,
    days: startDay && endDay && !endBeforeStart ? leaveDayCount(startDay, endDay) : null,
    reasonMax: LEAVE_REASON_MAX,
    canSubmit: parsed.success && (!opts.forSomeone || forUserId !== null),
    pending: create.isPending,
    submit,
    reset,
  };
}
