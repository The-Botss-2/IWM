import { z } from 'zod';

import { cuid } from './common/id.js';
import { paginationQuerySchema, sortOrderSchema } from './common/pagination.js';
import { LeadSource, LeadStage } from './enums.js';
import { userSummarySchema } from './user.js';

export const leadSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  createdById: cuid,
  /** Who the lead is assigned to. Also the visibility key - a user without
   *  full sales access only ever receives rows where this is their id. */
  assigneeId: cuid.nullable(),
  name: z.string().min(1).max(120),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  source: LeadSource,
  stage: LeadStage,
  /** Decimal as string. */
  estimatedValue: z.string().nullable(),
  currency: z.string().length(3),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  customFields: z.record(z.unknown()).nullable(),
  followupAt: z.coerce.date().nullable(),
  convertedToClientId: cuid.nullable(),
  convertedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Lead = z.infer<typeof leadSchema>;

/**
 * List/detail response shape. Two people ride along with every lead:
 *  - `owner`    - the creator (`createdById`), shown read-only. Never changes.
 *  - `assignee` - the current assignee (`assigneeId`), editable, and the field
 *                 that decides who can see the lead at all.
 */
export const leadWithOwnerSchema = leadSchema.extend({
  owner: userSummarySchema.nullable(),
  assignee: userSummarySchema.nullable(),
});
export type LeadWithOwner = z.infer<typeof leadWithOwnerSchema>;

export const createLeadSchema = z.object({
  name: z.string().min(1).max(120),
  // Optional. Accept an empty string as well as undefined so a blank email
  // input (which submits as '') doesn't trip the `.email()` check and block
  // the form; the client strips empties before sending.
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  source: LeadSource.optional(),
  stage: LeadStage.optional(),
  estimatedValue: z.coerce.string().optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  assigneeId: cuid.optional(),
  followupAt: z.coerce.date().nullable().optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/**
 * Update payload. Nullable on every field that the inline editor can clear, so
 * the client can send `{ field: null }` to actively set the column to NULL
 * rather than omitting it (which would leave the existing value untouched).
 */
export const updateLeadSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  source: LeadSource.optional(),
  stage: LeadStage.optional(),
  estimatedValue: z.string().nullable().optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  assigneeId: cuid.nullable().optional(),
  followupAt: z.coerce.date().nullable().optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

/**
 * Convert a lead. One of the two paths must be taken:
 *  - `clientId`     → link to an existing client.
 *  - `newClient`    → atomically create a new client and link to it.
 * If both are omitted the API falls back to a minimal client derived from the
 * lead's own name/company/email/phone (used by non-UI callers).
 */
export const convertNewClientSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  website: z.string().url().optional(),
  notes: z.string().optional(),
  assigneeId: cuid.optional(),
});
export type ConvertNewClientInput = z.infer<typeof convertNewClientSchema>;

export const convertLeadSchema = z
  .object({
    clientId: cuid.optional(),
    newClient: convertNewClientSchema.optional(),
  })
  .refine((v) => !(v.clientId && v.newClient), {
    message: 'Provide either clientId or newClient, not both.',
  });
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;

export const listLeadsQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(),
  stage: LeadStage.optional(),
  source: LeadSource.optional(),
  assigneeId: cuid.optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt', 'estimatedValue']).default('updatedAt'),
  order: sortOrderSchema,
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;
