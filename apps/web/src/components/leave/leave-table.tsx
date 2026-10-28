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
    <div className="shadow-soft overflow-x-auto rounded-xl bg-white">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-line bg-bg-subtle text-ink-muted border-b text-left text-xs">
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
              <tr key={leave.id} className="border-line border-b align-top last:border-b-0">
                {showPerson ? (
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <UserAvatar size="xs" name={leave.user.name} image={leave.user.image} />
                      <span className="text-ink truncate">{leave.user.name}</span>
                    </div>
                  </td>
                ) : null}
                <td className="text-ink px-3 py-2.5">
                  {LEAVE_TYPE_LABELS[leave.type]}
                  {leave.reason ? (
                    <p className="text-ink-muted mt-0.5 max-w-[280px] whitespace-pre-line break-words text-xs">
                      {leave.reason}
                    </p>
                  ) : null}
                </td>
                <td className="text-ink whitespace-nowrap px-3 py-2.5">
                  {formatLeaveRange(start, end)}
                </td>
                <td className="text-ink px-3 py-2.5 text-right tabular-nums">{days}</td>
                <td className="px-3 py-2.5">
                  <LeaveStatusBadge status={leave.status} />
                </td>
                <td className="text-ink-muted px-3 py-2.5">
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
