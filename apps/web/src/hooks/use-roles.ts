'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  CreateRoleInput,
  PermissionDefDto,
  PermissionOverrideDto,
  RoleDto,
  UpdateRoleInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { sessionQueryOptions } from '@/lib/session-query';
import { toast } from '@/lib/toast';

import { workspaceMembersKey } from './use-workspace-members';

const rolesKey = ['roles'] as const;
const permissionCatalogKey = ['roles', 'catalog'] as const;
const userPermissionsKey = (userId: string, workspaceId?: string | null) =>
  ['roles', 'user', userId, workspaceId ?? null] as const;

export function usePermissionCatalog() {
  return useQuery({
    queryKey: permissionCatalogKey,
    queryFn: () => getApi().roles.catalog(),
    staleTime: Infinity,
  });
}

export interface PermissionGroup {
  group: string;
  permissions: PermissionDefDto[];
}

/** Catalog entries of one scope, grouped for a checklist. */
export function useGroupedPermissions(scope: 'company' | 'workspace'): PermissionGroup[] {
  const catalog = usePermissionCatalog();
  return useMemo(() => {
    const out: PermissionGroup[] = [];
    for (const p of catalog.data?.permissions ?? []) {
      if (p.scope !== scope) continue;
      let g = out.find((x) => x.group === p.group);
      if (!g) {
        g = { group: p.group, permissions: [] };
        out.push(g);
      }
      g.permissions.push(p);
    }
    return out;
  }, [catalog.data, scope]);
}

export function useRoles(enabled = true) {
  return useQuery({
    queryKey: rolesKey,
    queryFn: () => getApi().roles.list(),
    enabled,
    staleTime: 60 * 1000,
  });
}

/** Everything that depends on role definitions or assignments. */
function invalidateRoleData(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: rolesKey });
  void qc.invalidateQueries({ queryKey: workspaceMembersKey });
  void qc.invalidateQueries({ queryKey: sessionQueryOptions.queryKey });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't create role" },
    mutationFn: (input: CreateRoleInput) => getApi().roles.create(input),
    onSuccess: (role: RoleDto) => {
      toast.success(`Role "${role.name}" created.`);
      invalidateRoleData(qc);
    },
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't save role" },
    mutationFn: ({ id, input }: { id: string; input: UpdateRoleInput }) =>
      getApi().roles.update(id, input),
    onSuccess: (role: RoleDto) => {
      toast.success(`Role "${role.name}" saved.`);
      invalidateRoleData(qc);
    },
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't delete role" },
    mutationFn: (id: string) => getApi().roles.remove(id),
    onSuccess: () => {
      toast.success('Role deleted. Its holders fall back to their preset role.');
      invalidateRoleData(qc);
    },
  });
}

export function useUserPermissions(userId: string | null, workspaceId?: string | null) {
  return useQuery({
    queryKey: userPermissionsKey(userId ?? '', workspaceId),
    queryFn: () => getApi().roles.userPermissions(userId ?? '', workspaceId ?? undefined),
    enabled: !!userId,
  });
}

export function useSetCompanyRole() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't change company role" },
    mutationFn: ({ userId, customRoleId }: { userId: string; customRoleId: string | null }) =>
      getApi().roles.setCompanyRole(userId, { customRoleId }),
    onSuccess: (_res, vars) => {
      toast.success('Company role updated.');
      invalidateRoleData(qc);
      void qc.invalidateQueries({ queryKey: ['roles', 'user', vars.userId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

export function useSetPermissionOverrides() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update permissions" },
    mutationFn: ({
      userId,
      workspaceId,
      overrides,
    }: {
      userId: string;
      workspaceId: string | null;
      overrides: PermissionOverrideDto[];
    }) => getApi().roles.setOverrides(userId, { workspaceId, overrides }),
    onSuccess: (_res, vars) => {
      toast.success('Permissions updated.');
      void qc.invalidateQueries({ queryKey: ['roles', 'user', vars.userId] });
      void qc.invalidateQueries({ queryKey: sessionQueryOptions.queryKey });
    },
  });
}

/** Tri-state for one permission in an overrides editor. */
export type OverrideState = 'inherit' | 'grant' | 'deny';

export function overrideStateOf(overrides: PermissionOverrideDto[], key: string): OverrideState {
  const o = overrides.find((x) => x.permission === key);
  if (!o) return 'inherit';
  return o.grant ? 'grant' : 'deny';
}

export function withOverride(
  overrides: PermissionOverrideDto[],
  key: string,
  state: OverrideState,
): PermissionOverrideDto[] {
  const rest = overrides.filter((x) => x.permission !== key);
  if (state === 'inherit') return rest;
  return [...rest, { permission: key, grant: state === 'grant' }];
}

/** Toggle a key in a permission list (role editor checklist). */
export function togglePermission(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key].sort();
}

/** The permissions a role gives: a custom role by id, else the named preset. */
export function rolePermissionsFor(
  roles: RoleDto[] | undefined,
  customRoleId: string | null | undefined,
  presetKey: string | null | undefined,
): string[] {
  if (!roles) return [];
  if (customRoleId) {
    const custom = roles.find((r) => r.id === customRoleId);
    if (custom) return custom.permissions;
  }
  return roles.find((r) => r.preset && r.presetKey === presetKey)?.permissions ?? [];
}

/** Same set of overrides, ignoring order. */
export function sameOverrides(a: PermissionOverrideDto[], b: PermissionOverrideDto[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x) => b.some((y) => y.permission === x.permission && y.grant === x.grant));
}
