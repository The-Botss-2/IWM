'use client';

import {
  Bookmark,
  BookmarkPlus,
  ChevronDown,
  Copy,
  Pencil,
  RotateCcw,
  Share2,
  Trash2,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CreateSavedViewInput,
  SavedView,
  SavedViewConfig,
} from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCreateSavedView,
  useDeleteSavedView,
  useSavedViews,
  useUpdateSavedView,
} from '@/hooks/use-saved-views';
import { useSession } from '@/lib/auth-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface ViewSnapshot {
  viewType: 'board' | 'list';
  filter: SavedViewConfig['filter'];
  columns?: string[];
  groupBy: SavedViewConfig['groupBy'];
  density?: 'compact' | 'normal' | 'detailed';
}

interface Props {
  projectId: string;
  /** Current view state to persist into a saved view. */
  snapshot: ViewSnapshot;
  /** Called when the user picks (or clears) a saved view. */
  onApply: (view: SavedView | null) => void;
}

export function SavedViewsMenu({ projectId, snapshot, onApply }: Props) {
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const userId = session.data?.user.id ?? null;
  const activeViewId = params.get('savedView');

  const list = useSavedViews(projectId);
  const create = useCreateSavedView(projectId);
  const update = useUpdateSavedView(projectId);
  const remove = useDeleteSavedView(projectId);

  const myViews = useMemo(
    () => (list.data ?? []).filter((v) => !v.isShared && v.createdById === userId),
    [list.data, userId],
  );
  const sharedViews = useMemo(
    () => (list.data ?? []).filter((v) => v.isShared),
    [list.data],
  );

  const activeView = useMemo(
    () => (activeViewId ? list.data?.find((v) => v.id === activeViewId) ?? null : null),
    [list.data, activeViewId],
  );

  const isDirty = useMemo(
    () => (activeView ? !configMatches(snapshot, activeView.config) : false),
    [activeView, snapshot],
  );

  const setSavedViewUrl = useCallback(
    (id: string | null) => {
      const sp = new URLSearchParams(params.toString());
      if (id) sp.set('savedView', id);
      else sp.delete('savedView');
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [params, router],
  );

  // Renaming / duplicate / delete dialogs.
  const [editing, setEditing] = useState<SavedView | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);

  const onPickView = (v: SavedView) => {
    setSavedViewUrl(v.id);
    onApply(v);
    setViewsOpen(false);
  };

  const onResetDefault = () => {
    setSavedViewUrl(null);
    onApply(null);
    setViewsOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={viewsOpen} onOpenChange={setViewsOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Bookmark className="h-3.5 w-3.5" />
            <span className="truncate max-w-[10rem]">
              {activeView ? `${activeView.icon ?? ''} ${activeView.name}`.trim() : 'Views'}
            </span>
            {activeView && isDirty ? (
              <Badge tone="warning" className="ml-0.5">
                Updated
              </Badge>
            ) : null}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <div className="max-h-[60vh] overflow-y-auto px-1">
            <SectionHeader label="My views" />
            {myViews.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-ink-muted">No saved views yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {myViews.map((v) => (
                  <ViewItem
                    key={v.id}
                    view={v}
                    active={v.id === activeViewId}
                    onPick={() => onPickView(v)}
                    onRename={() => setEditing(v)}
                    onDuplicate={() =>
                      create.mutate({
                        name: `${v.name} (copy)`,
                        icon: v.icon ?? undefined,
                        scope: v.scope,
                        isShared: v.isShared,
                        config: v.config,
                      }, { onSuccess: (dup) => toast.success(`Duplicated as "${dup.name}".`) })
                    }
                    onDelete={() => setDeleting(v)}
                  />
                ))}
              </ul>
            )}
            <SectionHeader label="Shared with project" />
            {sharedViews.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-ink-muted">No shared views.</p>
            ) : (
              <ul className="space-y-0.5">
                {sharedViews.map((v) => (
                  <ViewItem
                    key={v.id}
                    view={v}
                    active={v.id === activeViewId}
                    onPick={() => onPickView(v)}
                    onRename={v.createdById === userId ? () => setEditing(v) : undefined}
                    onDuplicate={() =>
                      create.mutate({
                        name: `${v.name} (copy)`,
                        icon: v.icon ?? undefined,
                        scope: v.scope,
                        isShared: false,
                        config: v.config,
                      }, { onSuccess: (dup) => toast.success(`Duplicated as "${dup.name}".`) })
                    }
                    onDelete={v.createdById === userId ? () => setDeleting(v) : undefined}
                  />
                ))}
              </ul>
            )}
            <div className="my-1 border-t border-line" />
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-ink hover:bg-bg-subtle"
              onClick={onResetDefault}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to default
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <Popover open={saveOpen} onOpenChange={setSaveOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <BookmarkPlus className="h-3.5 w-3.5" />
            Save view
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <SaveForm
            initial={{
              name: '',
              icon: '',
              isShared: false,
            }}
            pending={create.isPending}
            onSubmit={async ({ name, icon, isShared }) => {
              const input: CreateSavedViewInput = {
                name,
                icon: icon || undefined,
                scope: 'TASKS',
                isShared,
                config: snapshotToConfig(snapshot),
              };
              const created = await create.mutateAsync(input);
              setSavedViewUrl(created.id);
              onApply(created);
              setSaveOpen(false);
              toast.success(`Saved view "${created.name}".`);
            }}
            onCancel={() => setSaveOpen(false)}
            extra={
              activeView && isDirty ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={update.isPending}
                  onClick={async () => {
                    await update.mutateAsync({
                      id: activeView.id,
                      input: { config: snapshotToConfig(snapshot) },
                    });
                    setSaveOpen(false);
                    toast.success('View updated.');
                  }}
                >
                  Update &ldquo;{activeView.name}&rdquo;
                </Button>
              ) : null
            }
          />
        </PopoverContent>
      </Popover>

      <RenameDialog
        view={editing}
        onClose={() => setEditing(null)}
        onSave={async ({ name, icon, isShared }) => {
          if (!editing) return;
          await update.mutateAsync({
            id: editing.id,
            input: {
              name,
              icon: icon || undefined,
              isShared,
            },
          });
          setEditing(null);
          toast.success('View saved.');
        }}
        pending={update.isPending}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title={deleting ? `Delete "${deleting.name}"?` : 'Delete view?'}
        description="This cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          if (activeViewId === deleting.id) setSavedViewUrl(null);
          setDeleting(null);
          toast.success('View deleted.');
        }}
      />
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
      {label}
    </div>
  );
}

function ViewItem({
  view,
  active,
  onPick,
  onRename,
  onDuplicate,
  onDelete,
}: {
  view: SavedView;
  active: boolean;
  onPick: () => void;
  onRename?: () => void;
  onDuplicate: () => void;
  onDelete?: () => void;
}) {
  return (
    <li className={cn('group flex items-center rounded text-sm hover:bg-bg-subtle', active && 'bg-brand-50')}>
      <button
        type="button"
        onClick={onPick}
        className="flex flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <span className="text-base leading-none">{view.icon || '📌'}</span>
        <span className="flex-1 truncate text-ink">{view.name}</span>
        {view.isShared ? (
          <Share2 className="h-3 w-3 text-ink-disabled" aria-label="Shared" />
        ) : null}
      </button>
      <div className="flex items-center gap-0.5 px-1 opacity-0 group-hover:opacity-100">
        {onRename ? (
          <button
            type="button"
            aria-label={`Rename ${view.name}`}
            onClick={onRename}
            className="rounded p-1 text-ink-muted hover:bg-line hover:text-ink"
          >
            <Pencil className="h-3 w-3" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Duplicate ${view.name}`}
          onClick={onDuplicate}
          className="rounded p-1 text-ink-muted hover:bg-line hover:text-ink"
        >
          <Copy className="h-3 w-3" />
        </button>
        {onDelete ? (
          <button
            type="button"
            aria-label={`Delete ${view.name}`}
            onClick={onDelete}
            className="rounded p-1 text-ink-muted hover:bg-tint-error hover:text-state-error"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

function SaveForm({
  initial,
  pending,
  onSubmit,
  onCancel,
  extra,
}: {
  initial: { name: string; icon: string; isShared: boolean };
  pending: boolean;
  onSubmit: (v: { name: string; icon: string; isShared: boolean }) => void | Promise<void>;
  onCancel: () => void;
  extra?: React.ReactNode;
}) {
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState(initial.icon);
  const [isShared, setIsShared] = useState(initial.isShared);
  useEffect(() => {
    setName(initial.name);
    setIcon(initial.icon);
    setIsShared(initial.isShared);
  }, [initial]);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="view-name">Name</Label>
        <Input
          id="view-name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder="My focus"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="view-icon">Icon (optional)</Label>
        <Input
          id="view-icon"
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="🎯"
          maxLength={4}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Visibility</Label>
        <Select
          value={isShared ? 'shared' : 'mine'}
          onValueChange={(v) => setIsShared(v === 'shared')}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mine">My view</SelectItem>
            <SelectItem value="shared">Shared with project</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {extra}
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={pending || name.trim().length === 0}
          onClick={() => onSubmit({ name: name.trim(), icon: icon.trim(), isShared })}
        >
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function RenameDialog({
  view,
  onClose,
  onSave,
  pending,
}: {
  view: SavedView | null;
  onClose: () => void;
  onSave: (v: { name: string; icon: string; isShared: boolean }) => void | Promise<void>;
  pending: boolean;
}) {
  if (!view) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rename view"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-2xl">
        <h3 className="text-base font-semibold">Rename view</h3>
        <div className="mt-3">
          <SaveForm
            initial={{
              name: view.name,
              icon: view.icon ?? '',
              isShared: view.isShared,
            }}
            pending={pending}
            onSubmit={onSave}
            onCancel={onClose}
          />
        </div>
      </div>
    </div>
  );
}

function snapshotToConfig(s: ViewSnapshot): SavedViewConfig {
  return {
    viewType: s.viewType,
    filter: s.filter,
    columns: s.columns,
    groupBy: s.groupBy,
  };
}

/**
 * Compare snapshot to saved config - used to drive the "Updated" badge. We
 * ignore the viewType field so switching the active view tab doesn't dirty an
 * otherwise-unchanged saved view.
 */
function configMatches(s: ViewSnapshot, c: SavedViewConfig): boolean {
  const a = snapshotToConfig(s);
  return JSON.stringify({ ...a, viewType: undefined }) === JSON.stringify({ ...c, viewType: undefined });
}
