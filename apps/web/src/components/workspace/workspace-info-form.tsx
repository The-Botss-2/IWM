'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionContext, Workspace } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedCallback } from '@/hooks/use-debounced';
import { useUpdateCurrentWorkspace } from '@/hooks/use-workspace';
import { toastErrorMessage } from '@/lib/toast';
import { usePermissions } from '@/hooks/use-permissions';

export function WorkspaceInfoForm({ workspace }: { workspace: Workspace }) {
  const update = useUpdateCurrentWorkspace();
  const session = useSessionContext();
  // Editability is gated on the caller's WorkspaceMembership.role for the
  // ACTIVE workspace - only OWNER / ADMIN may mutate. The API enforces
  // the same rule; this is a UX hint so members never see editable
  // inputs that would just bounce with a 403.
  const perms = usePermissions();
  const canEdit = useMemo(() => {
    const data = session.data as SessionContext | undefined;
    if (!data) return false;
    // Organization admins administer every workspace in their tenant.
    if (perms.isOrgAdmin) return true;
    // Effective permissions describe the ACTIVE workspace only.
    return data.currentWorkspaceId === workspace.id && perms.workspace.includes('workspace.settings');
  }, [session.data, workspace.id, perms.isOrgAdmin, perms.workspace]);
  const save = (input: Parameters<typeof update.mutate>[0]) => update.mutate(input);

  return (
    <section
      aria-labelledby="workspace-info-heading"
      className="rounded-lg border border-line bg-white p-5"
    >
      <h2 id="workspace-info-heading" className="text-base font-semibold text-ink">
        Workspace info
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        {canEdit
          ? 'Changes save automatically.'
          : 'Only the workspace owner or an admin can edit these fields.'}
      </p>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <EditableText
          id="workspace-name"
          label="Name"
          value={workspace.name}
          required
          requiredError="Workspace name cannot be empty."
          readOnly={!canEdit}
          onSave={(v) => save({ name: v })}
        />

        <div className="space-y-1.5">
          <Label htmlFor="workspace-slug">Slug</Label>
          <Input
            id="workspace-slug"
            value={workspace.slug}
            readOnly
            aria-readonly
            className="bg-bg-subtle text-ink-muted font-mono"
            // Slugs are URL-sensitive; renaming would invalidate bookmarks and
            // any invite links a member already has. Keep it read-only until
            // there's a dedicated rename flow.
          />
          <p className="text-xs text-ink-muted">URL slug - fixed once the workspace is created.</p>
        </div>

        <EditableTextarea
          id="workspace-description"
          label="Description"
          value={workspace.description ?? ''}
          readOnly={!canEdit}
          onSave={(v) => save({ description: v.length === 0 ? undefined : v })}
        />
      </div>
    </section>
  );
}

interface EditableTextProps {
  id: string;
  label: string;
  value: string;
  type?: 'text' | 'url' | 'email';
  placeholder?: string;
  required?: boolean;
  requiredError?: string;
  readOnly?: boolean;
  onSave: (v: string) => void;
}

function EditableText({
  id,
  label,
  value,
  type = 'text',
  placeholder,
  required = false,
  requiredError = 'This field cannot be empty.',
  readOnly = false,
  onSave,
}: EditableTextProps) {
  const [local, setLocal] = useState(value);
  const upstreamRef = useRef(value);

  useEffect(() => {
    if (value !== upstreamRef.current) {
      upstreamRef.current = value;
      setLocal(value);
    }
  }, [value]);

  const commit = () => {
    const next = local.trim();
    if (next === value.trim()) return;
    if (required && next.length === 0) {
      setLocal(value);
      toastErrorMessage(requiredError);
      return;
    }
    onSave(next);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={local}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
        className={readOnly ? 'bg-bg-subtle text-ink-muted' : undefined}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={readOnly ? undefined : commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

function EditableTextarea({
  id,
  label,
  value,
  readOnly = false,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  readOnly?: boolean;
  onSave: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const upstreamRef = useRef(value);

  useEffect(() => {
    if (value !== upstreamRef.current) {
      upstreamRef.current = value;
      setLocal(value);
    }
  }, [value]);

  const debouncedSave = useDebouncedCallback((next: string) => {
    if (next === value) return;
    onSave(next);
  }, 800);

  return (
    <div className="space-y-1.5 md:col-span-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={local}
        rows={3}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
        className={readOnly ? 'bg-bg-subtle text-ink-muted' : undefined}
        onChange={(e) => {
          if (readOnly) return;
          setLocal(e.target.value);
          debouncedSave(e.target.value);
        }}
        placeholder="Short description of what this workspace is for."
      />
    </div>
  );
}
