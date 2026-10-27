import type { Invoice } from '@botss/shared-types';

export type InvoiceStatusAction = 'mark-sent' | 'mark-paid' | 'back-to-draft' | 'cancel';

type StatusFields = Pick<Invoice, 'status' | 'total' | 'amountPaid'>;

/** Amount still owed, never negative. */
export function invoiceBalance(invoice: Pick<Invoice, 'total' | 'amountPaid'>): number {
  return Math.max(0, Number(invoice.total) - Number(invoice.amountPaid));
}

/**
 * Status actions offered for an invoice. Mirrors the API's rules
 * (InvoicesService.setStatus): manual moves only while nothing is paid, and
 * paid states come from recording a payment. The server stays authoritative.
 */
export function invoiceStatusActions(invoice: StatusFields): InvoiceStatusAction[] {
  const unpaid = Number(invoice.amountPaid) <= 0;
  const owed = invoiceBalance(invoice) > 0;
  const actions: InvoiceStatusAction[] = [];
  switch (invoice.status) {
    case 'DRAFT':
      actions.push('mark-sent');
      break;
    case 'SENT':
    case 'OVERDUE':
      if (unpaid) actions.push('back-to-draft');
      break;
    default:
      break;
  }
  if (owed && invoice.status !== 'CANCELLED' && invoice.status !== 'REFUNDED') {
    actions.push('mark-paid');
  }
  if (unpaid && ['DRAFT', 'SENT', 'OVERDUE'].includes(invoice.status)) actions.push('cancel');
  return actions;
}
