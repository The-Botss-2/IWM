import { z } from 'zod';

import { cuid } from './common/id.js';
import { paginationQuerySchema, sortOrderSchema } from './common/pagination.js';
import { DocumentPermission, DocumentVisibility } from './enums.js';
import { AccountType, userSummarySchema } from './user.js';

/** Tiptap content is open-ended JSON; we don't validate the inner shape here. */
const tiptapDocSchema = z.unknown();

export const documentSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  projectId: cuid.nullable(),
  /** Client this document is filed under. Filing grants nobody access.
   *  Optional so older API builds still parse. */
  clientId: cuid.nullable().optional(),
  createdById: cuid,
  parentId: cuid.nullable(),
  title: z.string().min(1).max(200),
  icon: z.string().nullable(),
  coverUrl: z.string().url().nullable(),
  visibility: DocumentVisibility,
  content: tiptapDocSchema.nullable(),
  publicSlug: z.string().nullable(),
  publicReadOnly: z.boolean(),
  /** When set, the public link stops working after this instant. */
  publicExpiresAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Document = z.infer<typeof documentSchema>;

export const documentWithCreatorSchema = documentSchema.extend({
  createdBy: userSummarySchema,
  /**
   * Optional: present on list/detail responses when the API can compute it
   * cheaply. Lets the client render "Read only" banners and gate the editor
   * without a second round-trip.
   */
  viewerPermission: z.enum(['OWNER', 'ADMIN', 'WRITE', 'READ']).optional(),
  /** Optional: number of explicit grants - surfaced on the Share button badge. */
  accessGrantCount: z.number().int().nonnegative().optional(),
});
export type DocumentWithCreator = z.infer<typeof documentWithCreatorSchema>;

export const createDocumentSchema = z.object({
  title: z.string().min(1).max(200),
  projectId: cuid.optional(),
  /** File the new document under a client in the same workspace. */
  clientId: cuid.optional(),
  parentId: cuid.optional(),
  icon: z.string().optional(),
  coverUrl: z.string().url().optional(),
  visibility: DocumentVisibility.optional(),
  content: tiptapDocSchema.optional(),
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  projectId: cuid.nullable().optional(),
  /** Re-file under another client, or null to unfile. */
  clientId: cuid.nullable().optional(),
  parentId: cuid.nullable().optional(),
  icon: z.string().nullable().optional(),
  coverUrl: z.string().url().nullable().optional(),
  visibility: DocumentVisibility.optional(),
  content: tiptapDocSchema.optional(),
  publicReadOnly: z.boolean().optional(),
  /** Change the public link's expiry without rotating the link. Null = never. */
  publicExpiresAt: z.coerce.date().nullable().optional(),
});
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const sharePublicLinkSchema = z.object({
  publicReadOnly: z.boolean().default(true),
  /** Optional expiry for the public link. Null or omitted = never expires. */
  expiresAt: z.coerce.date().nullable().optional(),
});
export type SharePublicLinkInput = z.infer<typeof sharePublicLinkSchema>;

/**
 * Public-facing projection for the `/p/<slug>` reader. Strips workspace and
 * author identifiers - only the human-friendly labels cross the wire so an
 * anonymous viewer can't pivot from a shared link into other tenants' data.
 */
export const publicDocumentSchema = z.object({
  title: z.string(),
  content: tiptapDocSchema.nullable(),
  workspaceName: z.string(),
  authorName: z.string(),
  publicReadOnly: z.boolean(),
  updatedAt: z.coerce.date(),
});
export type PublicDocument = z.infer<typeof publicDocumentSchema>;

// ============================================================================
// Document access (Task 6 - internal sharing)
// ============================================================================

export const documentAccessSchema = z.object({
  id: cuid,
  documentId: cuid,
  userId: cuid,
  permission: DocumentPermission,
  grantedById: cuid,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  user: userSummarySchema.extend({
    /** CLIENT people are read-only; the share dialog hides Write for them.
     *  Absent reads as STAFF. */
    accountType: AccountType.optional(),
  }),
  grantedBy: userSummarySchema,
});
export type DocumentAccess = z.infer<typeof documentAccessSchema>;

/** A document shared with a whole client company (all its portal people). */
export const documentClientShareSchema = z.object({
  id: cuid,
  documentId: cuid,
  clientId: cuid,
  client: z.object({ id: cuid, name: z.string() }),
  grantedBy: z.object({ id: cuid, name: z.string() }).nullable(),
  createdAt: z.coerce.date(),
});
export type DocumentClientShare = z.infer<typeof documentClientShareSchema>;

export const documentAccessListSchema = z.object({
  items: z.array(documentAccessSchema),
  owner: userSummarySchema,
  /** Whole-company client shares. Absent reads as none. */
  clientShares: z.array(documentClientShareSchema).optional(),
});
export type DocumentAccessList = z.infer<typeof documentAccessListSchema>;

export const addDocumentClientShareSchema = z.object({
  clientId: cuid,
});
export type AddDocumentClientShareInput = z.infer<typeof addDocumentClientShareSchema>;

/**
 * Who a document can be shared with on the client side: the clients the
 * sharer may pick, each with its live portal people.
 */
export const documentShareTargetsSchema = z.object({
  clients: z.array(
    z.object({
      id: cuid,
      name: z.string(),
      /** Already shared with the whole company. */
      companyShared: z.boolean(),
      people: z.array(
        z.object({
          userId: cuid,
          name: z.string(),
          email: z.string().email(),
          /** Already holds a personal READ grant on this document. */
          hasAccess: z.boolean(),
        }),
      ),
    }),
  ),
});
export type DocumentShareTargets = z.infer<typeof documentShareTargetsSchema>;

export const addDocumentAccessSchema = z.object({
  userId: cuid,
  permission: DocumentPermission,
});
export type AddDocumentAccessInput = z.infer<typeof addDocumentAccessSchema>;

export const updateDocumentAccessSchema = z.object({
  permission: DocumentPermission,
});
export type UpdateDocumentAccessInput = z.infer<typeof updateDocumentAccessSchema>;

/**
 * Per-viewer permission badge attached to a document fetch. Lets the client
 * decide whether to render the editor in read-only mode without a second
 * round-trip to enumerate explicit grants.
 */
export const documentViewerPermissionSchema = z.enum(['OWNER', 'ADMIN', 'WRITE', 'READ']);
export type DocumentViewerPermission = z.infer<typeof documentViewerPermissionSchema>;

export const listDocumentsQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(),
  projectId: cuid.optional(),
  parentId: cuid.optional(),
  visibility: DocumentVisibility.optional(),
  sort: z.enum(['title', 'createdAt', 'updatedAt']).default('updatedAt'),
  order: sortOrderSchema,
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
