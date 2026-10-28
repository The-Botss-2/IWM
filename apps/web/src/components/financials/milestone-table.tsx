'use client';

import { arrayMove } from '@dnd-kit/sortable';
import { ArrowDown, ArrowUp, CheckCircle2, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  ContractMilestoneWithWork,
  ContractWithMilestones,
  MilestoneStatus,
} from '@botss/shared-types';

import {
  MILESTONE_STATUS_OPTIONS,
  MilestoneStatusBadge,
  PaymentStatusBadge,
  milestoneStatusLabel,
} from '@/components/financials/finance-badges';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useCreateMilestone,
  useDeleteMilestone,
  useDeliverMilestone,
  useFinanceSprintPicker,
  useFinanceTaskPicker,
  useLinkMilestoneWork,
  useReorderMilestones,
  useUpdateMilestone,
} from '@/hooks/use-finance';
import { milestoneChanges, milestoneFormFrom, type MilestoneForm } from '@/lib/finance-forms';
import { formatCurrency } from '@/lib/money';

export function MilestoneTable({
  contract,
  onRecordPayment,
  canEdit,
}: {
  contract: ContractWithMilestones;
  onRecordPayment: (milestoneId: string) => void;
  /** `update Contract`, a UX hint: the API checks every write. */
  canEdit: boolean;
}) {
  const del = useDeleteMilestone(contract.id);
  const deliver = useDeliverMilestone(contract.id);
  const reorder = useReorderMilestones(contract.id);
  const [adding, setAdding] = useState(false);
  const [editingMilestone, setEditingMilestone] = useState<ContractMilestoneWithWork | null>(null);
  const [linking, setLinking] = useState<ContractMilestoneWithWork | null>(null);
  const [confirming, setConfirming] = useState<ContractMilestoneWithWork | null>(null);

  // The server takes the contract's FULL milestone list in the new order.
  const move = (index: number, by: -1 | 1) => {
    const ids = contract.milestones.map((m) => m.id);
    reorder.mutate({ ids: arrayMove(ids, index, index + by) });
  };
  const canReorder = canEdit && contract.milestones.length > 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-ink-muted text-sm">
          Payment stages. Link one to a sprint or a set of tasks and it flips to Delivered on its
          own when that work finishes.
        </p>
        {canEdit ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add milestone
          </Button>
        ) : null}
      </div>

      {contract.milestones.length === 0 ? (
        <div className="border-line bg-bg-surface text-ink-muted rounded-md border border-dashed p-8 text-center text-sm">
          No milestones yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-line text-ink-muted border-b text-left text-xs uppercase tracking-wide">
                <th className="px-3 py-2 font-medium">Milestone</th>
                <th className="px-3 py-2 font-medium">Linked work</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-right font-medium">Received</th>
                <th className="px-3 py-2 font-medium">Delivery</th>
                <th className="px-3 py-2 font-medium">Payment</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {contract.milestones.map((m, index) => (
                <tr key={m.id} className="border-line hover:bg-bg-subtle border-b last:border-0">
                  <td className="px-3 py-2 font-medium">{m.title}</td>
                  <td className="text-ink-muted px-3 py-2 text-xs">
                    {m.sprint
                      ? `Sprint: ${m.sprint.name}`
                      : m.tasks.length > 0
                        ? `${m.tasks.length} task${m.tasks.length === 1 ? '' : 's'}`
                        : 'Manual'}
                  </td>
                  <td className="text-ink-muted whitespace-nowrap px-3 py-2">
                    {m.dueDate ? new Date(m.dueDate).toLocaleDateString() : '-'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCurrency(m.amount, contract.currency)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCurrency(m.amountPaid, contract.currency)}
                  </td>
                  <td className="px-3 py-2">
                    <MilestoneStatusBadge status={m.status} />
                  </td>
                  <td className="px-3 py-2">
                    <PaymentStatusBadge status={m.paymentStatus} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {canReorder ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Move ${m.title} up`}
                            disabled={index === 0 || reorder.isPending}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Move ${m.title} down`}
                            disabled={index === contract.milestones.length - 1 || reorder.isPending}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                        </>
                      ) : null}
                      {canEdit ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${m.title}`}
                          onClick={() => setEditingMilestone(m)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      ) : null}
                      {canEdit ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Link work for ${m.title}`}
                          onClick={() => setLinking(m)}
                        >
                          <Link2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                      {canEdit && m.status !== 'DELIVERED' && m.status !== 'CANCELLED' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Mark ${m.title} delivered`}
                          onClick={() => deliver.mutate(m.id)}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                      {m.paymentStatus !== 'PAID' ? (
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            href={`/financials/invoices/new?${new URLSearchParams({
                              contractId: contract.id,
                              milestoneId: m.id,
                              ...(contract.clientId ? { clientId: contract.clientId } : {}),
                              ...(contract.projectId ? { projectId: contract.projectId } : {}),
                              currency: contract.currency,
                              description: m.title,
                              amount: (Number(m.amount) - Number(m.amountPaid)).toFixed(2),
                            }).toString()}`}
                          >
                            Invoice
                          </Link>
                        </Button>
                      ) : null}
                      {m.paymentStatus !== 'PAID' ? (
                        <Button variant="ghost" size="sm" onClick={() => onRecordPayment(m.id)}>
                          Pay
                        </Button>
                      ) : null}
                      {canEdit ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${m.title}`}
                          onClick={() => setConfirming(m)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MilestoneDialog open={adding} onOpenChange={setAdding} contract={contract} />
      <MilestoneDialog
        open={!!editingMilestone}
        onOpenChange={(o) => !o && setEditingMilestone(null)}
        contract={contract}
        existing={editingMilestone}
      />
      <LinkWorkDialog milestone={linking} contract={contract} onClose={() => setLinking(null)} />
      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(o) => !o && setConfirming(null)}
        title="Delete this milestone?"
        description={
          confirming
            ? `${confirming.title}. Any payments recorded against it stay on the contract - they are reattributed, not deleted.`
            : ''
        }
        confirmLabel="Delete"
        variant="destructive"
        pending={del.isPending}
        onConfirm={async () => {
          if (!confirming) return;
          try {
            await del.mutateAsync(confirming.id);
            setConfirming(null);
          } catch {
            // Toast raised by the hook; keep the dialog open.
          }
        }}
      />
    </div>
  );
}

const EMPTY_MILESTONE: MilestoneForm = {
  title: '',
  amount: '',
  dueDate: null,
  description: '',
  status: 'PENDING',
};

/** Add a milestone, or edit `existing` (only the changed fields are sent). */
function MilestoneDialog({
  open,
  onOpenChange,
  contract,
  existing = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithMilestones;
  existing?: ContractMilestoneWithWork | null;
}) {
  const create = useCreateMilestone(contract.id);
  const update = useUpdateMilestone(contract.id);
  const [form, setForm] = useState<MilestoneForm>(EMPTY_MILESTONE);
  const set = <K extends keyof MilestoneForm>(key: K, value: MilestoneForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    if (!open) return;
    setForm(existing ? milestoneFormFrom(existing) : EMPTY_MILESTONE);
  }, [open, existing]);

  const pending = create.isPending || update.isPending;

  async function submit() {
    try {
      if (existing) {
        const changes = milestoneChanges(existing, form);
        if (Object.keys(changes).length > 0) {
          await update.mutateAsync({ id: existing.id, input: changes });
        }
      } else {
        await create.mutateAsync({
          title: form.title.trim(),
          amount: form.amount || '0',
          ...(form.dueDate ? { dueDate: form.dueDate } : {}),
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
        });
      }
      onOpenChange(false);
    } catch {
      // Toast raised by the hook; keep the dialog open.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit milestone' : 'Add milestone'}</DialogTitle>
          <DialogDescription>
            {existing
              ? 'Changing the amount changes the contract total - the milestone sum is what the client owes.'
              : 'Adding a stage raises the contract total - the milestone sum is what the client owes.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="ms-title">Name</Label>
            <Input
              id="ms-title"
              className="mt-1"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Design sign-off"
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ms-amount">Amount ({contract.currency})</Label>
              <Input
                id="ms-amount"
                className="mt-1"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <Label>Due date</Label>
              <div className="mt-1">
                <DatePicker value={form.dueDate} onChange={(d) => set('dueDate', d)} />
              </div>
            </div>
          </div>
          {existing ? (
            <div>
              <Label htmlFor="ms-status">Delivery</Label>
              <Select
                value={form.status}
                onValueChange={(v) => set('status', v as MilestoneStatus)}
              >
                <SelectTrigger id="ms-status" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MILESTONE_STATUS_OPTIONS.map((st) => (
                    <SelectItem key={st} value={st}>
                      {milestoneStatusLabel(st)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-ink-muted mt-1 text-xs">
                Payment status follows the payments recorded and is not set here.
              </p>
            </div>
          ) : null}
          <div>
            <Label htmlFor="ms-description">Description</Label>
            <Textarea
              id="ms-description"
              className="mt-1"
              rows={2}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !form.title.trim()}>
            {pending ? 'Saving…' : existing ? 'Save milestone' : 'Add milestone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Links a milestone to the project work that earns it.
 *
 * Sprint wins over tasks: if a sprint is set, delivery waits for the whole
 * sprint to complete rather than for any individual task, so finishing one
 * item early cannot prematurely mark a stage billable. Without a sprint, the
 * milestone delivers when every linked task is done.
 */
function LinkWorkDialog({
  milestone,
  contract,
  onClose,
}: {
  milestone: ContractMilestoneWithWork | null;
  contract: ContractWithMilestones;
  onClose: () => void;
}) {
  const link = useLinkMilestoneWork(contract.id);
  const sprints = useFinanceSprintPicker(contract.projectId);
  const [sprintId, setSprintId] = useState<string | null>(null);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [taskQuery, setTaskQuery] = useState('');
  const tasks = useFinanceTaskPicker(
    milestone && !sprintId ? contract.projectId : null,
    taskQuery.trim() || undefined,
  );

  useEffect(() => {
    setSprintId(milestone?.sprintId ?? null);
    setTaskIds(milestone?.tasks.map((t) => t.id) ?? []);
    setTaskQuery('');
  }, [milestone]);

  if (!contract.projectId) {
    return (
      <Dialog open={!!milestone} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link project work</DialogTitle>
            <DialogDescription>
              This contract is not attached to a project, so there is no sprint or task to link.
              Attach a project to the contract first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Linked tasks first (they may not match the search), then the results.
  const pinned = (milestone?.tasks ?? []).filter((t) => taskIds.includes(t.id));
  const pinnedIds = new Set(pinned.map((t) => t.id));
  const taskOptions = [...pinned, ...(tasks.data?.items ?? []).filter((t) => !pinnedIds.has(t.id))];

  return (
    <Dialog open={!!milestone} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link project work</DialogTitle>
          <DialogDescription>
            {milestone?.title} becomes Delivered automatically when the linked sprint completes, or
            when every linked task is done.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Sprint</Label>
            <div className="mt-1">
              <Combobox
                options={(sprints.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: s.name,
                  description: s.status,
                }))}
                value={sprintId}
                onChange={setSprintId}
                placeholder="No sprint"
                clearable
              />
            </div>
          </div>
          {sprintId ? (
            <p className="text-ink-muted text-xs">
              A linked sprint decides delivery; tasks are not used.
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-ink text-sm font-medium">Tasks</legend>
              <Input
                value={taskQuery}
                onChange={(e) => setTaskQuery(e.target.value)}
                placeholder="Search tasks"
                aria-label="Search tasks"
              />
              <ul className="max-h-56 space-y-1 overflow-y-auto" role="list">
                {taskOptions.map((t) => {
                  const id = `ms-task-${t.id}`;
                  return (
                    <li key={t.id} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={taskIds.includes(t.id)}
                        onCheckedChange={(v) =>
                          setTaskIds((ids) =>
                            v === true
                              ? [...ids.filter((x) => x !== t.id), t.id]
                              : ids.filter((x) => x !== t.id),
                          )
                        }
                      />
                      <Label htmlFor={id} className="truncate font-normal">
                        {t.title}
                      </Label>
                    </li>
                  );
                })}
                {taskOptions.length === 0 && !tasks.isLoading ? (
                  <li className="text-ink-muted text-sm">No tasks found.</li>
                ) : null}
              </ul>
              <p className="text-ink-muted text-xs">
                {taskIds.length === 0
                  ? 'No tasks linked - mark it delivered by hand.'
                  : `${taskIds.length} task${taskIds.length === 1 ? '' : 's'} linked.`}
              </p>
            </fieldset>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={link.isPending}
            onClick={async () => {
              if (!milestone) return;
              try {
                await link.mutateAsync({
                  id: milestone.id,
                  input: { sprintId, taskIds: sprintId ? [] : taskIds },
                });
                onClose();
              } catch {
                // Toast raised by the hook; keep the dialog open.
              }
            }}
          >
            {link.isPending ? 'Saving…' : 'Save link'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
