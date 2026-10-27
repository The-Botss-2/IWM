'use client';

import { Pencil, Plus, Target, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  CreateGoalInput,
  GoalStatus,
  GoalWithDetails,
  KeyResult,
  UpdateGoalInput,
} from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QueryError } from '@/components/ui/query-error';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  goalChanges,
  useCreateGoal,
  useCreateGoalUpdate,
  useCreateKeyResult,
  useDeleteGoal,
  useDeleteKeyResult,
  useGoalUpdates,
  useGoals,
  useUpdateGoal,
  useUpdateKeyResult,
} from '@/hooks/use-goals';
import { useWorkspaceMembers } from '@/hooks/use-workspace-members';
import { abilityRow, useAbility } from '@/lib/ability';
import { relativeTime } from '@/lib/time';
import { toast } from '@/lib/toast';

const STATUS_TONE: Record<GoalStatus, 'brand' | 'info' | 'neutral'> = {
  ON_TRACK: 'brand',
  AT_RISK: 'info',
  OFF_TRACK: 'neutral',
  COMPLETED: 'brand',
  ARCHIVED: 'neutral',
};
const GOAL_STATUSES = Object.keys(STATUS_TONE) as GoalStatus[];
const statusText = (s: GoalStatus) => s.replace('_', ' ');

type Member = { userId: string; user: { name: string; email: string } };

export default function GoalsView({ projectId }: { projectId: string }) {
  const goals = useGoals(projectId);
  const createGoal = useCreateGoal(projectId);
  const updateGoal = useUpdateGoal(projectId);
  const removeGoal = useDeleteGoal(projectId);
  const createKr = useCreateKeyResult(projectId);
  const updateKr = useUpdateKeyResult(projectId);
  const removeKr = useDeleteKeyResult(projectId);
  const createUpdate = useCreateGoalUpdate(projectId);
  const members = useWorkspaceMembers(projectId);
  // Goals, key results and updates are `update Project` on the API (a lead
  // of this project, or projects.update). UX hint only.
  const canEdit = useAbility().can('update', abilityRow('Project', { id: projectId }));

  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<GoalWithDetails | null>(null);
  const [confirmGoal, setConfirmGoal] = useState<GoalWithDetails | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = goals.data?.find((g) => g.id === selectedId) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr,1.5fr]">
      <section className="rounded-lg border border-line bg-white p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Goals</h3>
          {canEdit ? (
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" /> New goal
            </Button>
          ) : null}
        </div>
        {goals.isLoading ? (
          <Skeleton className="mt-3 h-32" />
        ) : goals.isError && !goals.data ? (
          <QueryError
            message="Couldn't load goals."
            onRetry={() => void goals.refetch()}
            className="mt-3"
          />
        ) : goals.data && goals.data.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {goals.data.map((g) => (
              <li key={g.id}>
                <button
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                    selectedId === g.id
                      ? 'border-blue-300 bg-[#EAF0FC]'
                      : 'border-line hover:bg-bg-subtle'
                  }`}
                  onClick={() => setSelectedId(g.id)}
                >
                  <div className="flex items-center gap-2">
                    <Target className="h-4 w-4 text-ink-disabled" aria-hidden />
                    <span className="flex-1 truncate font-medium">{g.title}</span>
                    <Badge tone={STATUS_TONE[g.status]}>{statusText(g.status)}</Badge>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
                    <div
                      className="h-full bg-tint-info0"
                      style={{ width: `${Math.round(g.progress * 100)}%` }}
                    />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 rounded-md border border-dashed border-line p-6 text-center text-sm text-ink-muted">
            No goals yet.
          </div>
        )}
      </section>

      <section className="rounded-lg border border-line bg-white p-4">
        {selected ? (
          <GoalDetail
            key={selected.id}
            goal={selected}
            members={members.data ?? []}
            canEdit={canEdit}
            onEdit={() => setEditing(selected)}
            onRemove={() => setConfirmGoal(selected)}
            onAddKr={async (title, target) => {
              await createKr.mutateAsync({
                goalId: selected.id,
                input: { title, metricType: 'NUMBER', targetValue: target },
              });
            }}
            onPatchKr={async (krId, current) => {
              await updateKr.mutateAsync({ id: krId, input: { currentValue: current } });
            }}
            onRemoveKr={(krId) => removeKr.mutateAsync(krId).then(() => undefined)}
            removingKr={removeKr.isPending}
            onLogUpdate={async (body) => {
              await createUpdate.mutateAsync({
                goalId: selected.id,
                input: { body },
              });
            }}
          />
        ) : (
          <p className="text-sm text-ink-muted">Select a goal to see its key results.</p>
        )}
      </section>

      <GoalDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        pending={createGoal.isPending}
        members={members.data ?? []}
        onSubmit={async (input) => {
          try {
            await createGoal.mutateAsync(input);
            toast.success(`Goal "${input.title}" created.`);
            setNewOpen(false);
          } catch {
            /* hook surfaces toast */
          }
        }}
      />
      <GoalDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        existing={editing}
        pending={updateGoal.isPending}
        members={members.data ?? []}
        onSubmit={async (input) => {
          if (!editing) return;
          const changes = goalChanges(editing, input);
          try {
            if (Object.keys(changes).length > 0) {
              await updateGoal.mutateAsync({ id: editing.id, input: changes });
            }
            setEditing(null);
          } catch {
            /* hook surfaces toast */
          }
        }}
      />
      <ConfirmDialog
        open={!!confirmGoal}
        onOpenChange={(o) => !o && setConfirmGoal(null)}
        title="Delete this goal?"
        description={confirmGoal ? `${confirmGoal.title}, its key results and updates.` : ''}
        confirmLabel="Delete"
        variant="destructive"
        pending={removeGoal.isPending}
        onConfirm={() => {
          if (!confirmGoal) return;
          removeGoal.mutate(confirmGoal.id);
          if (selectedId === confirmGoal.id) setSelectedId(null);
          setConfirmGoal(null);
        }}
      />
    </div>
  );
}

function GoalDetail({
  goal,
  members,
  canEdit,
  onEdit,
  onRemove,
  onAddKr,
  onPatchKr,
  onRemoveKr,
  removingKr,
  onLogUpdate,
}: {
  goal: GoalWithDetails;
  members: Member[];
  canEdit: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onAddKr: (title: string, target: number) => Promise<void>;
  onPatchKr: (krId: string, current: number) => Promise<void>;
  onRemoveKr: (krId: string) => Promise<void>;
  removingKr: boolean;
  onLogUpdate: (body: string) => Promise<void>;
}) {
  const [krTitle, setKrTitle] = useState('');
  const [krTarget, setKrTarget] = useState('');
  const [updateBody, setUpdateBody] = useState('');
  const [confirmKr, setConfirmKr] = useState<KeyResult | null>(null);
  const updates = useGoalUpdates(goal.id);
  const authorName = (id: string) => {
    const m = members.find((x) => x.userId === id);
    return m ? m.user.name || m.user.email : 'Someone';
  };

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">{goal.title}</h3>
          {goal.description ? (
            <p className="mt-1 text-sm text-ink-muted">{goal.description}</p>
          ) : null}
          <p className="mt-1 text-xs text-ink-muted">
            Owner: {goal.owner.name || goal.owner.email} · {statusText(goal.status)}
          </p>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Edit goal" onClick={onEdit}>
              <Pencil className="h-4 w-4 text-ink-muted" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Delete goal" onClick={onRemove}>
              <Trash2 className="h-4 w-4 text-ink-muted" />
            </Button>
          </div>
        ) : null}
      </header>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          Key results
        </h4>
        {goal.keyResults.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No key results yet.</p>
        ) : null}
        <ul className="mt-2 space-y-2">
          {goal.keyResults.map((k) => {
            const pct = Math.min(
              1,
              Number(k.currentValue) / Math.max(1, Number(k.targetValue)),
            );
            return (
              <li key={k.id} className="rounded-md border border-line p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">{k.title}</span>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-xs text-ink-muted">
                      {k.currentValue} / {k.targetValue} {k.unit ?? ''}
                    </span>
                    {canEdit ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`Delete key result ${k.title}`}
                        onClick={() => setConfirmKr(k)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-ink-muted" />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
                  <div
                    className="h-full bg-tint-info0"
                    style={{ width: `${pct * 100}%` }}
                  />
                </div>
                {canEdit ? (
                  <div className="mt-2 flex items-center gap-2">
                    <Input
                      type="number"
                      defaultValue={k.currentValue}
                      className="h-7 w-28 text-xs"
                      aria-label={`Current value for ${k.title}`}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isNaN(v) && v.toString() !== k.currentValue) {
                          // Failure is toasted by useUpdateKeyResult's meta.errorTitle.
                          onPatchKr(k.id, v).catch(() => undefined);
                        }
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canEdit ? (
          <div className="mt-2 flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">Add a key result</Label>
              <Input
                placeholder="Title"
                value={krTitle}
                onChange={(e) => setKrTitle(e.target.value)}
              />
            </div>
            <Input
              placeholder="Target"
              type="number"
              value={krTarget}
              onChange={(e) => setKrTarget(e.target.value)}
              className="w-24"
            />
            <Button
              size="sm"
              disabled={!krTitle.trim() || !krTarget}
              onClick={async () => {
                try {
                  await onAddKr(krTitle.trim(), Number(krTarget));
                  setKrTitle('');
                  setKrTarget('');
                } catch {
                  // Toasted by the hook's onError; keep the input so the user can retry.
                }
              }}
            >
              Add
            </Button>
          </div>
        ) : null}
      </div>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-ink-muted">Updates</h4>
        {canEdit ? (
          <div className="mt-2 flex items-end gap-2">
            <Input
              value={updateBody}
              onChange={(e) => setUpdateBody(e.target.value)}
              placeholder="What changed?"
              aria-label="Post an update"
            />
            <Button
              size="sm"
              disabled={!updateBody.trim()}
              onClick={async () => {
                try {
                  await onLogUpdate(updateBody.trim());
                  setUpdateBody('');
                } catch {
                  // Toasted by the hook's onError; keep the draft so the user can retry.
                }
              }}
            >
              Log
            </Button>
          </div>
        ) : null}
        {updates.isLoading ? (
          <Skeleton className="mt-3 h-16" />
        ) : updates.isError && !updates.data ? (
          <QueryError
            className="mt-3"
            message="Couldn't load updates."
            onRetry={() => void updates.refetch()}
          />
        ) : updates.data && updates.data.length > 0 ? (
          <ol className="mt-3 space-y-3 border-l border-line pl-4">
            {[...updates.data]
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((u) => (
                <li key={u.id} className="text-sm">
                  <p className="text-xs text-ink-muted">
                    {authorName(u.authorId)} · {relativeTime(u.createdAt)}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-ink">{u.body}</p>
                </li>
              ))}
          </ol>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">No updates yet.</p>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmKr}
        onOpenChange={(o) => !o && setConfirmKr(null)}
        title="Delete this key result?"
        description={confirmKr ? `${confirmKr.title}. The goal's progress is recalculated.` : ''}
        confirmLabel="Delete"
        variant="destructive"
        pending={removingKr}
        onConfirm={async () => {
          if (!confirmKr) return;
          try {
            await onRemoveKr(confirmKr.id);
            setConfirmKr(null);
          } catch {
            // Toasted by the hook; keep the dialog open.
          }
        }}
      />
    </div>
  );
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** New goal, or edit `existing` (with its status). */
function GoalDialog({
  open,
  onOpenChange,
  existing = null,
  pending,
  members,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  existing?: GoalWithDetails | null;
  pending: boolean;
  members: Member[];
  onSubmit: (input: CreateGoalInput & UpdateGoalInput) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [status, setStatus] = useState<GoalStatus>('ON_TRACK');
  const [startDate, setStartDate] = useState(() => isoDay(new Date()));
  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 3);
    return isoDay(d);
  });

  useEffect(() => {
    if (!open || !existing) return;
    setTitle(existing.title);
    setDescription(existing.description ?? '');
    setOwnerId(existing.ownerId);
    setStatus(existing.status);
    setStartDate(isoDay(new Date(existing.startDate)));
    setEndDate(isoDay(new Date(existing.endDate)));
  }, [open, existing]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit goal' : 'New goal'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="goal-title">Title</Label>
            <Input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-description">Description (optional)</Label>
            <Input
              id="goal-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-owner">Owner</Label>
            <select
              id="goal-owner"
              className="w-full rounded-md border border-line px-3 py-2 text-sm"
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
            >
              <option value="">Select an owner…</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user.name || m.user.email}
                </option>
              ))}
            </select>
          </div>
          {existing ? (
            <div className="space-y-1.5">
              <Label htmlFor="goal-status">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as GoalStatus)}>
                <SelectTrigger id="goal-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GOAL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {statusText(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="goal-start">Start</Label>
              <Input
                id="goal-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-end">End</Label>
              <Input
                id="goal-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || !title.trim() || !ownerId}
            onClick={() =>
              onSubmit({
                title: title.trim(),
                description: existing ? description.trim() : description.trim() || undefined,
                ownerId,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                ...(existing ? { status } : {}),
              })
            }
          >
            {existing
              ? pending
                ? 'Saving…'
                : 'Save goal'
              : pending
                ? 'Creating…'
                : 'Create goal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
