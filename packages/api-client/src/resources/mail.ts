import { z } from 'zod';
import {
  type AddMailAccountInput,
  type BulkDeleteMailMessagesInput,
  type BulkFlagMailMessagesInput,
  type BulkMailResult,
  bulkMailResultSchema,
  type BulkMoveMailMessagesInput,
  type ListMailMessagesQuery,
  type MailAccount,
  mailAccountSchema,
  mailAccountTestResultSchema,
  type MailFolder,
  type MailFolderResyncQueued,
  mailFolderResyncQueuedSchema,
  mailFolderSchema,
  type MailMessage,
  mailMessageSchema,
  type MailMessageListItem,
  mailMessageListItemSchema,
  type CreateMailSignatureInput,
  type MoveMailMessageInput,
  type RecipientSuggestionsResponse,
  recipientSuggestionsResponseSchema,
  type SaveMailDraftInput,
  type SaveMailDraftResult,
  saveMailDraftResultSchema,
  type SendMailMessageInput,
  type UpdateMailAccountInput,
  type UpdateMailSignatureInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const mailAccountListSchema = z.object({ items: z.array(mailAccountSchema) });
const mailFolderListSchema = z.object({ items: z.array(mailFolderSchema) });
const mailMessageListSchema = z.object({
  items: z.array(mailMessageListItemSchema),
  nextCursor: z.string().nullable(),
});

const sendResponseSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED']),
  createdAt: z.coerce.date(),
});

export type FlagOp = 'read' | 'unread' | 'star' | 'unstar';

export class MailResource {
  constructor(private readonly http: HttpClient) {}

  /** Server-sent-events stream of `folder-updated` pushes (open with EventSource). */
  eventsUrl(): string {
    return this.http.absoluteUrl('/mail/events/stream');
  }

  listAccounts() {
    return this.http.get('/mail/accounts', mailAccountListSchema);
  }
  addAccount(input: AddMailAccountInput): Promise<MailAccount> {
    return this.http.post('/mail/accounts', mailAccountSchema, input);
  }
  selfSetupMailbox(password: string): Promise<MailAccount> {
    return this.http.post('/mail/accounts/self-setup', mailAccountSchema, { password });
  }
  updateAccount(id: string, input: UpdateMailAccountInput): Promise<MailAccount> {
    return this.http.patch(`/mail/accounts/${id}`, mailAccountSchema, input);
  }
  testAccount(id: string) {
    return this.http.post(`/mail/accounts/${id}/test`, mailAccountTestResultSchema, {});
  }
  removeAccount(id: string) {
    return this.http.delete(`/mail/accounts/${id}`, okSchema);
  }

  // Signatures. All three return the updated account (with its signatures
  // array + refreshed default pointers) so the caller can replace the cached
  // account in one shot.
  addSignature(accountId: string, input: CreateMailSignatureInput): Promise<MailAccount> {
    return this.http.post(`/mail/accounts/${accountId}/signatures`, mailAccountSchema, input);
  }
  updateSignature(
    accountId: string,
    signatureId: string,
    input: UpdateMailSignatureInput,
  ): Promise<MailAccount> {
    return this.http.patch(
      `/mail/accounts/${accountId}/signatures/${signatureId}`,
      mailAccountSchema,
      input,
    );
  }
  removeSignature(accountId: string, signatureId: string): Promise<MailAccount> {
    return this.http.delete(
      `/mail/accounts/${accountId}/signatures/${signatureId}`,
      mailAccountSchema,
    );
  }

  listFolders(accountId: string): Promise<{ items: MailFolder[] }> {
    return this.http.get('/mail/folders', mailFolderListSchema, { accountId });
  }
  /** Mark every unread message in a folder as read. Server returns the count
   *  that was flipped. */
  markFolderAllRead(folderId: string) {
    return this.http.post(
      `/mail/folders/${folderId}/mark-all-read`,
      z.object({ ok: z.literal(true), updated: z.number().int().nonnegative() }),
      {},
    );
  }

  /** Permanently delete every message in a Trash or Spam folder. */
  emptyFolder(folderId: string) {
    return this.http.post(
      `/mail/folders/${folderId}/empty`,
      z.object({ ok: z.literal(true), deleted: z.number().int().nonnegative() }),
      {},
    );
  }

  /** Force a full re-sync of a single folder. Used to repair MailMessage
   *  rows whose metadata drifted from IMAP truth (e.g. sent mail that
   *  pre-dates the attachment-parsing fix). Expensive on large folders, so
   *  it runs as a background job: this resolves as soon as it is queued
   *  (HTTP 202) and the folder's rows update while the job runs. */
  resyncFolder(folderId: string): Promise<MailFolderResyncQueued> {
    return this.http.post(`/mail/folders/${folderId}/resync`, mailFolderResyncQueuedSchema, {});
  }

  syncAccount(accountId: string) {
    return this.http.post(
      `/mail/accounts/${accountId}/sync`,
      z.object({
        ok: z.boolean(),
        folders: z.number().int(),
        messages: z.number().int(),
        error: z.string().optional(),
      }),
      {},
    );
  }

  listMessages(
    query: Partial<ListMailMessagesQuery>,
  ): Promise<{ items: MailMessageListItem[]; nextCursor: string | null }> {
    return this.http.get('/mail/messages', mailMessageListSchema, query);
  }
  getMessage(id: string): Promise<MailMessage> {
    return this.http.get(`/mail/messages/${id}`, mailMessageSchema);
  }
  /** Addresses the user has previously sent to, for compose autocomplete. */
  recipientSuggestions(
    accountId: string,
    opts: { q?: string; limit?: number } = {},
  ): Promise<RecipientSuggestionsResponse> {
    return this.http.get(
      '/mail/messages/recipient-suggestions',
      recipientSuggestionsResponseSchema,
      {
        accountId,
        ...(opts.q ? { q: opts.q } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
      },
    );
  }
  setFlag(id: string, op: FlagOp) {
    return this.http.patch(`/mail/messages/${id}/flags`, okSchema, { op });
  }
  moveMessage(id: string, target: MoveMailMessageInput) {
    return this.http.post(`/mail/messages/${id}/move`, okSchema, target);
  }

  /** Bulk move many messages at once. Server batches IMAP MOVE per source
   *  folder so a 50-message selection costs ~1–2 IMAP round-trips, not 50. */
  bulkMoveMessages(input: BulkMoveMailMessagesInput): Promise<BulkMailResult> {
    return this.http.post('/mail/messages/bulk/move', bulkMailResultSchema, input);
  }

  /** Bulk read / unread / star / unstar. */
  bulkSetFlag(input: BulkFlagMailMessagesInput): Promise<BulkMailResult> {
    return this.http.post('/mail/messages/bulk/flags', bulkMailResultSchema, input);
  }

  /** Permanently delete a multi-selection. Server enforces the "Trash/Spam
   *  source folder only" rule - ids in other folders are silently dropped. */
  bulkDeleteMessages(input: BulkDeleteMailMessagesInput): Promise<BulkMailResult> {
    return this.http.post('/mail/messages/bulk/delete', bulkMailResultSchema, input);
  }
  sendMessage(input: SendMailMessageInput) {
    return this.http.post('/mail/messages/send', sendResponseSchema, input);
  }
  saveDraft(input: SaveMailDraftInput): Promise<SaveMailDraftResult> {
    return this.http.post('/mail/messages/drafts', saveMailDraftResultSchema, input);
  }
  discardDraft(draftId: string) {
    return this.http.delete(`/mail/messages/drafts/${draftId}`, okSchema);
  }

  /**
   * Fetch an attachment's bytes over the app's credentialed transport.
   *
   * Deliberately NOT exposed as a URL for an `<a href download>`: the API is a
   * different origin from the web app, so the browser ignores the `download`
   * attribute and the click becomes a top-level navigation. In the Electron
   * desktop shell that navigation is foreign-origin, so `will-navigate` hands
   * it to the OS browser, which has no session cookie and gets a 401. Pulling
   * the bytes here and saving from a blob keeps the request in-app everywhere.
   */
  downloadAttachment(messageId: string, attachmentId: string) {
    return this.http.getBlob(
      `/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }
}
