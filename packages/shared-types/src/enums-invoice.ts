import { z } from 'zod';

/* eslint-disable @typescript-eslint/no-redeclare -- value/type pairs share names */

export const InvoiceStatus = z.enum([
  'DRAFT',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
  'REFUNDED',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const PaymentMethod = z.enum([
  'MANUAL',
  'POLAR',
  'STRIPE',
  'BANK_TRANSFER',
  'CASH',
  'OTHER',
]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;
