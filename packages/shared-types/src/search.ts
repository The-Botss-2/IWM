import { z } from 'zod';

import { cuid } from './common/id.js';

export const searchResultKind = z.enum([
  'task',
  'project',
  'lead',
  'client',
  'document',
  'chat_message',
  'chat_room',
  /** Attachments shared in chat rooms the caller belongs to. */
  'file',
  /** Files uploaded to the workspace (task comments, receipts, documents). */
  'workspace_file',
  /** Messages in the caller's own mailboxes. */
  'mail',
  /** People in the active workspace. */
  'person',
]);
export type SearchResultKind = z.infer<typeof searchResultKind>;

export const searchResultSchema = z.object({
  kind: searchResultKind,
  id: cuid,
  title: z.string(),
  /** Optional human-readable parent context - "Project / Task list", "Lead → Client" etc. */
  context: z.string().nullable(),
  /** Optional navigation path the client should route to. */
  href: z.string(),
  /** Text around the match, for message and document hits. */
  snippet: z.string().nullable().optional(),
  /** Who wrote or sent it, when that applies. */
  actorName: z.string().nullable().optional(),
  /** When it was written, sent or last updated. */
  at: z.coerce.date().nullable().optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchQuerySchema = z
  .object({
    /**
     * Free text. May be empty when a filter (`from:`, `in:`, `has:`, a date)
     * carries the search on its own; see the refine below.
     */
    q: z.string().trim().max(120).default(''),
    kinds: z
      .union([searchResultKind, z.array(searchResultKind)])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    /**
     * Page mode. When set, only this kind is searched and results page with
     * `cursor`. Without it the endpoint behaves like the command palette: a
     * few hits spread across every kind.
     */
    kind: searchResultKind.optional(),
    /** Opaque cursor from a previous page's `nextCursor`. */
    cursor: z
      .string()
      .regex(/^\d{1,4}$/)
      .optional(),
    /** Chat and mail filters (the search page's `from:` / `in:` / date chips). */
    fromUserId: cuid.optional(),
    roomId: cuid.optional(),
    after: z.coerce.date().optional(),
    before: z.coerce.date().optional(),
    /** `has:file` (messages and mail with an attachment) / `has:link` (messages with a URL). */
    has: z.enum(['file', 'link']).optional(),
    /** Best match first (default), or newest first. */
    sort: z.enum(['relevance', 'recent']).default('relevance'),
    /** Include a capped per-kind hit count for the search page tabs. */
    counts: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .transform((v) => v === true || v === 'true'),
  })
  .refine(
    (v) => v.q.length >= 2 || Boolean(v.fromUserId || v.roomId || v.has || v.after || v.before),
    {
      message: 'Type at least two characters or add a filter',
      path: ['q'],
    },
  )
  .refine((v) => !(v.after && v.before) || v.after <= v.before, {
    message: '`after` must be before `before`',
    path: ['after'],
  });
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchQueryInput = z.input<typeof searchQuerySchema>;

/** Counts are capped; the UI renders the cap as "99+". */
export const SEARCH_COUNT_CAP = 99;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  /** Present in page mode when more results exist. */
  nextCursor: z.string().nullable().optional(),
  counts: z.record(searchResultKind, z.number().int().nonnegative()).optional(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
