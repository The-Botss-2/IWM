'use client';

import { Archive, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Project, TaskWithPeople, UpdateTaskInput } from '@botss/shared-types';

import { ShareToChatDialog } from '@/components/chat/share-to-chat-dialog';
import { TaskComments } from '@/features/tasks/comments/task-comments';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmByTypingDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import {
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  priorityLabel,
  statusLabel,
} from '@/components/tasks/task-badges';
import { TaskCustomFields } from '@/components/tasks/task-custom-fields';
import { useArchiveTask } from '@/hooks/use-archived-tasks';
import { useDebouncedCallback } from '@/hooks/use-debounced';
import { useIsMobile } from '@/hooks/use-media-query';
import {
  portalListsProjectStatus,
  portalListsTaskStatus,
  useUpdateTaskPortalVisibility,
} from '@/hooks/use-project-portal';
import { useDeleteTask, useUpdateTask } from '@/hooks/use-tasks';
import { abilityRow, useAbility } from '@/lib/ability';
import { absoluteTime, relativeTime } from '@/lib/time';
import { toast, toastErrorMessage } from '@/lib/toast';

/** The client portal settings of the task's project. */
type PortalProject = Pick<Project, 'clientId' | 'portalVisible' | 'portalShowAllTasks' | 'status'>;

interface Props {
  task: TaskWithPeople | null;
  /** Used to scope the assignee picker to the project's workspace members. */
  projectId?: string;
  /** The task's project. Its client portal settings decide whether the
   *  "Visible to client" switch shows. */
  project?: PortalProject;
  onClose: () => void;
}

export function TaskDetailPanel({ task, projectId, project, onClose }: Props) {
  const open = task !== null;
  const isMobile = useIsMobile();
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent side={isMobile ? 'bottom' : 'right'} aria-describedby={undefined}>
        {task ? (
          <PanelInner task={task} projectId={projectId} project={project} onClose={onClose} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function PanelInner({
  task,
  projectId,
  project,
  onClose,
}: {
  task: TaskWithPeople;
  projectId?: string;
  project?: PortalProject;
  onClose: () => void;
}) {
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const archive = useArchiveTask(task.projectId);
  // Archiving is a soft delete and the API gates it like one (the creator,
  // a project lead, or tasks.delete_any). UX hint only.
  const canArchive = useAbility().can('delete', abilityRow('Task', task));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // Local title state lets us debounce-on-blur without re-rendering the parent
  // on every keystroke. The cache is the source of truth - when the user blurs
  // the input we push the change through the optimistic mutation.
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const titleRef = useRef(task.title);
  const descRef = useRef(task.description ?? '');

  // Re-sync local state when the parent's task changes (e.g. switching tasks
  // while the panel is open). Compare to refs to avoid stomping on user edits
  // mid-typing - only resync if the upstream value differs from what we last
  // synced from upstream.
  useEffect(() => {
    if (task.title !== titleRef.current) {
      titleRef.current = task.title;
      setTitle(task.title);
    }
    const desc = task.description ?? '';
    if (desc !== descRef.current) {
      descRef.current = desc;
      setDescription(desc);
    }
  }, [task.id, task.title, task.description]);

  const save = (input: UpdateTaskInput) => {
    update.mutate({ id: task.id, input });
  };

  const debouncedSaveDescription = useDebouncedCallback((value: string) => {
    if (value === (task.description ?? '')) return;
    save({ description: value });
  }, 1000);

  return (
    <>
      <SheetHeader>
        <SheetTitle className="text-xs uppercase tracking-wide text-ink-muted">Task</SheetTitle>
        <Input
          aria-label="Task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const trimmed = title.trim();
            if (trimmed.length === 0) {
              setTitle(task.title);
              toastErrorMessage('Title cannot be empty');
              return;
            }
            if (trimmed === task.title) return;
            save({ title: trimmed });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="text-lg font-semibold border-transparent shadow-none px-2 -mx-2 hover:bg-bg-subtle focus:bg-white focus:border-brand-purple"
        />
      </SheetHeader>
      <SheetBody>
        <div className="space-y-5">
          <Field label="Description" htmlFor="task-description">
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                debouncedSaveDescription(e.target.value);
              }}
              placeholder="Add a description…"
              rows={4}
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Status" htmlFor="task-status">
              <Select
                value={task.status}
                onValueChange={(v) => save({ status: v as UpdateTaskInput['status'] })}
              >
                <SelectTrigger id="task-status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {statusLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Priority" htmlFor="task-priority">
              <Select
                value={task.priority}
                onValueChange={(v) => save({ priority: v as UpdateTaskInput['priority'] })}
              >
                <SelectTrigger id="task-priority">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {priorityLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Assignee" htmlFor="task-assignee">
              <WorkspaceMembersCombobox
                value={task.assigneeId}
                onChange={(userId) => save({ assigneeId: userId })}
                projectId={projectId}
              />
            </Field>

            <Field label="Due date" htmlFor="task-due">
              <DatePicker
                value={task.dueDate}
                onChange={(d) => save({ dueDate: d })}
                placeholder="No due date"
              />
            </Field>

            <Field label="Estimate (hours)" htmlFor="task-estimate">
              <Input
                id="task-estimate"
                inputMode="decimal"
                defaultValue={task.estimateHours ?? ''}
                onBlur={(e) => {
                  const raw = e.target.value.trim();
                  if (raw === (task.estimateHours ?? '')) return;
                  if (raw === '') {
                    save({ estimateHours: null });
                    return;
                  }
                  const num = Number(raw);
                  if (!Number.isFinite(num) || num < 0) {
                    toastErrorMessage('Estimate must be a positive number');
                    e.target.value = task.estimateHours ?? '';
                    return;
                  }
                  save({ estimateHours: String(num) });
                }}
                placeholder="0"
              />
            </Field>
          </div>

          <TaskCustomFields task={task} />

          {/* Only while the project has a client and lists marked tasks only;
              with "All tasks" every task is listed, so there is nothing to mark. */}
          {project?.clientId && !project.portalShowAllTasks ? (
            <ClientVisibilityToggle
              task={task}
              projectShownInPortal={
                (project.portalVisible ?? true) && portalListsProjectStatus(project.status)
              }
            />
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-line pt-4">
            <ReadOnly label="Created by">
              <div className="flex items-center gap-2">
                <UserAvatar
                  size="sm"
                  name={task.createdBy.name || task.createdBy.email}
                  image={task.createdBy.image}
                />
                <span className="text-sm">{task.createdBy.name || task.createdBy.email}</span>
              </div>
            </ReadOnly>
            <ReadOnly label="Created">
              <Tooltip content={absoluteTime(task.createdAt)}>
                <span className="text-sm text-ink">{relativeTime(task.createdAt)}</span>
              </Tooltip>
            </ReadOnly>
            <ReadOnly label="Updated">
              <Tooltip content={absoluteTime(task.updatedAt)}>
                <span className="text-sm text-ink">{relativeTime(task.updatedAt)}</span>
              </Tooltip>
            </ReadOnly>
            {task.completedAt ? (
              <ReadOnly label="Completed">
                <Tooltip content={absoluteTime(task.completedAt)}>
                  <span className="text-sm text-ink">{relativeTime(task.completedAt)}</span>
                </Tooltip>
              </ReadOnly>
            ) : null}
          </div>

          <TaskComments taskId={task.id} />

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button
              variant="secondary"
              onClick={() => setShareOpen(true)}
              className="sm:w-auto"
            >
              <Send className="h-4 w-4" />
              Share to chat
            </Button>
            {canArchive ? (
              <Button
                variant="secondary"
                disabled={archive.isPending}
                onClick={() => {
                  // Optimistic: the task leaves the board now and comes back
                  // if the archive fails.
                  archive.mutate(task.id);
                  onClose();
                }}
                className="sm:w-auto"
              >
                <Archive className="h-4 w-4" />
                Archive
              </Button>
            ) : null}
            <Button
              variant="destructive"
              onClick={() => setConfirmOpen(true)}
              className="sm:w-auto"
            >
              <Trash2 className="h-4 w-4" />
              Delete task
            </Button>
          </div>
        </div>
      </SheetBody>

      <ShareToChatDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        itemType="task"
        itemId={task.id}
        itemLabel={task.title}
      />

      <ConfirmByTypingDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this task?"
        description="This action cannot be undone. The task and its history will be removed."
        challenge={task.title}
        challengeLabel="Type the task title"
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync(task.id);
          setConfirmOpen(false);
          onClose();
          toast.success('Task deleted.');
        }}
      />
    </>
  );
}

function ClientVisibilityToggle({
  task,
  projectShownInPortal,
}: {
  task: TaskWithPeople;
  projectShownInPortal: boolean;
}) {
  const update = useUpdateTaskPortalVisibility();
  // Absent reads as false: tasks start hidden from the client.
  const visible = task.portalVisible ?? false;
  return (
    <div className="flex items-start gap-3 rounded-md border border-line p-3">
      <Checkbox
        id="task-portal-visible"
        checked={visible}
        disabled={update.isPending && update.variables?.taskId === task.id}
        onCheckedChange={(v) => update.mutate({ taskId: task.id, portalVisible: v === true })}
        aria-describedby="task-portal-visible-help"
        className="mt-0.5"
      />
      <div className="min-w-0">
        <Label htmlFor="task-portal-visible" className="cursor-pointer leading-snug">
          Visible to client
        </Label>
        <p id="task-portal-visible-help" className="mt-1 text-xs text-ink-muted">
          {!portalListsTaskStatus(task.status)
            ? 'Cancelled tasks are never listed in the client portal.'
            : projectShownInPortal
              ? 'Lists this task in the client portal for this project.'
              : 'This project is not shown in the client portal right now (hidden, a draft or archived), so the client does not see it yet.'}
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function ReadOnly({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</div>
      {children}
    </div>
  );
}
