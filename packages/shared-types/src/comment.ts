import { z } from 'zod';

import { cuid } from './common/id.js';
import { fileObjectSchema } from './file.js';
import { userSummarySchema } from './user.js';

/**
 * Tiptap JSON document. The shape is recursive (`content: TiptapNode[]`), but
 * Zod can validate the surface (a node has `type: string`) and trust the
 * editor's schema to refuse malformed inputs. The API stores this as-is in the
 * `Comment.content` JSONB column.
 */
export const commentContentSchema: z.ZodType<unknown> = z
  .object({ type: z.string() })
  .passthrough();

export const commentAttachmentSchema = z.object({
  id: cuid,
  fileObjectId: cuid,
  createdAt: z.coerce.date(),
  file: fileObjectSchema,
});
export type CommentAttachment = z.infer<typeof commentAttachmentSchema>;

export const commentSchema = z.object({
  id: cuid,
  taskId: cuid,
  authorId: cuid,
  content: commentContentSchema,
  contentText: z.string(),
  editedAt: z.coerce.date().nullable(),
  deletedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  author: userSummarySchema,
  attachments: z.array(commentAttachmentSchema),
});
export type Comment = z.infer<typeof commentSchema>;

export const createCommentSchema = z.object({
  content: commentContentSchema,
  contentText: z.string().max(20_000),
  fileObjectIds: z.array(cuid).max(20).optional(),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z.object({
  content: commentContentSchema,
  contentText: z.string().max(20_000),
  fileObjectIds: z.array(cuid).max(20).optional(),
});
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

export const listCommentsQuerySchema = z.object({
  cursor: cuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;

export const commentListResponseSchema = z.object({
  items: z.array(commentSchema),
  nextCursor: cuid.nullable(),
});
export type CommentListResponse = z.infer<typeof commentListResponseSchema>;
