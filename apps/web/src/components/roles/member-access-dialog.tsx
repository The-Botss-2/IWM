'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import type {
  PermissionOverrideDto,
  UserPermissionsResponse,
  WorkspaceMembershipWithUser,
} from '@botss/shared-types';

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
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/hooks/use-permissions';
import {
  rolePermissionsFor,
  sameOverrides,
  useGroupedPermissions,
  useRoles,
  useSetPermissionOverrides,
  useUserPermissions,
} from '@/hooks/use-roles';
import { workspacePresetKeyOf } from '@/hooks/use-member-roles';

/** Workspace members screen: per-member extras inside this workspace. */
export function MemberAccessDialog({
  member,
  onOpenChange,
}: {
  member: WorkspaceMembershipWithUser | null;
  onOpenChange: (open: boolean) => void;
}) {
  const perms = useUserPermissions(member?.userId ?? null, member?.workspaceId ?? null);
  return (
    <Dialog open={!!member} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Extras for {member?.user.name || member?.user.email}</DialogTitle>
          <DialogDescription>
            Allow or deny single permissions in this workspace on top of their workspace role.
          </DialogDescription>
        </DialogHeader>
        {!perms.data || !member ? (
          <Skeleton className="h-48" />
        ) : (
          <MemberAccessForm
            key={`${perms.data.userId}-${perms.data.workspaceId ?? ''}`}
            data={perms.data}
            member={member}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MemberAccessForm({
  data,
  member,
  onDone,
}: {
  data: UserPermissionsResponse;
  member: WorkspaceMembershipWithUser;
  onDone: () => void;
}) {
  const actor = usePermissions();
  const roles = useRoles();
  const groups = useGroupedPermissions('workspace');
  const save = useSetPermissionOverrides();
  const [overrides, setOverrides] = useState<PermissionOverrideDto[]>(data.workspaceOverrides);
  const fromRole = rolePermissionsFor(
    roles.data?.workspace,
    member.customRoleId ?? null,
    workspacePresetKeyOf(member.role),
  );
  // Workspace managers can only touch permissions they hold themselves.
  const allowed = actor.canManageRoles ? undefined : actor.workspace;

  const submit = async () => {
    try {
      if (!sameOverrides(overrides, data.workspaceOverrides)) {
        await save.mutateAsync({ userId: data.userId, workspaceId: member.workspaceId, overrides });
      }
      onDone();
    } catch {
      // toast surfaced by hook
    }
  };

  return (
    <div className="space-y-4">
      <OverrideEditor
        groups={groups}
        overrides={overrides}
        fromRole={fromRole}
        onChange={setOverrides}
        {...(allowed ? { allowed } : {})}
      />
      <DialogFooter className="gap-2">
        <Button type="button" variant="secondary" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}
