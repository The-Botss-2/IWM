import { z } from 'zod';

import { cuid } from './common/id.js';
import { ISO_CURRENCY } from './common/money.js';

/** Folder name under apps/api/invoice-templates. */
export const invoiceTemplateKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,48}$/, 'Template keys are lowercase letters, numbers and dashes');

export const invoiceTemplateSchema = z.object({
  key: invoiceTemplateKey,
  name: z.string(),
  description: z.string().nullable(),
  paper: z.enum(['A4', 'Letter']),
});
export type InvoiceTemplate = z.infer<typeof invoiceTemplateSchema>;

export const invoiceTemplateListSchema = z.object({
  items: z.array(invoiceTemplateSchema),
  defaultKey: invoiceTemplateKey,
});
export type InvoiceTemplateList = z.infer<typeof invoiceTemplateListSchema>;

/**
 * Organization-level invoice branding and defaults, stored as JSON on
 * `Organization.invoiceSettings`. Every field is optional so a fresh org
 * renders with sensible fallbacks.
 */
export const invoiceSettingsSchema = z.object({
  companyName: z.string().max(200).nullable().optional(),
  /** FileObject id of the logo (PNG, JPEG, WebP or SVG). */
  logoFileId: cuid.nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  website: z.string().max(200).nullable().optional(),
  taxId: z.string().max(100).nullable().optional(),
  bankDetails: z.string().max(2000).nullable().optional(),
  paymentTerms: z.string().max(2000).nullable().optional(),
  footer: z.string().max(500).nullable().optional(),
  defaultTemplateKey: invoiceTemplateKey.nullable().optional(),
  defaultCurrency: ISO_CURRENCY.nullable().optional(),
  defaultDueDays: z.number().int().min(0).max(365).nullable().optional(),
  /** Accent color used by templates that support it, e.g. #7b6fe8. */
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});
export type InvoiceSettings = z.infer<typeof invoiceSettingsSchema>;

export const invoiceSettingsResponseSchema = invoiceSettingsSchema.extend({
  /** Public URL of the logo file, resolved server-side for previews. */
  logoUrl: z.string().nullable().optional(),
});
export type InvoiceSettingsResponse = z.infer<typeof invoiceSettingsResponseSchema>;

const previewLineItemSchema = z.object({
  description: z.string().max(500),
  quantity: z.union([z.string(), z.number()]).optional(),
  unitPrice: z.union([z.string(), z.number()]).optional(),
  taxRate: z.union([z.string(), z.number()]).optional(),
  discountRate: z.union([z.string(), z.number()]).optional(),
});

/**
 * Unsaved editor state for the live preview. Mirrors the create payload but
 * every field is optional, so a half-filled form still previews.
 */
export const invoicePreviewSchema = z.object({
  invoiceId: cuid.optional(),
  templateKey: invoiceTemplateKey.optional(),
  clientId: cuid.optional(),
  projectId: cuid.nullable().optional(),
  currency: ISO_CURRENCY.optional(),
  issuedAt: z.coerce.date().optional(),
  dueAt: z.coerce.date().optional(),
  lineItems: z.array(previewLineItemSchema).max(200).optional(),
  notes: z.string().max(2000).nullable().optional(),
  terms: z.string().max(2000).nullable().optional(),
  footer: z.string().max(500).nullable().optional(),
});
export type InvoicePreviewInput = z.infer<typeof invoicePreviewSchema>;

export const invoicePdfResponseSchema = z.object({
  fileId: cuid,
  url: z.string(),
  filename: z.string(),
});
export type InvoicePdfResponse = z.infer<typeof invoicePdfResponseSchema>;

/**
 * Send an invoice. `system` emails the client from the platform no-reply
 * address with the PDF attached. `mailbox` means the user already sent it
 * from their own mailbox in the compose dialog; the API only records it.
 */
export const sendInvoiceSchema = z.discriminatedUnion('via', [
  z.object({
    via: z.literal('system'),
    to: z.array(z.string().email()).min(1).max(10),
    subject: z.string().min(1).max(300),
    message: z.string().max(5000).optional(),
  }),
  z.object({ via: z.literal('mailbox') }),
]);
export type SendInvoiceInput = z.infer<typeof sendInvoiceSchema>;
