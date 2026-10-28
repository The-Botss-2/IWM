'use client';

import Link from 'next/link';
import type { ContractListItem } from '@botss/shared-types';

import {
  ContractStatusBadge,
  PaymentStatusBadge,
  billingModelLabel,
} from '@/components/financials/finance-badges';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/money';

/**
 * Hand-rolled table + a stacked card list under `md`, matching the clients and
 * leads surfaces. Money columns are `tabular-nums` and right-aligned so
 * digits line up down the column - a finance manager scans these vertically.
 */
export function ContractList({ items, loading }: { items: ContractListItem[]; loading?: boolean }) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="border-line bg-bg-surface text-ink-muted rounded-md border border-dashed p-8 text-center text-sm">
        No contracts yet. Create one to start tracking what a client owes.
      </div>
    );
  }

  return (
    <>
      {/* Desktop */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-line text-ink-muted border-b text-left text-xs uppercase tracking-wide">
              <Th>Contract</Th>
              <Th>Project / client</Th>
              <Th>Model</Th>
              <Th align="right">Value</Th>
              <Th align="right">Received</Th>
              <Th align="right">Outstanding</Th>
              <Th>Payment</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => {
              const outstanding = Number(c.totalValue) - Number(c.amountPaid);
              return (
                <tr key={c.id} className="border-line hover:bg-bg-subtle border-b last:border-0">
                  <Td>
                    <Link href={`/financials/${c.id}`} className="font-medium hover:underline">
                      {c.title}
                    </Link>
                  </Td>
                  <Td className="text-ink-muted">
                    {c.project?.name ?? c.client?.name ?? '-'}
                    {c.project && c.client ? (
                      <span className="block text-xs">{c.client.name}</span>
                    ) : null}
                  </Td>
                  <Td className="text-ink-muted">
                    {billingModelLabel(c.billingModel)}
                    {c.milestoneCount > 0 ? (
                      <span className="text-xs"> · {c.milestoneCount}</span>
                    ) : null}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {formatCurrency(c.totalValue, c.currency)}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {formatCurrency(c.amountPaid, c.currency)}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {outstanding > 0 ? formatCurrency(outstanding, c.currency) : '-'}
                  </Td>
                  <Td>
                    <PaymentStatusBadge status={c.paymentStatus} />
                  </Td>
                  <Td>
                    <ContractStatusBadge status={c.status} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <ul className="space-y-2 md:hidden" role="list">
        {items.map((c) => {
          const outstanding = Number(c.totalValue) - Number(c.amountPaid);
          return (
            <li key={c.id} className="border-line bg-bg-surface rounded-md border p-3">
              <Link href={`/financials/${c.id}`} className="font-medium hover:underline">
                {c.title}
              </Link>
              <p className="text-ink-muted mt-0.5 text-xs">
                {c.project?.name ?? c.client?.name ?? '-'}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <PaymentStatusBadge status={c.paymentStatus} />
                <ContractStatusBadge status={c.status} />
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-ink-muted">Value</dt>
                  <dd className="tabular-nums">{formatCurrency(c.totalValue, c.currency)}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Received</dt>
                  <dd className="tabular-nums">{formatCurrency(c.amountPaid, c.currency)}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Outstanding</dt>
                  <dd className="tabular-nums">
                    {outstanding > 0 ? formatCurrency(outstanding, c.currency) : '-'}
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}>{children}</th>
  );
}

function Td({
  children,
  align = 'left',
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 ${align === 'right' ? 'text-right' : ''} ${className}`}>
      {children}
    </td>
  );
}
