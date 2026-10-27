'use client';

import { Tag, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { TaskPriority, TaskStatus } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import {
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  priorityLabel,
  statusLabel,
} from '@/components/tasks/task-badges';
import { useBulkTasks } from '@/hooks/use-tasks';
import { toast } from '@/lib/toast';

interface Props {
  projectId: string;
  selectedIds: string[];
  onClear: () => void;
}

export function BulkActionBar({ projectId, selectedIds, onClear }: Props) {
  const bulk = useBulkTasks();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const count = selectedIds.length;
  if (count === 0) return null;

  const run = async (operation: Parameters<typeof bulk.mutateAsync>[0]['operation']) => {
    try {
      await bulk.mutateAsync({ ids: selectedIds, operation });
      onClear();
      toast.success(`${count} task${count === 1 ? '' : 's'} updated.`);
    } catch {
      /* hook surfaces error */
    }
  };

  return (
    <>
      <div
        role="region"
        aria-label="Bulk task actions"
        className="fixed bottom-4 left-1/2 z-40 w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-line bg-white p-2 shadow-xl"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-700">
            {count} selected
          </span>

          <Select
            value=""
            onValueChange={(v) => run({ kind: 'status', status: v as TaskStatus })}
          >
            <SelectTrigger className="h-8 w-[140px] text-xs" aria-label="Move to status">
              <SelectValue placeholder="Move to…" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value=""
            onValueChange={(v) => run({ kind: 'priority', priority: v as TaskPriority })}
          >
            <SelectTrigger className="h-8 w-[140px] text-xs" aria-label="Change priority">
              <SelectValue placeholder="Priority…" />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_OPTIONS.map((p) => (
                <SelectItem key={p} value={p}>
                  {priorityLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="w-[200px]">
            <WorkspaceMembersCombobox
              value={null}
              onChange={(userId) =>
                run({ kind: 'assignee', assigneeId: userId })
              }
              placeholder="Assign to…"
              projectId={projectId}
              clearable
            />
          </div>

          <Button
            size="sm"
            variant="ghost"
            disabled
            title="Tag bulk editing - coming with the tags column"
            aria-label="Add tags (coming soon)"
          >
            <Tag className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Tags</span>
          </Button>

          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={bulk.isPending}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Delete</span>
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={onClear}
            aria-label="Clear selection"
            className="ml-auto"
          >
            <X className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Clear</span>
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete ${count} task${count === 1 ? '' : 's'}?`}
        description="This soft-deletes the tasks. Restore from the Archive view."
        confirmLabel={`Delete ${count}`}
        variant="destructive"
        pending={bulk.isPending}
        onConfirm={async () => {
          await run({ kind: 'delete' });
          setConfirmDeleteOpen(false);
        }}
      />
    </>
  );
}
