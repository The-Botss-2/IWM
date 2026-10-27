'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { PermissionOverrideDto, UserPermissionsResponse } from '@botss/shared-types';

import { OverrideEditor } from '@/components/roles/override-editor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  rolePermissionsFor,
  sameOverrides,
  useGroupedPermissions,
  useRoles,
  useSetCompanyRole,
  useSetPermissionOverrides,
  useUserPermissions,
} from '@/hooks/use-roles';

const PRESET = '__preset__';

/** Settings > Users: a person's company role (preset or custom) and extras. */
export function UserAccessDialog({
  user,
  onOpenChange,
}: {
  user: { id: string; name: string; email: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const perms = useUserPermissions(user?.id ?? null);
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Access for {user?.name}</DialogTitle>
          <DialogDescription>
            Company role and per-person extras. Workspace access is set per workspace on its
            Members screen.
          </DialogDescription>
        </DialogHeader>
        {!perms.data ? (
          <Skeleton className="h-48" />
        ) : (
          <UserAccessForm key={perms.data.userId} data={perms.data} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserAccessForm({ data, onDone }: { data: UserPermissionsResponse; onDone: () => void }) {
  const roles = useRoles();
  const groups = useGroupedPermissions('company');
  const setRole = useSetCompanyRole();
  const setOverrides = useSetPermissionOverrides();
  const [roleId, setRoleId] = useState<string>(data.customRoleId ?? PRESET);
  const [overrides, setOverridesState] = useState<PermissionOverrideDto[]>(data.companyOverrides);
  const isSuper = data.systemRole === 'SUPER_ADMIN';
  const customRoles = (roles.data?.company ?? []).filter((r) => !r.preset);
  const presetName =
    roles.data?.company.find((r) => r.presetKey === data.systemRole)?.name ?? data.systemRole;
  const fromRole = rolePermissionsFor(
    roles.data?.company,
    roleId === PRESET ? null : roleId,
    data.systemRole,
  );
  const busy = setRole.isPending || setOverrides.isPending;

  const save = async () => {
    try {
      const nextRole = roleId === PRESET ? null : roleId;
      if (nextRole !== data.customRoleId) {
        await setRole.mutateAsync({ userId: data.userId, customRoleId: nextRole });
      }
      if (!sameOverrides(overrides, data.companyOverrides)) {
        await setOverrides.mutateAsync({ userId: data.userId, workspaceId: null, overrides });
      }
      onDone();
    } catch {
      // toast surfaced by hook
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <Label htmlFor="ua-role">Company role</Label>
        <Select value={roleId} onValueChange={setRoleId} disabled={isSuper}>
          <SelectTrigger id="ua-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PRESET}>{presetName} (preset)</SelectItem>
            {customRoles.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-ink-muted">
          {isSuper
            ? 'Super admins always hold every permission.'
            : 'The preset follows the user\'s system role, which you change in Edit user.'}
        </p>
      </div>
      {isSuper ? null : (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Extras for this person</h3>
          <OverrideEditor
            groups={groups}
            overrides={overrides}
            fromRole={fromRole}
            onChange={setOverridesState}
          />
        </div>
      )}
      <DialogFooter className="gap-2">
        <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void save()} disabled={busy || isSuper}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}
