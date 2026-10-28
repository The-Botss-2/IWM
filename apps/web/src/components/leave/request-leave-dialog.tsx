'use client';

import { LeaveType } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
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
import { Textarea } from '@/components/ui/textarea';
import { useLeaveRequestForm } from '@/hooks/use-leaves';
import { LEAVE_TYPE_LABELS } from '@/lib/leave';

/**
 * Request time off for yourself, or - when `people` is passed - record leave
 * for someone else as HR (the server approves that straight away).
 */
export function RequestLeaveDialog({
  open,
  onOpenChange,
  people,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  people?: ComboboxOption[];
}) {
  const forSomeone = people !== undefined;
  const form = useLeaveRequestForm({ onDone: () => onOpenChange(false), forSomeone });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{forSomeone ? 'Record leave' : 'Request leave'}</DialogTitle>
          <DialogDescription>
            {forSomeone
              ? 'Leave you record for someone is approved straight away and shows as LEAVE in attendance.'
              : 'HR reviews your request. Once approved, the days show as leave in attendance.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.submit();
          }}
        >
          {people ? (
            <div className="space-y-1.5">
              <Label htmlFor="leave-person">Person</Label>
              <Combobox
                id="leave-person"
                options={people}
                value={form.forUserId}
                onChange={form.setForUserId}
                placeholder="Choose a person"
                searchPlaceholder="Search people…"
                emptyText="No one matches."
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="leave-type">Type</Label>
            <Select value={form.type} onValueChange={(v) => form.setType(LeaveType.parse(v))}>
              <SelectTrigger id="leave-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LeaveType.options.map((t) => (
                  <SelectItem key={t} value={t}>
                    {LEAVE_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="leave-start">First day</Label>
              <DatePicker id="leave-start" value={form.start} onChange={form.setStart} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="leave-end">Last day</Label>
              <DatePicker id="leave-end" value={form.end} onChange={form.setEnd} />
            </div>
          </div>
          {form.endBeforeStart ? (
            <p className="text-state-error text-xs" role="alert">
              The last day must be on or after the first day.
            </p>
          ) : form.days !== null ? (
            <p className="text-ink-muted text-xs">
              {form.days === 1 ? '1 day' : `${form.days} days`}, weekends included.
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="leave-reason">Reason (optional)</Label>
            <Textarea
              id="leave-reason"
              value={form.reason}
              onChange={(e) => form.setReason(e.target.value)}
              maxLength={form.reasonMax}
              placeholder={forSomeone ? 'For example: called in sick' : 'Anything HR should know'}
              className="min-h-[80px]"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!form.canSubmit || form.pending}>
              {form.pending ? 'Sending…' : forSomeone ? 'Record leave' : 'Send request'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
