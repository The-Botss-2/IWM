'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertOrganizationMailConfigInput } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast } from '@/lib/toast';

const orgMailConfigKey = ['org', 'mail-config'] as const;

/** The caller's own organization mail config (null until configured). */
export function useOrgMailConfig() {
  return useQuery({
    queryKey: orgMailConfigKey,
    queryFn: () => getApi().organizations.getMyMailConfig(),
    staleTime: 30_000,
  });
}

export function useUpsertOrgMailConfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't save email settings" },
    mutationFn: (input: UpsertOrganizationMailConfigInput) =>
      getApi().organizations.upsertMyMailConfig(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orgMailConfigKey });
      toast.success('Organization email settings saved.');
    },
  });
}
