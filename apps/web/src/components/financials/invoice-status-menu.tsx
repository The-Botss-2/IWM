'use client';

import { Ban, CheckCircle2, ChevronDown, Undo2, Send } from 'lucide-react';
import { useState } from 'react';
import { type Invoice, isRateText } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { BaseCurrencyNotice } from '@/components/financials/base-currency-notice';
import { useFinanceBaseCurrency } from '@/hooks/use-client-billing';
import { useRecordInvoicePayment, useSetInvoiceStatus } from '@/hooks/use-invoices';
import {
  invoiceBalance,
  invoiceStatusActions,
  type InvoiceStatusAction,
} from '@/lib/invoice-status';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

type MenuInvoice = Pick<
  Invoice,
  'id' | 'number' | 'status' | 'total' | 'amountPaid' | 'currency' | 'contractId'
>;

const ACTION_META: Record<InvoiceStatusAction, { label: string; icon: typeof Send }> = {
  'mark-sent': { label: 'Mark as sent', icon: Send },
  'mark-paid': { label: 'Mark as paid', icon: CheckCircle2 },
  'back-to-draft': { label: 'Back to draft', icon: Undo2 },
  cancel: { label: 'Cancel invoice', icon: Ban },
};

/**
 * Status actions for one invoice: a small menu plus the confirm / payment
 * dialogs behind it. Renders nothing when no action applies (paid, cancelled).
 */
export function InvoiceStatusMenu({
  invoice,
  size = 'md',
  className,
}: {
  invoice: MenuInvoice;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPendingAction] = useState<InvoiceStatusAction | null>(null);
  const setStatus = useSetInvoiceStatus();
  const actions = invoiceStatusActions(invoice);
  if (actions.length === 0) return null;

  const choose = (action: InvoiceStatusAction) => {
    setMenuOpen(false);
    if (action === 'mark-sent') {
      setStatus.mutate({ id: invoice.id, input: { status: 'SENT' } });
      return;
    }
    setPendingAction(action);
  };

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="secondary"
            size={size === 'sm' ? 'sm' : 'md'}
            className={cn('whitespace-nowrap', className)}
            disabled={setStatus.isPending}
            aria-label={`Change status of ${invoice.number}`}
          >
            Status <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-max min-w-[11rem] p-1">
          {actions.map((action) => {
            const { label, icon: Icon } = ACTION_META[action];
            return (
              <button
                key={action}
                type="button"
                onClick={() => choose(action)}
                className={cn(
                  'flex w-full items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm hover:bg-bg-subtle',
                  action === 'cancel' ? 'text-[#E5484D]' : 'text-ink',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" /> {label}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

      <ConfirmDialog
        open={pending === 'cancel' || pending === 'back-to-draft'}
        onOpenChange={(open) => !open && setPendingAction(null)}
        title={pending === 'cancel' ? `Cancel ${invoice.number}?` : `Move ${invoice.number} back to draft?`}
        description={
          pending === 'cancel'
            ? 'A cancelled invoice cannot be sent or paid. Raise a new invoice if you need one.'
            : 'It becomes editable again. The client may already have the sent copy.'
        }
        confirmLabel={pending === 'cancel' ? 'Cancel invoice' : 'Back to draft'}
        cancelLabel="Keep as is"
        variant={pending === 'cancel' ? 'destructive' : 'primary'}
        pending={setStatus.isPending}
        onConfirm={async () => {
          await setStatus.mutateAsync({
            id: invoice.id,
            input: { status: pending === 'cancel' ? 'CANCELLED' : 'DRAFT' },
          });
          setPendingAction(null);
        }}
      />

      {pending === 'mark-paid' ? (
        <MarkPaidDialog invoice={invoice} onClose={() => setPendingAction(null)} />
      ) : null}
    </>
  );
}

function MarkPaidDialog({ invoice, onClose }: { invoice: MenuInvoice; onClose: () => void }) {
  const balance = invoiceBalance(invoice);
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [paidAt, setPaidAt] = useState<Date | null>(new Date());
  const [reference, setReference] = useState('');
  const [fxRate, setFxRate] = useState('');
  const record = useRecordInvoicePayment();
  const base = useFinanceBaseCurrency();
  const { baseCurrency } = base;
  // Dashboards sum the base-currency figure, so a foreign-currency payment
  // needs its rate. The API falls back to a linked contract's rate.
  // Unknown base currency (loading or failed): wait rather than guess.
  const needsRate = baseCurrency !== null && invoice.currency !== baseCurrency;
  const rateRequired = needsRate && !invoice.contractId;
  const valid =
    baseCurrency !== null &&
    Number(amount) > 0 &&
    (!needsRate || (fxRate === '' ? !rateRequired : isRateText(fxRate)));

  const submit = async () => {
    if (!valid) return;
    try {
      await record.mutateAsync({
        id: invoice.id,
        input: {
          amount,
          ...(needsRate && fxRate !== ''
            ? { fxRate, receivedCurrency: invoice.currency }
            : {}),
          ...(paidAt ? { paidAt } : {}),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
      });
      onClose();
    } catch {
      // toast shown by the hook
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {invoice.number} as paid</DialogTitle>
          <DialogDescription>
            Records a payment of the amount received. Balance due:{' '}
            {formatCurrency(balance.toFixed(2), invoice.currency)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mark-paid-amount">Amount ({invoice.currency})</Label>
            <Input
              id="mark-paid-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          {needsRate ? (
            <div className="space-y-1.5">
              <Label htmlFor="mark-paid-fx">
                Exchange rate, 1 {invoice.currency} = ? {baseCurrency}
              </Label>
              <Input
                id="mark-paid-fx"
                inputMode="decimal"
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
                placeholder={rateRequired ? 'Required' : "Leave blank to use the contract's rate"}
              />
            </div>
          ) : null}
          <BaseCurrencyNotice base={base} />
          <div className="space-y-1.5">
            <Label htmlFor="mark-paid-date">Paid on</Label>
            <DatePicker id="mark-paid-date" value={paidAt} onChange={setPaidAt} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mark-paid-ref">Reference (optional)</Label>
            <Input
              id="mark-paid-ref"
              value={reference}
              maxLength={200}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Bank ref, transaction ID…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={record.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || record.isPending}>
            {record.isPending ? 'Saving…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
