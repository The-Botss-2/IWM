'use client';

import { ArrowLeft, Download, Plus, Send, Trash2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  computeInvoiceTotals,
  type CreateInvoiceInput,
  type InvoicePreviewInput,
  type InvoiceWithItems,
} from '@botss/shared-types';

import { InvoiceStatusMenu } from '@/components/financials/invoice-status-menu';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader, PageLoader } from '@/components/ui/loader';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced';
import { useHasOpened } from '@/hooks/use-has-opened';
import { useFinanceClientPicker, useFinanceProjectPicker } from '@/hooks/use-finance';
import {
  useCreateInvoice,
  useDeleteInvoice,
  useInvoice,
  useInvoicePdf,
  useInvoicePreview,
  useInvoiceSettings,
  useInvoiceTemplates,
  useUpdateInvoice,
} from '@/hooks/use-invoices';
import { CURRENCY_OPTIONS, formatCurrency } from '@/lib/money';
import { downloadInvoicePdf } from '@/lib/download-url';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

// Loaded on first open - most visits to the editor never send.
const SendInvoiceDialog = dynamic(
  () =>
    import('@/components/financials/send-invoice-dialog').then((m) => ({
      default: m.SendInvoiceDialog,
    })),
  { ssr: false },
);

export interface InvoiceEditorPrefill {
  clientId?: string | null;
  projectId?: string | null;
  contractId?: string | null;
  milestoneId?: string | null;
  currency?: string | null;
  description?: string | null;
  amount?: string | null;
}

interface LineDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  discountRate: string;
}

let lineSeq = 0;
function newLine(partial: Partial<LineDraft> = {}): LineDraft {
  lineSeq += 1;
  return {
    key: `line-${lineSeq}`,
    description: '',
    quantity: '1',
    unitPrice: '',
    taxRate: '0',
    discountRate: '0',
    ...partial,
  };
}

const DEFAULT_TEMPLATE = '__default__';

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * Create or edit an invoice with a live preview rendered by the server through
 * the chosen HTML template, so what you see is exactly what the PDF prints.
 * Only DRAFT invoices can be edited; sent ones open read-only.
 */
export function InvoiceEditor({
  invoiceId,
  prefill,
}: {
  invoiceId: string | null;
  prefill?: InvoiceEditorPrefill;
}) {
  const router = useRouter();
  const existing = useInvoice(invoiceId);
  const templates = useInvoiceTemplates();
  const settings = useInvoiceSettings();
  const clients = useFinanceClientPicker();
  const projects = useFinanceProjectPicker();
  const create = useCreateInvoice();
  const update = useUpdateInvoice();
  const remove = useDeleteInvoice();
  const pdf = useInvoicePdf();

  const [hydrated, setHydrated] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState<string>(DEFAULT_TEMPLATE);
  const [currency, setCurrency] = useState('USD');
  const [issuedAt, setIssuedAt] = useState<Date | null>(new Date());
  const [dueAt, setDueAt] = useState<Date | null>(addDays(new Date(), 14));
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [footer, setFooter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const sendDialogMounted = useHasOpened(sendOpen);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dirty, setDirty] = useState(false);

  const invoice: InvoiceWithItems | undefined = existing.data;
  const readOnly = !!invoice && invoice.status !== 'DRAFT';

  // Hydrate once: from the saved invoice, or from defaults plus prefill.
  useEffect(() => {
    if (hydrated) return;
    if (invoiceId) {
      if (!invoice) return;
      setClientId(invoice.clientId);
      setProjectId(invoice.projectId);
      setTemplateKey(invoice.templateKey ?? DEFAULT_TEMPLATE);
      setCurrency(invoice.currency);
      setIssuedAt(new Date(invoice.issuedAt));
      setDueAt(new Date(invoice.dueAt));
      setLines(
        invoice.lineItems.length > 0
          ? invoice.lineItems.map((li) =>
              newLine({
                description: li.description,
                quantity: li.quantity,
                unitPrice: li.unitPrice,
                taxRate: li.taxRate,
                discountRate: li.discountRate,
              }),
            )
          : [newLine()],
      );
      setNotes(invoice.notes ?? '');
      setTerms(invoice.terms ?? '');
      setFooter(invoice.footer ?? '');
      setHydrated(true);
      return;
    }
    if (settings.isLoading) return;
    const s = settings.data;
    setClientId(prefill?.clientId ?? null);
    setProjectId(prefill?.projectId ?? null);
    setCurrency(prefill?.currency ?? s?.defaultCurrency ?? 'USD');
    setDueAt(addDays(new Date(), s?.defaultDueDays ?? 14));
    if (prefill?.description || prefill?.amount) {
      setLines([
        newLine({ description: prefill.description ?? '', unitPrice: prefill.amount ?? '' }),
      ]);
    }
    setHydrated(true);
  }, [hydrated, invoiceId, invoice, settings.isLoading, settings.data, prefill]);

  const markDirty =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setDirty(true);
    };

  const totals = useMemo(() => computeInvoiceTotals(lines), [lines]);

  const previewInput: InvoicePreviewInput = useMemo(
    () => ({
      ...(invoiceId ? { invoiceId } : {}),
      ...(templateKey !== DEFAULT_TEMPLATE ? { templateKey } : {}),
      ...(clientId ? { clientId } : {}),
      projectId,
      currency,
      ...(issuedAt ? { issuedAt } : {}),
      ...(dueAt ? { dueAt } : {}),
      lineItems: lines
        .filter((l) => l.description.trim().length > 0)
        .map((l) => ({
          description: l.description,
          quantity: l.quantity || '1',
          unitPrice: l.unitPrice || '0',
          taxRate: l.taxRate || '0',
          discountRate: l.discountRate || '0',
        })),
      notes: notes.trim() ? notes : null,
      terms: terms.trim() ? terms : null,
      footer: footer.trim() ? footer : null,
    }),
    [
      invoiceId,
      templateKey,
      clientId,
      projectId,
      currency,
      issuedAt,
      dueAt,
      lines,
      notes,
      terms,
      footer,
    ],
  );
  const debouncedPreviewInput = useDebouncedValue(previewInput, 400);
  const preview = useInvoicePreview(debouncedPreviewInput, hydrated);

  const clientOptions = useMemo(
    () => (clients.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
    [clients.data],
  );
  const projectOptions = useMemo(
    () =>
      (projects.data?.items ?? []).map((p) => ({ value: p.id, label: p.name, description: p.key })),
    [projects.data],
  );
  const selectedClient = clients.data?.items.find((c) => c.id === clientId) ?? null;

  function onPickProject(next: string | null) {
    setProjectId(next);
    setDirty(true);
    const picked = projects.data?.items.find((p) => p.id === next);
    if (picked?.clientId && !clientId) setClientId(picked.clientId);
  }

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  }

  function buildPayload(): CreateInvoiceInput | null {
    setError(null);
    if (!clientId) {
      setError('Pick the client this invoice is for.');
      return null;
    }
    if (!dueAt) {
      setError('Set a due date.');
      return null;
    }
    const filled = lines.filter((l) => l.description.trim().length > 0);
    if (filled.length === 0) {
      setError('Add at least one line item with a description.');
      return null;
    }
    return {
      clientId,
      ...(projectId ? { projectId } : {}),
      ...(prefill?.contractId ? { contractId: prefill.contractId } : {}),
      ...(prefill?.milestoneId ? { milestoneId: prefill.milestoneId } : {}),
      currency,
      ...(issuedAt ? { issuedAt } : {}),
      dueAt,
      lineItems: filled.map((l) => ({
        description: l.description.trim(),
        quantity: l.quantity || '1',
        unitPrice: l.unitPrice || '0',
        taxRate: l.taxRate || '0',
        discountRate: l.discountRate || '0',
      })),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(terms.trim() ? { terms: terms.trim() } : {}),
      ...(footer.trim() ? { footer: footer.trim() } : {}),
      ...(templateKey !== DEFAULT_TEMPLATE ? { templateKey } : {}),
    };
  }

  /** Save and return the invoice id, or null when validation failed. */
  async function save(): Promise<string | null> {
    const payload = buildPayload();
    if (!payload) return null;
    try {
      if (invoiceId) {
        await update.mutateAsync({
          id: invoiceId,
          input: {
            ...payload,
            projectId: projectId ?? null,
            notes: notes.trim() ? notes.trim() : null,
            terms: terms.trim() ? terms.trim() : null,
            footer: footer.trim() ? footer.trim() : null,
            templateKey: templateKey === DEFAULT_TEMPLATE ? null : templateKey,
          },
        });
        setDirty(false);
        toast.success('Invoice saved.');
        return invoiceId;
      }
      const created = await create.mutateAsync(payload);
      setDirty(false);
      toast.success(`Invoice ${created.number} created.`);
      router.replace(`/financials/invoices/${created.id}`);
      return created.id;
    } catch {
      return null;
    }
  }

  async function download() {
    let id = invoiceId;
    if (!id || (dirty && !readOnly)) id = await save();
    if (!id) return;
    // useInvoicePdf's meta.errorTitle toasts a failed render; nothing more to do.
    const result = await pdf.mutateAsync(id).catch(() => null);
    if (result) await downloadInvoicePdf(result.url, result.filename);
  }

  async function openSend() {
    if (!invoiceId || (dirty && !readOnly)) {
      const id = await save();
      if (!id) return;
      if (!invoiceId) return; // navigating to the saved invoice; send from there
    }
    setSendOpen(true);
  }

  if (invoiceId && existing.isLoading) return <PageLoader label="Loading invoice" />;
  if (invoiceId && existing.isError) {
    return (
      <div className="text-ink-muted mx-auto max-w-lg p-8 text-center text-sm">
        Couldn&apos;t load this invoice.{' '}
        <Link href="/financials?tab=invoices" className="underline">
          Back to invoices
        </Link>
      </div>
    );
  }

  const busy = create.isPending || update.isPending;
  const templateItems = templates.data?.items ?? [];

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="icon" aria-label="Back to invoices">
            <Link href="/financials?tab=invoices">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="text-ink truncate text-xl font-semibold">
              {invoice ? invoice.number : 'New invoice'}
            </h1>
            <p className="text-ink-muted text-xs">
              {invoice ? statusLabel(invoice.status) : 'Draft, not saved yet'}
              {dirty && !readOnly ? ' · Unsaved changes' : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {invoice && !dirty ? <InvoiceStatusMenu invoice={invoice} /> : null}
          {invoice && invoice.status === 'DRAFT' ? (
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              disabled={remove.isPending}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => void download()}
            disabled={pdf.isPending || busy}
          >
            {pdf.isPending ? (
              <Loader size="xs" label="Generating PDF" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download PDF
          </Button>
          <Button variant="secondary" onClick={() => void openSend()} disabled={busy || !clientId}>
            <Send className="h-4 w-4" />{' '}
            {invoice && invoice.status !== 'DRAFT' ? 'Send again' : 'Send'}
          </Button>
          {!readOnly ? (
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving' : invoiceId ? 'Save' : 'Create invoice'}
            </Button>
          ) : null}
        </div>
      </header>

      {readOnly ? (
        <div className="border-line bg-bg-subtle text-ink-muted rounded-md border px-4 py-3 text-sm">
          This invoice has been sent, so its contents are locked. Record payments from the Payments
          tab, or cancel it and raise a new one to change it.
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <fieldset disabled={readOnly} className="min-w-0 space-y-5">
          <section className="border-line bg-bg-surface space-y-4 rounded-lg border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Client">
                <Combobox
                  options={clientOptions}
                  value={clientId}
                  onChange={markDirty(setClientId)}
                  placeholder="Select a client"
                  disabled={readOnly}
                />
              </Field>
              <Field label="Project">
                <Combobox
                  options={projectOptions}
                  value={projectId}
                  onChange={onPickProject}
                  placeholder="Optional"
                  clearable
                  disabled={readOnly}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Issued">
                <DatePicker
                  value={issuedAt}
                  onChange={markDirty(setIssuedAt)}
                  disabled={readOnly}
                />
              </Field>
              <Field label="Due">
                <DatePicker value={dueAt} onChange={markDirty(setDueAt)} disabled={readOnly} />
              </Field>
              <Field label="Currency">
                <Select value={currency} onValueChange={markDirty(setCurrency)} disabled={readOnly}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCY_OPTIONS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field label="Template">
              <Select
                value={templateKey}
                onValueChange={markDirty(setTemplateKey)}
                disabled={readOnly}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_TEMPLATE}>
                    Organization default
                    {templates.data
                      ? ` (${templateName(templateItems, templates.data.defaultKey)})`
                      : ''}
                  </SelectItem>
                  {templateItems.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </section>

          <section className="border-line bg-bg-surface space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-ink text-sm font-semibold">Line items</h2>
              <span className="text-ink-muted text-xs">Tax and discount are percentages</span>
            </div>
            <div className="space-y-3">
              {lines.map((line, index) => (
                <div key={line.key} className="border-line rounded-md border p-3">
                  <div className="flex items-start gap-2">
                    <Textarea
                      aria-label={`Line ${index + 1} description`}
                      rows={2}
                      className="min-h-[2.75rem] flex-1 resize-y"
                      value={line.description}
                      onChange={(e) => updateLine(line.key, { description: e.target.value })}
                      placeholder="What was delivered"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() => {
                        setLines((prev) =>
                          prev.length === 1 ? [newLine()] : prev.filter((l) => l.key !== line.key),
                        );
                        setDirty(true);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <NumberField
                      label="Qty"
                      value={line.quantity}
                      onChange={(v) => updateLine(line.key, { quantity: v })}
                    />
                    <NumberField
                      label="Unit price"
                      value={line.unitPrice}
                      onChange={(v) => updateLine(line.key, { unitPrice: v })}
                      placeholder="0.00"
                    />
                    <NumberField
                      label="Tax %"
                      value={line.taxRate}
                      onChange={(v) => updateLine(line.key, { taxRate: v })}
                    />
                    <NumberField
                      label="Discount %"
                      value={line.discountRate}
                      onChange={(v) => updateLine(line.key, { discountRate: v })}
                    />
                    <div className="col-span-2 flex flex-col justify-end sm:col-span-1">
                      <span className="text-ink-muted text-xs">Amount</span>
                      <span className="text-ink truncate text-sm font-semibold tabular-nums">
                        {formatCurrency(totals.lines[index] ?? '0', currency)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {!readOnly ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setLines((prev) => [...prev, newLine()]);
                  setDirty(true);
                }}
              >
                <Plus className="h-4 w-4" /> Add line
              </Button>
            ) : null}

            <dl className="border-line ml-auto grid w-full max-w-xs grid-cols-2 gap-y-1 border-t pt-3 text-sm">
              <dt className="text-ink-muted">Subtotal</dt>
              <dd className="text-right tabular-nums">
                {formatCurrency(totals.subtotal, currency)}
              </dd>
              {Number(totals.discount) > 0 ? (
                <>
                  <dt className="text-ink-muted">Discount</dt>
                  <dd className="text-right tabular-nums">
                    -{formatCurrency(totals.discount, currency)}
                  </dd>
                </>
              ) : null}
              {Number(totals.tax) > 0 ? (
                <>
                  <dt className="text-ink-muted">Tax</dt>
                  <dd className="text-right tabular-nums">
                    {formatCurrency(totals.tax, currency)}
                  </dd>
                </>
              ) : null}
              <dt className="text-ink font-semibold">Total</dt>
              <dd className="text-ink text-right font-semibold tabular-nums">
                {formatCurrency(totals.total, currency)}
              </dd>
            </dl>
          </section>

          <section className="border-line bg-bg-surface space-y-4 rounded-lg border p-4">
            <Field label="Notes">
              <Textarea
                rows={3}
                value={notes}
                onChange={(e) => markDirty(setNotes)(e.target.value)}
                placeholder="Shown on the invoice, e.g. a thank-you or a reference."
              />
            </Field>
            <Field label="Terms">
              <Textarea
                rows={2}
                value={terms}
                onChange={(e) => markDirty(setTerms)(e.target.value)}
                placeholder={
                  settings.data?.paymentTerms ?? 'Leave empty to use the organization terms.'
                }
              />
            </Field>
            <Field label="Footer">
              <Input
                value={footer}
                onChange={(e) => markDirty(setFooter)(e.target.value)}
                placeholder={settings.data?.footer ?? 'Leave empty to use the organization footer.'}
              />
            </Field>
            <p className="text-ink-muted text-xs">
              Company name, logo, address and bank details come from{' '}
              <Link href="/settings/invoicing" className="underline">
                invoice settings
              </Link>
              .
            </p>
          </section>

          {error ? <p className="text-state-error text-sm">{error}</p> : null}
        </fieldset>

        <section className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-ink text-sm font-semibold">Preview</h2>
            {preview.isFetching ? <Loader size="xs" label="Updating preview" /> : null}
          </div>
          <div
            className={cn(
              'border-line shadow-soft overflow-hidden rounded-lg border bg-white',
              preview.isError && 'border-state-error',
            )}
          >
            {preview.isError ? (
              <div className="text-state-error p-6 text-sm">
                Couldn&apos;t render the preview. Check the template, then try again.
              </div>
            ) : preview.data ? (
              <iframe
                title="Invoice preview"
                sandbox=""
                srcDoc={preview.data}
                className="block aspect-[210/297] w-full border-0 bg-white"
              />
            ) : (
              <PageLoader label="Rendering preview" className="aspect-[210/297] min-h-0" />
            )}
          </div>
        </section>
      </div>

      {invoice && sendDialogMounted ? (
        <SendInvoiceDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          invoice={invoice}
          clientEmail={selectedClient?.email ?? null}
          companyName={settings.data?.companyName ?? null}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this draft invoice?"
        description="The invoice number is not reused. This cannot be undone from here."
        confirmLabel="Delete"
        variant="destructive"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!invoiceId) return;
          try {
            await remove.mutateAsync(invoiceId);
            router.replace('/financials?tab=invoices');
          } catch {
            // Toast raised by the hook; stay on the invoice.
          }
        }}
      />
    </div>
  );
}

function templateName(items: { key: string; name: string }[], key: string): string {
  return items.find((t) => t.key === key)?.name ?? key;
}

function statusLabel(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-ink-muted text-xs">{label}</span>
      <Input
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
        className="tabular-nums"
      />
    </label>
  );
}
