'use client';

import { CalendarCheck, Check, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { LeaveWithRefs } from '@botss/shared-types';

import { LeaveTable } from '@/components/leave/leave-table';
import { RequestLeaveDialog } from '@/components/leave/request-leave-dialog';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLeaveReview, type LeaveStatusFilter } from '@/hooks/use-leaves';
import { usePermissions } from '@/hooks/use-permissions';
import { formatLeaveRange } from '@/lib/leave';

const STATUS_FILTERS: ReadonlyArray<{ value: LeaveStatusFilter; label: string }> = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ALL', label: 'All statuses' },
];

/**
 * HR review of leave requests in the organization. The /admin layout admits
 * HR; deciding needs `hr.leave.approve`, which the server enforces (and it
 * refuses anyone deciding their own request).
 */
export default function AdminLeavesPage() {
  const perms = usePermissions();
  if (perms.checking) return <Loader size="sm" label="Loading leave requests" />;
  if (!perms.has('hr.leave.approve')) {
    return (
      <div className="rounded-xl bg-white px-4 py-12 text-center shadow-soft">
        <p className="text-sm text-ink">Only people who can approve leave see this page.</p>
        <p className="mt-1 text-xs text-ink-muted">
          Ask an admin for the Approve leave permission.
        </p>
      </div>
    );
  }
  return <LeaveReview />;
}

function LeaveReview() {
  const review = useLeaveReview();
  const [recordOpen, setRecordOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LeaveWithRefs | null>(null);
  const items = review.leaves.data?.items ?? [];
  const filtered = review.status !== 'ALL' || review.userId !== null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Leave requests</h2>
          <p className="text-sm text-ink-muted">
            Approve or reject time off. Approved days show as leave in attendance.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="secondary">
            <Link href="/admin/attendance">
              <CalendarCheck className="h-4 w-4" />
              Attendance
            </Link>
          </Button>
          <Button onClick={() => setRecordOpen(true)}>
            <Plus className="h-4 w-4" />
            Record leave
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44 space-y-1.5">
          <Label htmlFor="leave-status-filter">Status</Label>
          <Select
            value={review.status}
            onValueChange={(v) =>
              review.setStatus(STATUS_FILTERS.find((f) => f.value === v)?.value ?? 'PENDING')
            }
          >
            <SelectTrigger id="leave-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-64 space-y-1.5">
          <Label htmlFor="leave-person-filter">Person</Label>
          <Combobox
            id="leave-person-filter"
            options={review.people}
            value={review.userId}
            onChange={review.setUserId}
            placeholder="Everyone"
            searchPlaceholder="Search people…"
            emptyText="No one matches."
            clearable
            clearLabel="Everyone"
          />
        </div>
      </div>

      {review.leaves.isError && !review.leaves.data ? (
        <QueryError
          message="Couldn't load leave requests."
          onRetry={() => void review.leaves.refetch()}
        />
      ) : review.leaves.isPending ? (
        <div className="rounded-xl bg-white py-12 shadow-soft">
          <Loader size="sm" label="Loading leave requests" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl bg-white px-4 py-12 text-center shadow-soft">
          <p className="text-sm text-ink">
            {review.status === 'PENDING' && review.userId === null
              ? 'No requests waiting for a decision.'
              : 'No leave requests match these filters.'}
          </p>
          {filtered ? (
            <p className="mt-1 text-xs text-ink-muted">
              Change the filters to see other requests.
            </p>
          ) : null}
        </div>
      ) : (
        <LeaveTable
          items={items}
          showPerson
          renderActions={(leave) => (
            <>
              {review.canDecide(leave) ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={review.isBusy(leave)}
                    onClick={() => review.approve(leave)}
                  >
                    <Check className="h-3.5 w-3.5" />
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={review.isBusy(leave)}
                    onClick={() => review.reject(leave)}
                  >
                    <X className="h-3.5 w-3.5" />
                    Reject
                  </Button>
                </>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Delete ${leave.user.name}'s leave request`}
                title="Delete"
                disabled={review.isBusy(leave)}
                onClick={() => setDeleteTarget(leave)}
                className="w-8 px-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        />
      )}

      <RequestLeaveDialog open={recordOpen} onOpenChange={setRecordOpen} people={review.people} />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete this leave request?"
        description={
          deleteTarget
            ? `${deleteTarget.user.name}'s request for ${formatLeaveRange(new Date(deleteTarget.startDate), new Date(deleteTarget.endDate))} is removed for good.${deleteTarget.status === 'APPROVED' ? ' Attendance for those days is recalculated.' : ''}`
            : undefined
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) review.remove(deleteTarget);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
