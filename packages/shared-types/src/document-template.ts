import { z } from 'zod';

import { cuid } from './common/id.js';

/** Tiptap content is open-ended JSON; we don't validate the inner shape here. */
const tiptapDocSchema = z.unknown();

export const documentTemplateSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  name: z.string().min(1).max(120),
  icon: z.string().max(40).nullable(),
  coverUrl: z.string().url().max(2048).nullable(),
  content: tiptapDocSchema,
  isShared: z.boolean(),
  createdById: cuid,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type DocumentTemplate = z.infer<typeof documentTemplateSchema>;

export const createDocumentTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  icon: z.string().max(40).optional(),
  coverUrl: z.string().url().max(2048).optional(),
  content: tiptapDocSchema,
  isShared: z.boolean().optional(),
});
export type CreateDocumentTemplateInput = z.infer<typeof createDocumentTemplateSchema>;

export const updateDocumentTemplateSchema = createDocumentTemplateSchema.partial();
export type UpdateDocumentTemplateInput = z.infer<typeof updateDocumentTemplateSchema>;

export const documentRevisionSchema = z.object({
  id: cuid,
  documentId: cuid,
  content: tiptapDocSchema,
  contentText: z.string(),
  changedById: cuid,
  changeSummary: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type DocumentRevision = z.infer<typeof documentRevisionSchema>;
