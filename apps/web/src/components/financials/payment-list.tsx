'use client';

import { useState } from 'react';
import type { ContractMilestone, PaymentWithSource } from '@botss/shared-types';

import { RegionBadge } from '@/components/financials/finance-badges';
import { PaymentEditDialog } from '@/components/financials/payment-edit-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useFinanceBaseCurrency } from '@/hooks/use-client-billing';
import { useVoidPayment } from '@/hooks/use-finance';
import { useAbility } from '@/lib/ability';
import { formatCurrency } from '@/lib/money';

export function PaymentList({
  items,
  loading,
  showContract = true,
  milestones,
}: {
  items: PaymentWithSource[];
  loading?: boolean;
  showContract?: boolean;
  /** The contract's milestones, when every row belongs to one contract. */
  milestones?: ContractMilestone[];
}) {
  const [voiding, setVoiding] = useState<PaymentWithSource | null>(null);
  const [editing, setEditing] = useState<PaymentWithSource | null>(null);
  // Fetched here, not handed down, so the list and its edit dialog know the
  // base currency whichever page or tab renders them.
  const { baseCurrency } = useFinanceBaseCurrency();
  // Edit and void are both `update Payment` on the API; a finance viewer
  // sees the list without them.
  const canUpdate = useAbility().can('update', 'Payment');

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="border-line bg-bg-surface text-ink-muted rounded-md border border-dashed p-8 text-center text-sm">
        No payments recorded yet.
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-line text-ink-muted border-b text-left text-xs uppercase tracking-wide">
              <th className="px-3 py-2 font-medium">Date</th>
              {showContract ? <th className="px-3 py-2 font-medium">Contract</th> : null}
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Region</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 text-right font-medium">Fee</th>
              <th className="px-3 py-2 text-right font-medium">Net ({baseCurrency ?? 'base'})</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr
                key={p.id}
                className={`border-line hover:bg-bg-subtle border-b last:border-0 ${
                  p.voidedAt ? 'opacity-50' : ''
                }`}
              >
                <td className="whitespace-nowrap px-3 py-2">
                  {new Date(p.paidAt).toLocaleDateString()}
                </td>
                {showContract ? (
                  <td className="text-ink-muted px-3 py-2">
                    {p.contract?.title ?? '-'}
                    {p.milestone ? (
                      <span className="block text-xs">{p.milestone.title}</span>
                    ) : null}
                  </td>
                ) : null}
                <td className="text-ink-muted px-3 py-2">
                  {p.paymentSource?.name ?? 'Unattributed'}
                </td>
                <td className="px-3 py-2">
                  <RegionBadge region={p.region} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatCurrency(p.amount, p.currency)}
                  {/* Only worth showing when the money landed as something
                      other than what the contract was billed in. */}
                  {p.receivedCurrency !== p.currency || p.receivedAmount !== p.amount ? (
                    <span className="text-ink-muted block text-xs">
                      got {formatCurrency(p.receivedAmount, p.receivedCurrency)}
                    </span>
                  ) : null}
                </td>
                <td className="text-ink-muted px-3 py-2 text-right tabular-nums">
                  {Number(p.feeAmount) > 0 ? formatCurrency(p.feeAmount, p.receivedCurrency) : '-'}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {baseCurrency ? formatCurrency(p.baseAmount, baseCurrency) : p.baseAmount}
                </td>
                <td className="px-3 py-2 text-right">
                  {p.voidedAt ? (
                    <Badge tone="neutral">Voided</Badge>
                  ) : canUpdate ? (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setVoiding(p)}>
                        Void
                      </Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden" role="list">
        {items.map((p) => (
          <li
            key={p.id}
            className={`border-line bg-bg-surface rounded-md border p-3 ${
              p.voidedAt ? 'opacity-50' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium tabular-nums">
                {formatCurrency(p.amount, p.currency)}
              </span>
              <span className="text-ink-muted text-xs">
                {new Date(p.paidAt).toLocaleDateString()}
              </span>
            </div>
            <p className="text-ink-muted mt-0.5 text-xs">
              {p.paymentSource?.name ?? 'Unattributed'}
              {p.contract ? ` · ${p.contract.title}` : ''}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <RegionBadge region={p.region} />
              {p.voidedAt ? <Badge tone="neutral">Voided</Badge> : null}
              <span className="text-ink-muted ml-auto text-xs tabular-nums">
                {baseCurrency ? formatCurrency(p.baseAmount, baseCurrency) : p.baseAmount}
              </span>
            </div>
            {!p.voidedAt && canUpdate ? (
              <div className="mt-2 flex justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setVoiding(p)}>
                  Void
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <VoidDialog payment={voiding} onClose={() => setVoiding(null)} />
      {editing ? (
        <PaymentEditDialog
          key={editing.id}
          payment={editing}
          onClose={() => setEditing(null)}
          {...(milestones ? { milestones } : {})}
        />
      ) : null}
    </>
  );
}

/**
 * Voiding needs a reason, and the reason is mandatory: a payment that vanishes
 * from the totals with no explanation is exactly the thing that makes finance
 * data untrustworthy six months later.
 */
function VoidDialog({
  payment,
  onClose,
}: {
  payment: PaymentWithSource | null;
  onClose: () => void;
}) {
  const voidPayment = useVoidPayment();
  const [reason, setReason] = useState('');

  async function submit() {
    if (!payment || !reason.trim()) return;
    try {
      await voidPayment.mutateAsync({ id: payment.id, input: { reason: reason.trim() } });
      setReason('');
      onClose();
    } catch {
      // Toast raised by the hook.
    }
  }

  return (
    <Dialog open={!!payment} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Void this payment</DialogTitle>
          <DialogDescription>
            The row stays on the record and the contract total is recalculated. Nothing is deleted.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="void-reason">Reason</Label>
          <Input
            id="void-reason"
            className="mt-1"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Entered twice by mistake"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={voidPayment.isPending || !reason.trim()}>
            {voidPayment.isPending ? 'Voiding…' : 'Void payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
