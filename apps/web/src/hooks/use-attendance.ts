'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AttendanceMatrixResponse,
  AttendanceSummaryResponse,
  AttendanceUsersResponse,
  OverrideAttendanceInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';

interface MatrixArgs {
  from: Date;
  to: Date;
}
interface SummaryArgs {
  userId: string;
  from: Date;
  to: Date;
}

const matrixKey = (a: MatrixArgs) =>
  ['attendance', 'matrix', a.from.toISOString(), a.to.toISOString()] as const;

const summaryKey = (a: SummaryArgs) =>
  ['attendance', 'summary', a.userId, a.from.toISOString(), a.to.toISOString()] as const;

export function useAttendanceMatrix(args: MatrixArgs) {
  return useQuery<AttendanceMatrixResponse>({
    queryKey: matrixKey(args),
    queryFn: () => getApi().attendance.matrix(args),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useAttendanceSummary(args: SummaryArgs) {
  return useQuery<AttendanceSummaryResponse>({
    queryKey: summaryKey(args),
    queryFn: () => getApi().attendance.summary(args),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useAttendanceUsers() {
  return useQuery<AttendanceUsersResponse>({
    queryKey: ['attendance', 'users'] as const,
    queryFn: () => getApi().attendance.listUsers(),
    staleTime: 5 * 60_000,
  });
}

export function useOverrideAttendance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OverrideAttendanceInput) => getApi().attendance.override(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    meta: { errorTitle: "Couldn't update attendance" },
  });
}
