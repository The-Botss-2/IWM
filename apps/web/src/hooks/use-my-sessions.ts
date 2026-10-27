'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getApi } from '@/lib/api';
import { toast } from '@/lib/toast';

const KEY = ['users', 'me', 'sessions'] as const;

/** The caller's own signed-in devices. */
export function useMySessions() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => getApi().users.mySessions(),
    staleTime: 15_000,
  });
}

export function useRevokeMySession() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't sign out that device" },
    mutationFn: (id: string) => getApi().users.revokeMySession(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success('Device signed out.');
    },
  });
}

export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't sign out other devices" },
    mutationFn: () => getApi().users.revokeOtherSessions(),
    onSuccess: ({ revoked }) => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success(
        revoked === 0
          ? 'No other devices were signed in.'
          : `Signed out of ${revoked} other ${revoked === 1 ? 'device' : 'devices'}.`,
      );
    },
  });
}
