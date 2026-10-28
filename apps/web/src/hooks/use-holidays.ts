'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateHolidayInput,
  HolidayListResponse,
  HolidayRevertStatus,
  UpdateHolidayInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast } from '@/lib/toast';

interface ListArgs {
  from?: Date;
  to?: Date;
}

const listKey = (a: ListArgs) =>
  ['holidays', 'list', a.from?.toISOString() ?? null, a.to?.toISOString() ?? null] as const;

/**
 * Read holidays in the actor's organisation. Open to any signed-in
 * user — the attendance grid surfaces holidays for everyone, not just
 * HR / Admin.
 */
export function useHolidays(args: ListArgs = {}) {
  return useQuery<HolidayListResponse>({
    queryKey: listKey(args),
    queryFn: () => getApi().holidays.list(args),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Add a public holiday. Server bulk-stamps every active org member's
 * Attendance row for that date as HOLIDAY (default behaviour) so the
 * matrix updates instantly. Invalidates both the holiday list and the
 * attendance queries so the admin's view re-renders without manual
 * refresh.
 */
export function useCreateHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateHolidayInput) => getApi().holidays.create(input),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['holidays'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
      const total = res.attendanceCreated + res.attendanceUpdated;
      toast.success(
        total > 0
          ? `Holiday added. ${total} attendance row${total === 1 ? '' : 's'} marked as HOLIDAY.`
          : 'Holiday added.',
      );
    },
    meta: { errorTitle: "Couldn't add public holiday" },
  });
}

export function useUpdateHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateHolidayInput }) =>
      getApi().holidays.update(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['holidays'] });
    },
    meta: { successMessage: 'Holiday updated.', errorTitle: "Couldn't update holiday" },
  });
}

export function useDeleteHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().holidays.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['holidays'] });
      // The server reverts the HOLIDAY attendance rows it stamped back to
      // their recomputed status (LEAVE / PRESENT / ABSENT / unmarked) —
      // see HolidaysService.remove — so refresh the matrix + summary too.
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    meta: { successMessage: 'Holiday deleted.', errorTitle: "Couldn't delete holiday" },
  });
}

/**
 * Re-apply an existing holiday's bulk-attendance pass. Used after HR
 * onboards a new user between adding the holiday and the date arriving.
 */
export function useApplyHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().holidays.apply(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['attendance'] });
      const total = res.attendanceCreated + res.attendanceUpdated;
      toast.success(
        total > 0
          ? `Holiday applied again. ${total} attendance row${total === 1 ? '' : 's'} marked.`
          : 'Holiday already applied to every user.',
      );
    },
    meta: { errorTitle: "Couldn't apply holiday again" },
  });
}

/**
 * Unmark a holiday's attendance for its date (revert HOLIDAY rows back to
 * present / absent / leave) while keeping the holiday entry. Inverse of
 * re-apply.
 */
export function useUnmarkHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status?: HolidayRevertStatus }) =>
      getApi().holidays.unmark(id, status),
    onSuccess: (_res, { status }) => {
      qc.invalidateQueries({ queryKey: ['attendance'] });
      toast.success(
        status === 'CLEAR' || !status
          ? 'Attendance unmarked for this date.'
          : `Attendance set to ${status.toLowerCase()} for this date.`,
      );
    },
    meta: { errorTitle: "Couldn't unmark holiday" },
  });
}
