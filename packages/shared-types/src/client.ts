import { z } from 'zod';

import { cuid } from './common/id.js';
import { paginationQuerySchema, sortOrderSchema } from './common/pagination.js';
import { ClientStatus } from './enums.js';
import { userSummarySchema } from './user.js';

export const clientSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  createdById: cuid,
  /** Who the client is assigned to. Also the visibility key - a user without
   *  full sales access only ever receives rows where this is their id. */
  assigneeId: cuid.nullable(),
  name: z.string().min(1).max(120),
  legalName: z.string().nullable(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  website: z.string().url().nullable(),
  industry: z.string().nullable(),
  status: ClientStatus,
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  taxId: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  customFields: z.record(z.unknown()).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Client = z.infer<typeof clientSchema>;

/**
 * List/detail response shape. Two people ride along with every client:
 *  - `owner`    - the creator (`createdById`), shown read-only. Never changes.
 *  - `assignee` - the current assignee (`assigneeId`), editable, and the field
 *                 that decides who can see the client at all.
 */
export const clientWithOwnerSchema = clientSchema.extend({
  owner: userSummarySchema.nullable(),
  assignee: userSummarySchema.nullable(),
});
export type ClientWithOwner = z.infer<typeof clientWithOwnerSchema>;

/**
 * What the API returns from `GET /clients/:id`. The list endpoint stays on
 * `clientWithOwnerSchema` - detail-only fields (e.g. the originating lead) live
 * here so the list response doesn't pay for the extra join on every page.
 */
export const clientDetailSchema = clientWithOwnerSchema.extend({
  convertedFromLead: z
    .object({
      id: cuid,
      name: z.string(),
      convertedAt: z.coerce.date().nullable(),
    })
    .nullable(),
});
export type ClientDetail = z.infer<typeof clientDetailSchema>;

export const createClientSchema = z.object({
  name: z.string().min(1).max(120),
  legalName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  website: z.string().url().optional(),
  industry: z.string().optional(),
  status: ClientStatus.optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  taxId: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  assigneeId: cuid.optional(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

/**
 * `assigneeId` is re-declared as nullable so the client can send
 * `{ assigneeId: null }` to un-assign. `.partial()` alone would only allow
 * omitting it, which means "leave unchanged" - there'd be no way to clear it.
 */
export const updateClientSchema = createClientSchema.partial().extend({
  assigneeId: cuid.nullable().optional(),
});
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

export const listClientsQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(),
  status: ClientStatus.optional(),
  assigneeId: cuid.optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt']).default('updatedAt'),
  order: sortOrderSchema,
});
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;
