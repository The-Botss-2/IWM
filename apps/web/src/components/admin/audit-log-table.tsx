'use client';

import type { AuditLogEntry } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import {
  formatAuditAction,
  formatAuditDetails,
  formatAuditTarget,
  isSecurityAlert,
} from '@/lib/audit-log-format';
import { absoluteTime, relativeTime } from '@/lib/time';

/**
 * Audit rows as a table: used by the organization's audit log and by the
 * SUPER_ADMIN platform log (which adds the Organization column). Ids are
 * never printed; see `lib/audit-log-format.ts`.
 */
export function AuditLogTable<T extends AuditLogEntry>({
  items,
  organizationName,
}: {
  items: readonly T[];
  /** When given, an Organization column shows this value per row. */
  organizationName?: (row: T) => string | null;
}) {
  return (
    <table className="w-full min-w-[640px] text-sm">
      <thead className="text-left text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        <tr>
          <th className="px-4 py-2">When</th>
          <th className="px-4 py-2">Actor</th>
          {organizationName ? <th className="px-4 py-2">Organization</th> : null}
          <th className="px-4 py-2">Action</th>
          <th className="px-4 py-2">Target</th>
          <th className="px-4 py-2">Details</th>
        </tr>
      </thead>
      <tbody>
        {items.map((row) => (
          <AuditRow
            key={row.id}
            row={row}
            organization={organizationName ? organizationName(row) : undefined}
          />
        ))}
      </tbody>
    </table>
  );
}

function AuditRow({
  row,
  organization,
}: {
  row: AuditLogEntry;
  /** `undefined` = no Organization column; `null` = column, name unknown. */
  organization: string | null | undefined;
}) {
  const target = formatAuditTarget(row);
  const details = formatAuditDetails(row);
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-3 text-xs text-ink-muted whitespace-nowrap">
        <span title={absoluteTime(row.createdAt)}>
          {relativeTime(row.createdAt)}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-ink">
        {row.actorUser ? (
          <div className="flex flex-col">
            <span className="font-medium">{row.actorUser.name}</span>
            <span className="text-[11px] text-ink-muted">{row.actorUser.email}</span>
          </div>
        ) : (
          <span className="italic text-ink-disabled">System</span>
        )}
      </td>
      {organization !== undefined ? (
        <td className="px-4 py-3 text-sm">
          {organization ?? (
            <span className="italic text-ink-disabled">Deleted organization</span>
          )}
        </td>
      ) : null}
      <td className="px-4 py-3">
        {isSecurityAlert(row.action) ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="danger">Alert</Badge>
            <span className="text-sm text-ink">{formatAuditAction(row.action)}</span>
          </div>
        ) : (
          <Badge tone="neutral">{row.action}</Badge>
        )}
      </td>
      <td className="px-4 py-3 text-sm">
        {target ? (
          <div className="flex flex-col">
            <span className="text-[11px] text-ink-muted">{target.kind}</span>
            <span className={target.resolved ? 'text-ink' : 'italic text-ink-disabled'}>
              {target.name}
            </span>
          </div>
        ) : (
          <span className="italic text-ink-disabled">-</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-ink-muted max-w-md">
        {details.length > 0 ? (
          <dl className="space-y-0.5">
            {details.map((d) => (
              <div key={d.key} className="flex gap-1.5">
                <dt className="shrink-0 text-ink-muted">{d.label}:</dt>
                <dd className="min-w-0 break-words text-ink">{d.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <span className="italic text-ink-disabled">-</span>
        )}
      </td>
    </tr>
  );
}
