'use client';

import { Mail, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ComposePrefill } from '@/components/mail/compose-mail-dialog';
import type { InvoiceWithItems } from '@botss/shared-types';

import { ComposeMailDialog } from '@/components/mail/compose-mail-dialog';
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
import { Loader } from '@/components/ui/loader';
import { Textarea } from '@/components/ui/textarea';
import { useInvoicePdf, useSendInvoice } from '@/hooks/use-invoices';
import { useMailAccounts } from '@/hooks/use-mail-accounts';
import { getApi } from '@/lib/api';
import { formatCurrency } from '@/lib/money';
import { toast, toastError, toastErrorMessage } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Via = 'mailbox' | 'system';

/**
 * Two ways to send an invoice:
 *
 * - From your mailbox (preferred when you have one): opens the normal compose
 *   window with the PDF already attached, so the client sees your address and
 *   the email sits in your Sent folder.
 * - From the no-reply address: the server emails the PDF itself, with replies
 *   going to the billing email in invoice settings.
 */
export function SendInvoiceDialog({
  open,
  onOpenChange,
  invoice,
  clientEmail,
  companyName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithItems;
  clientEmail: string | null;
  companyName: string | null;
}) {
  const accounts = useMailAccounts();
  const activeAccount = useMemo(
    () => (accounts.data?.items ?? []).find((a) => a.status === 'ACTIVE') ?? null,
    [accounts.data],
  );
  const pdf = useInvoicePdf();
  const send = useSendInvoice();

  const [via, setVia] = useState<Via>('mailbox');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [compose, setCompose] = useState<ComposePrefill | null>(null);
  const [preparing, setPreparing] = useState(false);

  const balance = (Number(invoice.total) - Number(invoice.amountPaid)).toFixed(2);
  const from = companyName?.trim() || 'The Botss';

  useEffect(() => {
    if (!open) return;
    setVia(activeAccount ? 'mailbox' : 'system');
    setTo(clientEmail ?? '');
    setSubject(`Invoice ${invoice.number} from ${from}`);
    setMessage(
      `Hello,\n\nPlease find invoice ${invoice.number} for ${formatCurrency(balance, invoice.currency)} attached.` +
        `\n\nThank you,\n${from}`,
    );
  }, [open, activeAccount, clientEmail, invoice.number, invoice.currency, balance, from]);

  const recipients = to
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  async function continueWithMailbox() {
    if (!activeAccount) return;
    setPreparing(true);
    try {
      const rendered = await pdf.mutateAsync(invoice.id);
      const file = await getApi().files.get(rendered.fileId);
      setCompose({
        to: recipients.join(', '),
        subject,
        body: message,
        attachments: [file],
      });
      onOpenChange(false);
    } catch (err) {
      toastError(err, "Couldn't prepare the invoice PDF");
    } finally {
      setPreparing(false);
    }
  }

  async function sendFromSystem() {
    if (recipients.length === 0) {
      toastErrorMessage('Add the client email address');
      return;
    }
    try {
      await send.mutateAsync({
        id: invoice.id,
        input: { via: 'system', to: recipients, subject, message },
      });
      toast.success('Invoice queued. It is marked sent once the email goes out.');
      onOpenChange(false);
    } catch {
      // toast shown by the hook
    }
  }

  const busy = preparing || pdf.isPending || send.isPending;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send {invoice.number}</DialogTitle>
            <DialogDescription>The PDF is attached automatically.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Send from">
            <ViaOption
              selected={via === 'mailbox'}
              disabled={!activeAccount}
              onSelect={() => setVia('mailbox')}
              icon={<Mail className="h-4 w-4" />}
              title="My mailbox"
              detail={activeAccount ? activeAccount.email : 'Connect a mailbox in Mail settings'}
            />
            <ViaOption
              selected={via === 'system'}
              onSelect={() => setVia('system')}
              icon={<Send className="h-4 w-4" />}
              title="No-reply address"
              detail="Replies go to your billing email"
            />
          </div>

          <div className="space-y-3">
            <div>
              <Label htmlFor="invoice-to">To</Label>
              <Input
                id="invoice-to"
                className="mt-1"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="billing@client.com"
              />
            </div>
            <div>
              <Label htmlFor="invoice-subject">Subject</Label>
              <Input
                id="invoice-subject"
                className="mt-1"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="invoice-message">Message</Label>
              <Textarea
                id="invoice-message"
                className="mt-1"
                rows={5}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            {via === 'mailbox' ? (
              <Button onClick={() => void continueWithMailbox()} disabled={busy || !activeAccount}>
                {busy ? <Loader size="xs" label="Preparing PDF" /> : null}
                Review in compose
              </Button>
            ) : (
              <Button onClick={() => void sendFromSystem()} disabled={busy}>
                {busy ? <Loader size="xs" label="Sending" /> : null}
                Send invoice
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeAccount ? (
        <ComposeMailDialog
          open={compose !== null}
          onOpenChange={(next) => {
            if (!next) setCompose(null);
          }}
          accountId={activeAccount.id}
          fromLabel={activeAccount.email}
          prefill={compose}
          onSent={() => {
            send.mutate({ id: invoice.id, input: { via: 'mailbox' } });
          }}
        />
      ) : null}
    </>
  );
}

function ViaOption({
  selected,
  disabled,
  onSelect,
  icon,
  title,
  detail,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
        selected ? 'border-brand-purple bg-brand-50/60' : 'border-line hover:border-line-strong',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium text-ink">
        {icon}
        {title}
      </span>
      <span className="w-full truncate text-xs text-ink-muted">{detail}</span>
    </button>
  );
}
