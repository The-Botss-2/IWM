import { z } from 'zod';
import {
  type CreateInvoiceInput,
  invoicePdfResponseSchema,
  type InvoicePdfResponse,
  type InvoicePreviewInput,
  invoiceSchema,
  type InvoiceSettings,
  invoiceSettingsResponseSchema,
  type InvoiceSettingsResponse,
  invoiceTemplateListSchema,
  type InvoiceTemplateList,
  invoiceWithItemsSchema,
  type InvoiceWithItems,
  type ListInvoicesQuery,
  listResponseSchema,
  type RecordPaymentInput,
  type SendInvoiceInput,
  type SetInvoiceStatusInput,
  type UpdateInvoiceInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const listSchema = listResponseSchema(
  invoiceSchema.extend({
    client: z.object({ id: z.string(), name: z.string() }),
  }),
);

export class InvoicesResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListInvoicesQuery>) {
    return this.http.get('/invoices', listSchema, query);
  }
  get(id: string): Promise<InvoiceWithItems> {
    return this.http.get(`/invoices/${id}`, invoiceWithItemsSchema);
  }
  create(input: CreateInvoiceInput): Promise<InvoiceWithItems> {
    return this.http.post('/invoices', invoiceWithItemsSchema, input);
  }
  update(id: string, input: UpdateInvoiceInput): Promise<InvoiceWithItems> {
    return this.http.patch(`/invoices/${id}`, invoiceWithItemsSchema, input);
  }
  remove(id: string) {
    return this.http.delete(`/invoices/${id}`, okSchema);
  }
  /** `mailbox` records a send done from the user's mailbox; `system` emails the PDF. */
  send(id: string, input: SendInvoiceInput = { via: 'mailbox' }): Promise<InvoiceWithItems> {
    return this.http.post(`/invoices/${id}/send`, invoiceWithItemsSchema, input);
  }
  /** Manual DRAFT / SENT / CANCELLED change; paid states follow payments. */
  setStatus(id: string, input: SetInvoiceStatusInput): Promise<InvoiceWithItems> {
    return this.http.post(`/invoices/${id}/status`, invoiceWithItemsSchema, input);
  }
  recordPayment(id: string, input: RecordPaymentInput): Promise<InvoiceWithItems> {
    return this.http.post(`/invoices/${id}/payments`, invoiceWithItemsSchema, input);
  }
  /** Render (or reuse) the stored PDF. */
  pdf(id: string): Promise<InvoicePdfResponse> {
    return this.http.post(`/invoices/${id}/pdf`, invoicePdfResponseSchema, {});
  }
  templates(): Promise<InvoiceTemplateList> {
    return this.http.get('/invoices/templates', invoiceTemplateListSchema);
  }
  /** Self-contained HTML for the editor's live preview. */
  preview(input: InvoicePreviewInput): Promise<string> {
    return this.http.postText('/invoices/preview', input);
  }
  settings(): Promise<InvoiceSettingsResponse> {
    return this.http.get('/invoices/settings', invoiceSettingsResponseSchema);
  }
  updateSettings(input: InvoiceSettings): Promise<InvoiceSettingsResponse> {
    return this.http.put('/invoices/settings', invoiceSettingsResponseSchema, input);
  }
}
