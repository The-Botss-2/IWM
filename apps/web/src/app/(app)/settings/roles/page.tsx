'use client';

import { Copy, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { RoleDto, RoleScope } from '@botss/shared-types';

import { RoleEditorDialog, type RoleEditorTarget } from '@/components/roles/role-editor-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/hooks/use-permissions';
import { useDeleteRole, useRoles } from '@/hooks/use-roles';

/** Settings > Roles: company and workspace roles, built-in and custom. */
export default function RolesSettingsPage() {
  const perms = usePermissions();
  const roles = useRoles(perms.canManageRoles);
  const remove = useDeleteRole();
  const [target, setTarget] = useState<RoleEditorTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoleDto | null>(null);

  if (perms.checking) return <Skeleton className="h-48" />;
  if (!perms.canManageRoles) {
    return (
      <div className="py-12 text-center">
        <h2 className="text-ink text-lg font-semibold">Admin only</h2>
        <p className="text-ink-muted mt-1 text-sm">You need the Manage roles permission.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-ink text-lg font-semibold">Roles</h2>
        <p className="text-ink-muted text-sm">
          What each role can do. Assign company roles from Users, and workspace roles from a
          workspace&apos;s Members screen.
        </p>
      </header>
      {roles.isError && !roles.data ? (
        <QueryError message="Couldn't load roles." onRetry={() => void roles.refetch()} />
      ) : roles.isLoading || !roles.data ? (
        <Skeleton className="h-48" />
      ) : (
        <>
          <RoleSection
            title="Company roles"
            scope="COMPANY"
            roles={roles.data.company}
            onOpen={setTarget}
            onDelete={setDeleteTarget}
          />
          <RoleSection
            title="Workspace roles"
            scope="WORKSPACE"
            roles={roles.data.workspace}
            onOpen={setTarget}
            onDelete={setDeleteTarget}
          />
        </>
      )}
      <RoleEditorDialog
        target={target}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete "${deleteTarget?.name ?? ''}"?`}
        description="Everyone holding this role falls back to their built-in role."
        confirmLabel="Delete role"
        variant="destructive"
        onConfirm={async () => {
          try {
            if (deleteTarget) await remove.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          } catch {
            // toasted by the hook's onError; keep the dialog open to retry
          }
        }}
      />
    </div>
  );
}

function RoleSection({
  title,
  scope,
  roles,
  onOpen,
  onDelete,
}: {
  title: string;
  scope: RoleScope;
  roles: RoleDto[];
  onOpen: (t: RoleEditorTarget) => void;
  onDelete: (r: RoleDto) => void;
}) {
  return (
    <section className="border-line bg-bg-surface rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-ink text-sm font-semibold">{title}</h3>
        <Button size="sm" onClick={() => onOpen({ mode: 'create', scope })}>
          <Plus className="h-4 w-4" />
          New role
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-ink-muted text-left text-xs font-medium uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Permissions</th>
              <th className="px-3 py-2">People</th>
              <th className="px-3 py-2 text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} className="border-line border-t">
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-ink font-medium">{r.name}</span>
                    <Badge tone={r.preset ? 'neutral' : 'brand'}>
                      {r.preset ? 'Built-in' : 'Custom'}
                    </Badge>
                  </div>
                  {r.description ? (
                    <p className="text-ink-muted mt-0.5 text-xs">{r.description}</p>
                  ) : null}
                </td>
                <td className="text-ink-muted px-3 py-3 text-xs">{r.permissions.length}</td>
                <td className="text-ink-muted px-3 py-3 text-xs">{r.memberCount}</td>
                <td className="px-3 py-3">
                  <div className="flex justify-end gap-1">
                    {r.locked ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`View ${r.name}`}
                        onClick={() => onOpen({ mode: 'view', role: r })}
                      >
                        <Eye className="text-ink-muted h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${r.name}`}
                        onClick={() => onOpen({ mode: 'edit', role: r })}
                      >
                        <Pencil className="text-ink-muted h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Duplicate ${r.name}`}
                      onClick={() => onOpen({ mode: 'create', scope, from: r })}
                    >
                      <Copy className="text-ink-muted h-4 w-4" />
                    </Button>
                    {r.preset ? null : (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${r.name}`}
                        onClick={() => onDelete(r)}
                      >
                        <Trash2 className="text-ink-muted h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
