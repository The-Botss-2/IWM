'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateInvoiceInput,
  InvoicePreviewInput,
  InvoiceSettings,
  ListInvoicesQuery,
  RecordPaymentInput,
  SendInvoiceInput,
  SetInvoiceStatusInput,
  UpdateInvoiceInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast } from '@/lib/toast';

const invoicesKey = (q?: Partial<ListInvoicesQuery>) => ['invoices', 'list', q ?? {}] as const;
const invoiceKey = (id: string) => ['invoices', 'detail', id] as const;
const invoiceTemplatesKey = ['invoices', 'templates'] as const;
const invoiceSettingsKey = ['invoices', 'settings'] as const;

export function useInvoices(q?: Partial<ListInvoicesQuery>) {
  return useQuery({
    queryKey: invoicesKey(q),
    queryFn: () => getApi().invoices.list({ page: 1, pageSize: 50, ...q }),
    staleTime: 30_000,
  });
}

export function useInvoice(id: string | null) {
  return useQuery({
    queryKey: invoiceKey(id ?? ''),
    queryFn: () => getApi().invoices.get(id as string),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useInvoiceTemplates() {
  return useQuery({
    queryKey: invoiceTemplatesKey,
    queryFn: () => getApi().invoices.templates(),
    staleTime: 300_000,
  });
}

export function useInvoiceSettings() {
  return useQuery({
    queryKey: invoiceSettingsKey,
    queryFn: () => getApi().invoices.settings(),
    staleTime: 300_000,
  });
}

/**
 * Server-rendered preview HTML for the editor. Keyed on the serialized draft,
 * so identical input reuses the last render instead of refetching.
 */
export function useInvoicePreview(input: InvoicePreviewInput, enabled: boolean) {
  return useQuery({
    queryKey: ['invoices', 'preview', JSON.stringify(input)],
    queryFn: () => getApi().invoices.preview(input),
    enabled,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    retry: false,
  });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvoiceInput) => getApi().invoices.create(input),
    onSuccess: (invoice) => {
      qc.setQueryData(invoiceKey(invoice.id), invoice);
      void qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
    },
    meta: { errorTitle: "Couldn't create the invoice" },
  });
}

export function useUpdateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateInvoiceInput }) =>
      getApi().invoices.update(id, input),
    onSuccess: (invoice) => {
      qc.setQueryData(invoiceKey(invoice.id), invoice);
      void qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
    },
    meta: { errorTitle: "Couldn't save the invoice" },
  });
}

export function useDeleteInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().invoices.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invoices', 'list'] }),
    meta: { successMessage: 'Invoice deleted.', errorTitle: "Couldn't delete the invoice" },
  });
}

export function useInvoicePdf() {
  return useMutation({
    mutationFn: (id: string) => getApi().invoices.pdf(id),
    meta: { errorTitle: "Couldn't generate the PDF" },
  });
}

export function useSendInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SendInvoiceInput }) =>
      getApi().invoices.send(id, input),
    onSuccess: (invoice) => {
      qc.setQueryData(invoiceKey(invoice.id), invoice);
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      // Client billing totals count issued (non-draft, non-cancelled) invoices.
      void qc.invalidateQueries({ queryKey: ['finance', 'summary'] });
    },
    meta: { errorTitle: "Couldn't send the invoice" },
  });
}

/** Mark sent without emailing, move back to draft, or cancel. */
export function useSetInvoiceStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SetInvoiceStatusInput }) =>
      getApi().invoices.setStatus(id, input),
    onSuccess: (invoice) => {
      qc.setQueryData(invoiceKey(invoice.id), invoice);
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      // Client billing totals count issued (non-draft, non-cancelled) invoices.
      void qc.invalidateQueries({ queryKey: ['finance', 'summary'] });
      toast.success(`${invoice.number} is now ${invoice.status.toLowerCase()}.`);
    },
    meta: { errorTitle: "Couldn't change the invoice status" },
  });
}

/**
 * Record money received against an invoice. The API recomputes amountPaid and
 * moves the status to PARTIALLY_PAID / PAID, and advances a linked contract.
 */
export function useRecordInvoicePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RecordPaymentInput }) =>
      getApi().invoices.recordPayment(id, input),
    onSuccess: (invoice) => {
      qc.setQueryData(invoiceKey(invoice.id), invoice);
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      // Payments feed contract totals and the finance dashboards too.
      void qc.invalidateQueries({ queryKey: ['finance'] });
      toast.success(
        invoice.status === 'PAID' ? `${invoice.number} marked as paid.` : 'Payment recorded.',
      );
    },
    meta: { errorTitle: "Couldn't record the payment" },
  });
}

export function useUpdateInvoiceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InvoiceSettings) => getApi().invoices.updateSettings(input),
    onSuccess: (settings) => {
      qc.setQueryData(invoiceSettingsKey, settings);
      void qc.invalidateQueries({ queryKey: ['invoices', 'preview'] });
      void qc.invalidateQueries({ queryKey: invoiceTemplatesKey });
      toast.success('Invoice settings saved.');
    },
    meta: { errorTitle: "Couldn't save invoice settings" },
  });
}
