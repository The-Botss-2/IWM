'use client';

import { ChevronLeft, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { LeaveWithRefs } from '@botss/shared-types';

import { LeaveTable } from '@/components/leave/leave-table';
import { RequestLeaveDialog } from '@/components/leave/request-leave-dialog';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useDeleteLeave, useMyLeaves } from '@/hooks/use-leaves';
import { formatLeaveRange } from '@/lib/leave';

/**
 * Employee time off: request leave, follow your requests, cancel one that
 * HR hasn't decided yet. The server scopes the list to the caller.
 */
export default function TimeOffPage() {
  const leaves = useMyLeaves();
  const remove = useDeleteLeave();
  const [requestOpen, setRequestOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<LeaveWithRefs | null>(null);

  const items = leaves.data?.items ?? [];

  return (
    <div className="mx-auto h-[var(--app-content-h,calc(100vh-4rem))] w-full max-w-5xl overflow-y-auto px-4 py-6 sm:px-6">
      <Link
        href="/timesheets"
        className="mb-3 inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        Timesheets
      </Link>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Time off</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            Request leave and follow what HR decides. Approved days show as leave in attendance.
          </p>
        </div>
        <Button onClick={() => setRequestOpen(true)}>
          <Plus className="h-4 w-4" />
          Request leave
        </Button>
      </header>

      <section aria-labelledby="my-requests-heading" className="space-y-3">
        <h2 id="my-requests-heading" className="text-base font-semibold text-ink">
          My requests
        </h2>
        {leaves.isError && !leaves.data ? (
          <QueryError
            message="Couldn't load your leave requests."
            onRetry={() => void leaves.refetch()}
          />
        ) : leaves.isPending ? (
          <div className="rounded-xl bg-white py-12 shadow-soft">
            <Loader size="sm" label="Loading leave requests" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl bg-white px-4 py-12 text-center shadow-soft">
            <p className="text-sm text-ink">No leave requests yet.</p>
            <p className="mt-1 text-xs text-ink-muted">
              Use Request leave to ask for time off.
            </p>
          </div>
        ) : (
          <LeaveTable
            items={items}
            renderActions={(leave) =>
              leave.status === 'PENDING' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setCancelTarget(leave)}
                >
                  Cancel
                </Button>
              ) : null
            }
          />
        )}
      </section>

      <RequestLeaveDialog open={requestOpen} onOpenChange={setRequestOpen} />

      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        title="Cancel this leave request?"
        description={
          cancelTarget
            ? `Your request for ${formatLeaveRange(new Date(cancelTarget.startDate), new Date(cancelTarget.endDate))} is withdrawn. You can send a new one any time.`
            : undefined
        }
        confirmLabel="Cancel request"
        cancelLabel="Keep it"
        variant="destructive"
        onConfirm={() => {
          if (cancelTarget) remove.mutate(cancelTarget.id);
          setCancelTarget(null);
        }}
      />
    </div>
  );
}
