'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { RoleDto, RoleScope } from '@botss/shared-types';

import { PermissionChecklist } from '@/components/roles/permission-checklist';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  togglePermission,
  useCreateRole,
  useGroupedPermissions,
  useUpdateRole,
} from '@/hooks/use-roles';

/** What the editor opens on: an existing role, or a new one (optionally cloned). */
export type RoleEditorTarget =
  | { mode: 'view'; role: RoleDto }
  | { mode: 'edit'; role: RoleDto }
  | { mode: 'create'; scope: RoleScope; from?: RoleDto };

export function RoleEditorDialog({
  target,
  onOpenChange,
}: {
  target: RoleEditorTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const key = target
    ? target.mode === 'create'
      ? `new-${target.scope}-${target.from?.id ?? ''}`
      : `${target.mode}-${target.role.id}`
    : 'closed';
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {target ? (
          <RoleEditorForm key={key} target={target} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RoleEditorForm({ target, onDone }: { target: RoleEditorTarget; onDone: () => void }) {
  const scope = target.mode === 'create' ? target.scope : target.role.scope;
  const source = target.mode === 'create' ? target.from : target.role;
  const readOnly = target.mode === 'view';
  const groups = useGroupedPermissions(scope === 'COMPANY' ? 'company' : 'workspace');
  const create = useCreateRole();
  const update = useUpdateRole();
  const [name, setName] = useState(
    target.mode === 'create' ? (source ? `${source.name} (copy)` : '') : target.role.name,
  );
  const [description, setDescription] = useState(
    target.mode === 'create' ? '' : (target.role.description ?? ''),
  );
  const [permissions, setPermissions] = useState<string[]>(source?.permissions ?? []);
  const busy = create.isPending || update.isPending;

  const save = async () => {
    try {
      if (target.mode === 'create') {
        await create.mutateAsync({
          scope,
          name,
          description: description || null,
          permissions,
          basePreset: target.from?.presetKey ?? null,
        });
      } else if (target.mode === 'edit') {
        await update.mutateAsync({
          id: target.role.id,
          input: { name, description: description || null, permissions },
        });
      }
      onDone();
    } catch {
      // toast surfaced by hook
    }
  };

  const title =
    target.mode === 'create' ? 'New role' : target.mode === 'edit' ? 'Edit role' : target.role.name;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {scope === 'COMPANY'
            ? 'Company roles apply across the whole organization.'
            : 'Workspace roles apply inside the workspace a member holds them in.'}
          {readOnly ? ' Built-in roles are read-only; duplicate one to customize it.' : ''}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        {readOnly ? null : (
          <>
            <div className="space-y-1">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="role-desc">Description</Label>
              <Textarea
                id="role-desc"
                rows={2}
                maxLength={300}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </>
        )}
        <PermissionChecklist
          groups={groups}
          value={permissions}
          readOnly={readOnly}
          onToggle={(k) => setPermissions((prev) => togglePermission(prev, k))}
        />
      </div>
      <DialogFooter className="gap-2">
        <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
          {readOnly ? 'Close' : 'Cancel'}
        </Button>
        {readOnly ? null : (
          <Button type="button" onClick={() => void save()} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save role
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
