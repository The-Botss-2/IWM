'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateOrganizationInput,
  CreateOrganizationResponse,
  InviteOrganizationOwnerInput,
  InviteOrganizationOwnerResponse,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast } from '@/lib/toast';

/**
 * Platform-admin tenant management (`/admin/organizations`). Every mutation
 * refreshes the tenant list itself, so callers only handle their own UI.
 */
const adminOrganizationsKey = ['admin', 'organizations'] as const;

export function useAdminOrganizations() {
  return useQuery({
    queryKey: adminOrganizationsKey,
    queryFn: () => getApi().organizations.list(),
    staleTime: 30_000,
  });
}

function useInvalidateOrganizations() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: adminOrganizationsKey });
}

export function useToggleOrganizationActive() {
  const invalidate = useInvalidateOrganizations();
  return useMutation({
    meta: { errorTitle: "Couldn't update organization" },
    mutationFn: ({ orgId, isActive }: { orgId: string; isActive: boolean }) =>
      getApi().organizations.update(orgId, { isActive }),
    onSuccess: () => invalidate(),
  });
}

export function useArchiveOrganization() {
  const invalidate = useInvalidateOrganizations();
  return useMutation({
    meta: { errorTitle: "Couldn't archive organization" },
    mutationFn: (orgId: string) => getApi().organizations.softDelete(orgId),
    onSuccess: () => {
      void invalidate();
      toast.success('Organization archived. Users in this tenant can no longer sign in.');
    },
  });
}

export function useRestoreOrganization() {
  const invalidate = useInvalidateOrganizations();
  return useMutation({
    meta: { errorTitle: "Couldn't restore organization" },
    mutationFn: (orgId: string) => getApi().organizations.restore(orgId),
    onSuccess: () => {
      void invalidate();
      toast.success('Organization restored.');
    },
  });
}

export function useHardDeleteOrganization() {
  const invalidate = useInvalidateOrganizations();
  return useMutation({
    meta: { errorTitle: "Couldn't delete organization" },
    mutationFn: (orgId: string) => getApi().organizations.hardDelete(orgId),
    onSuccess: () => {
      void invalidate();
      toast.success('Organization permanently deleted.');
    },
  });
}

export function useCreateOrganization(
  options: {
    onSuccess?: (org: CreateOrganizationResponse) => void;
  } = {},
) {
  const invalidate = useInvalidateOrganizations();
  return useMutation({
    meta: { errorTitle: "Couldn't create organization" },
    mutationFn: (input: CreateOrganizationInput) => getApi().organizations.create(input),
    onSuccess: (org) => {
      void invalidate();
      options.onSuccess?.(org);
    },
  });
}

export function useInviteOrganizationOwner(
  options: {
    onSuccess?: (resp: InviteOrganizationOwnerResponse) => void;
  } = {},
) {
  const invalidate = useInvalidateOrganizations();
  return useMutation({
    meta: { errorTitle: "Couldn't send invite" },
    mutationFn: ({ orgId, input }: { orgId: string; input: InviteOrganizationOwnerInput }) =>
      getApi().organizations.inviteOwner(orgId, input),
    onSuccess: (resp) => {
      void invalidate();
      options.onSuccess?.(resp);
    },
  });
}

/** On-demand probe of the platform's outbound mail transport. */
export function useMailHealthProbe() {
  return useMutation({
    // The diagnostic panel renders the failure inline - no toast.
    meta: { silentError: true },
    mutationFn: () => getApi().admin.emailHealth(),
  });
}
