'use client';

import { UserMinus, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ProjectRole } from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import {
  useAddProjectMember,
  useProjectMembers,
  useRemoveProjectMember,
  useUpdateProjectMember,
} from '@/hooks/use-project-members';
import { toast, toastErrorMessage } from '@/lib/toast';

const ROLE_OPTIONS: { value: ProjectRole; label: string }[] = [
  { value: 'PROJECT_LEAD', label: 'Project lead' },
  { value: 'CONTRIBUTOR', label: 'Contributor' },
  { value: 'REVIEWER', label: 'Reviewer' },
  { value: 'VIEWER', label: 'Viewer' },
];

function roleLabel(role: ProjectRole) {
  return ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;
}

export function ProjectMembersSection({ projectId }: { projectId: string }) {
  const { data, isLoading, isError, refetch } = useProjectMembers(projectId);
  const add = useAddProjectMember(projectId);
  const updateMember = useUpdateProjectMember(projectId);
  const remove = useRemoveProjectMember(projectId);

  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);

  const existingUserIds = useMemo(() => data?.map((m) => m.userId) ?? [], [data]);

  return (
    <section
      aria-labelledby="project-members-heading"
      className="border-line rounded-lg border bg-white p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="project-members-heading" className="text-ink text-base font-semibold">
          Members
        </h2>
        <Button onClick={() => setAddOpen(true)} size="sm">
          <UserPlus className="h-4 w-4" />
          Add member
        </Button>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : isError && !data ? (
          <QueryError message="Couldn't load project members." onRetry={() => void refetch()} />
        ) : data && data.length > 0 ? (
          <ul className="divide-line border-line divide-y rounded-md border">
            {data.map((m) => (
              <li key={m.id} className="flex items-center gap-3 p-3">
                <UserAvatar size="md" name={m.user.name || m.user.email} image={m.user.image} />
                <div className="min-w-0 flex-1">
                  <div className="text-ink truncate text-sm font-medium">
                    {m.user.name || m.user.email}
                  </div>
                  <div className="text-ink-muted truncate text-xs">{m.user.email}</div>
                </div>
                <Badge tone="brand">{roleLabel(m.role)}</Badge>
                <Select
                  value={m.role}
                  onValueChange={(v) =>
                    updateMember.mutate({ id: m.id, input: { role: v as ProjectRole } })
                  }
                >
                  <SelectTrigger
                    className="w-[140px]"
                    aria-label={`Change role for ${m.user.name || m.user.email}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${m.user.name || m.user.email}`}
                  onClick={() => setRemoveTarget({ id: m.id, name: m.user.name || m.user.email })}
                >
                  <UserMinus className="text-ink-muted h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="border-line text-ink-muted rounded-md border border-dashed p-6 text-center text-sm">
            No members assigned yet.
          </div>
        )}
      </div>

      <AddMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        excludeUserIds={existingUserIds}
        pending={add.isPending}
        projectId={projectId}
        onAdd={async (userId, role) => {
          await add.mutateAsync({ userId, role });
          setAddOpen(false);
          toast.success('Member added.');
        }}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRemoveTarget(null);
        }}
        title="Remove this member?"
        description={removeTarget ? `${removeTarget.name} will lose access to this project.` : ''}
        confirmLabel="Remove"
        variant="destructive"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!removeTarget) return;
          await remove.mutateAsync(removeTarget.id);
          setRemoveTarget(null);
          toast.success('Member removed.');
        }}
      />
    </section>
  );
}

function AddMemberDialog({
  open,
  onOpenChange,
  excludeUserIds,
  pending,
  projectId,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludeUserIds: readonly string[];
  pending: boolean;
  projectId: string;
  onAdd: (userId: string, role: ProjectRole) => Promise<void>;
}) {
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<ProjectRole>('CONTRIBUTOR');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setUserId(null);
          setRole('CONTRIBUTOR');
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Add project member</DialogTitle>
          <DialogDescription className="text-ink-muted text-sm">
            Pick a workspace member and assign their role on this project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Workspace member</Label>
            <WorkspaceMembersCombobox
              value={userId}
              onChange={setUserId}
              placeholder="Select a member"
              clearable={false}
              excludeUserIds={excludeUserIds}
              projectId={projectId}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-member-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as ProjectRole)}>
              <SelectTrigger id="add-member-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!userId) {
                toastErrorMessage('Pick a member to add');
                return;
              }
              void onAdd(userId, role);
            }}
            disabled={!userId || pending}
          >
            {pending ? 'Adding…' : 'Add member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
