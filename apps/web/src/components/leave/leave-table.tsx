import type { ReactNode } from 'react';
import type { LeaveWithRefs } from '@botss/shared-types';

import { LeaveStatusBadge } from '@/components/leave/leave-status-badge';
import { UserAvatar } from '@/components/ui/avatar';
import { formatLeaveRange, LEAVE_TYPE_LABELS, leaveDayCount } from '@/lib/leave';

/** Leave requests as a table. `showPerson` adds the requester column (HR view). */
export function LeaveTable({
  items,
  showPerson = false,
  renderActions,
}: {
  items: LeaveWithRefs[];
  showPerson?: boolean;
  renderActions: (leave: LeaveWithRefs) => ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl bg-white shadow-soft">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-bg-subtle text-left text-xs text-ink-muted">
            {showPerson ? <th className="px-3 py-2 font-medium">Person</th> : null}
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Dates</th>
            <th className="px-3 py-2 text-right font-medium">Days</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Decided by</th>
            <th className="px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((leave) => {
            const start = new Date(leave.startDate);
            const end = new Date(leave.endDate);
            const days = leaveDayCount(start, end);
            return (
              <tr key={leave.id} className="border-b border-line last:border-b-0 align-top">
                {showPerson ? (
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <UserAvatar size="xs" name={leave.user.name} image={leave.user.image} />
                      <span className="truncate text-ink">{leave.user.name}</span>
                    </div>
                  </td>
                ) : null}
                <td className="px-3 py-2.5 text-ink">
                  {LEAVE_TYPE_LABELS[leave.type]}
                  {leave.reason ? (
                    <p className="mt-0.5 max-w-[280px] whitespace-pre-line break-words text-xs text-ink-muted">
                      {leave.reason}
                    </p>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-ink">
                  {formatLeaveRange(start, end)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink">{days}</td>
                <td className="px-3 py-2.5">
                  <LeaveStatusBadge status={leave.status} />
                </td>
                <td className="px-3 py-2.5 text-ink-muted">
                  {leave.status === 'PENDING' ? '-' : (leave.approvedBy?.name ?? '-')}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-1.5">{renderActions(leave)}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
