import { z } from 'zod';

import { cuid } from './common/id.js';

/* eslint-disable @typescript-eslint/no-redeclare */

export const MailAccountStatus = z.enum([
  'CONNECTING',
  'ACTIVE',
  'AUTH_FAILED',
  'CONNECTION_FAILED',
  'DISABLED',
]);
export type MailAccountStatus = z.infer<typeof MailAccountStatus>;

export const MailFolderRole = z.enum([
  'INBOX',
  'SENT',
  'DRAFTS',
  'TRASH',
  'SPAM',
  'ARCHIVE',
  'OUTBOX',
  'ALL',
  'FLAGGED',
  'IMPORTANT',
]);
export type MailFolderRole = z.infer<typeof MailFolderRole>;

export const MailOutboxStatus = z.enum([
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED',
]);
export type MailOutboxStatus = z.infer<typeof MailOutboxStatus>;

/**
 * A named, reusable email signature (HTML) belonging to one mail account.
 */
export const mailSignatureSchema = z.object({
  id: cuid,
  accountId: cuid,
  name: z.string(),
  html: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type MailSignature = z.infer<typeof mailSignatureSchema>;

export const createMailSignatureSchema = z.object({
  name: z.string().min(1).max(120),
  html: z.string().max(20000),
});
export type CreateMailSignatureInput = z.infer<typeof createMailSignatureSchema>;

export const updateMailSignatureSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    html: z.string().max(20000).optional(),
  })
  .refine((v) => v.name !== undefined || v.html !== undefined, {
    message: 'Provide name or html',
  });
export type UpdateMailSignatureInput = z.infer<typeof updateMailSignatureSchema>;

/**
 * Client-facing MailAccount projection. The encrypted password ciphertext
 * (`passwordCiphertext` column) is intentionally absent - it must never leave
 * the server.
 */
export const mailAccountSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  userId: cuid,
  email: z.string().email(),
  displayName: z.string().nullable(),
  imapHost: z.string(),
  imapPort: z.number().int(),
  imapSecure: z.boolean(),
  smtpHost: z.string(),
  smtpPort: z.number().int(),
  smtpSecure: z.boolean(),
  username: z.string(),
  /** Legacy single email sign-off (HTML). Kept for back-compat; the
   *  `signatures` array + default pointers below are the source of truth. */
  signature: z.string().nullable(),
  /** All saved signatures for this account, newest-created last. */
  signatures: z.array(mailSignatureSchema),
  /** Signature applied to brand-new messages (null = none). */
  newSignatureId: cuid.nullable(),
  /** Signature applied to replies and forwards (null = none). */
  replySignatureId: cuid.nullable(),
  /** Insert the signature above the quoted text in replies. */
  signatureBeforeQuote: z.boolean(),
  status: MailAccountStatus,
  lastError: z.string().nullable(),
  lastSyncedAt: z.coerce.date().nullable(),
  isDefault: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

/**
 * Reject mail-server hostnames that point at private or link-local networks.
 * The API connects to user-supplied IMAP/SMTP hosts - without this guard a
 * malicious account can be used to probe the server's internal services
 * (Postgres on 5433, Redis on 6380, AWS IMDS on 169.254.169.254, etc.).
 *
 * DNS rebinding is still possible if a domain resolves to 127.0.0.1 on the
 * second lookup - callers MUST also resolve the host server-side and recheck
 * the resolved A/AAAA before opening a connection.
 */
const PRIVATE_HOSTNAME_RE =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1$|::$|fc[0-9a-f]{2}:|fe[89ab][0-9a-f]:|localhost(?:\.|$))/i;
const RFC1918_172_RE =
  /^172\.(?:1[6-9]|2\d|3[01])\./;

function isPublicMailHostname(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (!h) return false;
  // Strip IPv6 brackets and any zone id.
  h = (h.replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ?? h).trim();
  // Numeric-encoded IPv4 (decimal/hex) the OS resolver may still accept, e.g.
  // 2130706433 or 0x7f000001 -> 127.0.0.1.
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(h)) return false;
  // IPv4-mapped IPv6 of a private/loopback address (::ffff:127.0.0.1).
  const mapped = h.match(/^::ffff:(.+)$/i);
  if (mapped && (PRIVATE_HOSTNAME_RE.test(mapped[1]!) || RFC1918_172_RE.test(mapped[1]!))) {
    return false;
  }
  if (PRIVATE_HOSTNAME_RE.test(h)) return false;
  if (RFC1918_172_RE.test(h)) return false;
  return true;
}

/**
 * Hostname validator shared by personal mail accounts and the org-level mail
 * config. Blocks private/link-local/numeric-encoded hosts at input time; the
 * API additionally re-resolves at connect time (see mail-ssrf in apps/api).
 */
export const mailHost = z
  .string()
  .min(1)
  .max(255)
  .refine(isPublicMailHostname, {
    message: 'Hostname must not point at a private or link-local network.',
  });

export const addMailAccountSchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().min(1).max(120).optional(),
  imapHost: mailHost,
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapSecure: z.boolean().default(true),
  smtpHost: mailHost,
  smtpPort: z.number().int().min(1).max(65535).default(465),
  smtpSecure: z.boolean().default(true),
  username: z.string().min(1).max(254),
  password: z.string().min(1).max(256),
  isDefault: z.boolean().optional(),
});
export type AddMailAccountInput = z.infer<typeof addMailAccountSchema>;

export const updateMailAccountSchema = z.object({
  displayName: z.string().min(1).max(120).nullable().optional(),
  imapHost: mailHost.optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  smtpHost: mailHost.optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  username: z.string().min(1).max(254).optional(),
  password: z.string().min(1).max(256).optional(),
  isDefault: z.boolean().optional(),
  /** Legacy HTML sign-off. Empty string clears it (stored as null). */
  signature: z.string().max(20000).nullable().optional(),
  /** Default signature for new mail. null clears it; must belong to this account. */
  newSignatureId: cuid.nullable().optional(),
  /** Default signature for replies/forwards. null clears it; must belong to this account. */
  replySignatureId: cuid.nullable().optional(),
  /** Whether to place the signature above the quoted text in replies. */
  signatureBeforeQuote: z.boolean().optional(),
});
export type UpdateMailAccountInput = z.infer<typeof updateMailAccountSchema>;

export const mailAccountTestResultSchema = z.object({
  ok: z.boolean(),
  status: MailAccountStatus,
  error: z.string().nullable(),
  imapOk: z.boolean(),
  smtpOk: z.boolean(),
});
export type MailAccountTestResult = z.infer<typeof mailAccountTestResultSchema>;

// ----------------------------------------------------------------------------
// Folders / messages / attachments / outbox - types only in Slice 1 (the API
// surface for these lands in Slice 2). Kept here so the api-client builds.
// ----------------------------------------------------------------------------

export const mailFolderSchema = z.object({
  id: cuid,
  accountId: cuid,
  path: z.string(),
  name: z.string(),
  role: MailFolderRole.nullable(),
  delimiter: z.string(),
  totalCount: z.number().int(),
  unreadCount: z.number().int(),
  position: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type MailFolder = z.infer<typeof mailFolderSchema>;

export const mailAttachmentSchema = z.object({
  id: cuid,
  messageId: cuid,
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  isInline: z.boolean(),
  contentId: z.string().nullable(),
});
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;

export const mailMessageListItemSchema = z.object({
  id: cuid,
  accountId: cuid,
  folderId: cuid,
  subject: z.string(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  bodyTextPreview: z.string(),
  hasAttachments: z.boolean(),
  isUnread: z.boolean(),
  isStarred: z.boolean(),
  receivedAt: z.coerce.date(),
});
export type MailMessageListItem = z.infer<typeof mailMessageListItemSchema>;

export const mailMessageSchema = mailMessageListItemSchema.extend({
  toAddresses: z.array(z.string()),
  ccAddresses: z.array(z.string()),
  bccAddresses: z.array(z.string()),
  replyTo: z.string().nullable(),
  bodyText: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()).nullable(),
  flags: z.array(z.string()),
  sizeBytes: z.number().int(),
  sentAt: z.coerce.date().nullable(),
  attachments: z.array(mailAttachmentSchema),
});
export type MailMessage = z.infer<typeof mailMessageSchema>;

export const listMailMessagesQuerySchema = z.object({
  folderId: cuid.optional(),
  accountId: cuid.optional(),
  unreadOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
  starredOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
  search: z.string().max(255).optional(),
  cursor: cuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListMailMessagesQuery = z.infer<typeof listMailMessagesQuerySchema>;

/**
 * Autocomplete query for the compose recipient fields: addresses the user
 * has previously *sent* to, optionally filtered by a typed prefix/substring.
 */
export const recipientSuggestionsQuerySchema = z.object({
  accountId: cuid,
  q: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type RecipientSuggestionsQuery = z.infer<
  typeof recipientSuggestionsQuerySchema
>;

export const recipientSuggestionsResponseSchema = z.object({
  /** Distinct recipient addresses, most-frequently-used first. */
  items: z.array(z.string()),
});
export type RecipientSuggestionsResponse = z.infer<
  typeof recipientSuggestionsResponseSchema
>;

/** Self-serve mailbox setup for users whose email is on the cPanel-managed
 *  domain. The password the user types is set on cPanel (via passwd_pop)
 *  AND used to provision the MailAccount, so IMAP verification can't fail
 *  with a stale password. */
export const selfSetupMailboxSchema = z.object({
  password: z.string().min(8).max(256),
});
export type SelfSetupMailboxInput = z.infer<typeof selfSetupMailboxSchema>;

export const moveMailMessageSchema = z
  .object({
    folderId: cuid.optional(),
    role: z.enum(['ARCHIVE', 'TRASH', 'SPAM', 'INBOX']).optional(),
  })
  .refine((v) => v.folderId != null || v.role != null, {
    message: 'Provide folderId or role',
  });
export type MoveMailMessageInput = z.infer<typeof moveMailMessageSchema>;

// ----------------------------------------------------------------------------
// Bulk operations - used by the multi-select UI in the message list. We cap
// each call at 500 ids so a stray "select all" can't open an IMAP session
// the server has to babysit for minutes.
// ----------------------------------------------------------------------------

const BULK_MAX_IDS = 500;
const bulkIdsSchema = z.array(cuid).min(1).max(BULK_MAX_IDS);

export const bulkMoveMailMessagesSchema = z
  .object({
    ids: bulkIdsSchema,
    folderId: cuid.optional(),
    role: z.enum(['ARCHIVE', 'TRASH', 'SPAM', 'INBOX']).optional(),
  })
  .refine((v) => v.folderId != null || v.role != null, {
    message: 'Provide folderId or role',
  });
export type BulkMoveMailMessagesInput = z.infer<typeof bulkMoveMailMessagesSchema>;

export const bulkFlagMailMessagesSchema = z.object({
  ids: bulkIdsSchema,
  op: z.enum(['read', 'unread', 'star', 'unstar']),
});
export type BulkFlagMailMessagesInput = z.infer<typeof bulkFlagMailMessagesSchema>;

export const bulkDeleteMailMessagesSchema = z.object({
  ids: bulkIdsSchema,
});
export type BulkDeleteMailMessagesInput = z.infer<typeof bulkDeleteMailMessagesSchema>;

export const bulkMailResultSchema = z.object({
  ok: z.literal(true),
  affected: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type BulkMailResult = z.infer<typeof bulkMailResultSchema>;

/**
 * `POST /mail/folders/:folderId/resync` answers 202 at once: the full re-sync
 * runs as a background job, and the folder's rows update as it progresses.
 * `jobId` is stable per folder, so repeated clicks while one is pending join
 * it instead of queueing another full fetch.
 */
export const mailFolderResyncQueuedSchema = z.object({
  ok: z.literal(true),
  queued: z.literal(true),
  jobId: z.string().min(1),
  /**
   * Always 0. Clients from before the background job parse `{ ok, healed }`
   * and would reject the reply without it. Kept for one release; it can be
   * dropped in the release after this one.
   */
  healed: z.literal(0).optional(),
});
export type MailFolderResyncQueued = z.infer<typeof mailFolderResyncQueuedSchema>;

export const saveMailDraftSchema = z.object({
  accountId: cuid,
  to: z.array(z.string().email()).max(50).optional(),
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().max(998).optional(),
  bodyText: z.string().max(1_000_000).optional(),
  bodyHtml: z.string().max(2_000_000).optional(),
  inReplyToMessageId: cuid.optional(),
  /** Attached FileObject ids to inline into the draft's RFC822 payload.
   *  Same shape and 20-attachment cap as the send path so the IMAP draft
   *  is byte-identical to what a later Send would emit. */
  attachmentFileObjectIds: z.array(cuid).max(20).optional(),
  /** When set, this draft replaces an existing draft message (the previous
   *  copy is deleted from the IMAP DRAFTS folder). */
  replacesDraftId: cuid.optional(),
});
export type SaveMailDraftInput = z.infer<typeof saveMailDraftSchema>;

export const saveMailDraftResultSchema = z.object({
  draftMessageId: cuid,
});
export type SaveMailDraftResult = z.infer<typeof saveMailDraftResultSchema>;

export const sendMailMessageSchema = z.object({
  accountId: cuid,
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().max(998),
  bodyText: z.string().max(1_000_000),
  bodyHtml: z.string().max(2_000_000).optional(),
  inReplyToMessageId: cuid.optional(),
  attachmentFileObjectIds: z.array(cuid).max(20).optional(),
  /** When sending a draft, the matching draft MailMessage row id. The
   *  IMAP draft is removed after the SMTP send succeeds. */
  replacesDraftId: cuid.optional(),
});
export type SendMailMessageInput = z.infer<typeof sendMailMessageSchema>;

export const replyMailSchema = z.object({
  messageId: cuid,
  mode: z.enum(['reply', 'reply-all', 'forward']),
  bodyText: z.string().max(1_000_000),
  bodyHtml: z.string().max(2_000_000).optional(),
  attachmentFileObjectIds: z.array(cuid).max(20).optional(),
});
export type ReplyMailInput = z.infer<typeof replyMailSchema>;

export const mailOutboxSchema = z.object({
  id: cuid,
  accountId: cuid,
  userId: cuid,
  toAddresses: z.array(z.string()),
  ccAddresses: z.array(z.string()),
  bccAddresses: z.array(z.string()),
  subject: z.string(),
  status: MailOutboxStatus,
  attemptCount: z.number().int(),
  lastError: z.string().nullable(),
  sentAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type MailOutbox = z.infer<typeof mailOutboxSchema>;
