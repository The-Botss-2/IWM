'use client';

import { FileText, Loader2, Paperclip, Send, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileObject, SendMailMessageInput } from '@botss/shared-types';

import { MailEditor } from '@/components/mail/mail-editor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFileUpload } from '@/hooks/use-file-upload';
import { useMailRecipientSuggestions } from '@/hooks/use-mail';
import { useMailAccounts } from '@/hooks/use-mail-accounts';
import { useDiscardMailDraft, useSaveMailDraft, useSendMail } from '@/hooks/use-mail-send';
import { toast, toastError, toastErrorMessage } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface ComposePrefill {
  to?: string;
  cc?: string;
  subject?: string;
  /** Plain-text seed used as a fallback when no html is provided. */
  body?: string;
  /** Optional HTML seed (preferred when present). */
  bodyHtml?: string;
  inReplyToMessageId?: string;
  draftMessageId?: string;
  /** Reply, reply-all, or forward - selects the reply signature default and
   *  controls signature placement relative to the quoted text. Forwards have
   *  no inReplyToMessageId, so this flag is the authoritative signal. */
  isReply?: boolean;
  /** Files already attached when the dialog opens, e.g. an invoice PDF. */
  attachments?: FileObject[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  fromLabel: string;
  prefill?: ComposePrefill | null;
  /** Called after the message is queued for sending. */
  onSent?: () => void;
}

export function ComposeMailDialog({
  open,
  onOpenChange,
  accountId,
  fromLabel,
  prefill,
  onSent,
}: Props) {
  const send = useSendMail();
  const saveDraft = useSaveMailDraft();
  const discardDraft = useDiscardMailDraft();
  const upload = useFileUpload();
  // Suggest addresses the user has previously sent to. Fetched lazily once
  // the dialog is open; rendered into a <datalist> the To/Cc inputs point at
  // so the browser autocompletes natively as the user types.
  const recipientSuggestions = useMailRecipientSuggestions(open ? accountId : null);
  const suggestionItems = recipientSuggestions.data?.items ?? [];

  // The sending account's saved signatures + defaults. Read through a ref at
  // open-time so a late accounts-query resolve doesn't re-seed the editor and
  // wipe what the user has typed.
  const accounts = useMailAccounts();
  const account = accounts.data?.items.find((a) => a.id === accountId) ?? null;
  const accountRef = useRef(account);
  accountRef.current = account;

  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  // Body html/text are stored in refs, not state. The Tiptap editor owns its
  // own DOM and fires onUpdate on every keystroke - routing that into React
  // state used to re-render the entire dialog (every Field, every button)
  // on each character, costing ~5–15ms per keystroke on mid-range hardware
  // for long messages. Refs let typing skip React's render cycle entirely
  // while we still have synchronous access at submit/save time.
  const bodyHtmlRef = useRef<string>('');
  const bodyTextRef = useRef<string>('');
  const [attachments, setAttachments] = useState<FileObject[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const lastSaved = useRef<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Stable identity used to force-reset the editor on open without remounting
  // the whole dialog. Bumped every time we hydrate from a prefill.
  const [editorResetKey, setEditorResetKey] = useState<string>('init');
  const initialHtmlRef = useRef<string>('');

  useEffect(() => {
    if (open) {
      const next = prefill ?? null;
      setTo(next?.to ?? '');
      setCc(next?.cc ?? '');
      setSubject(next?.subject ?? '');
      const seededBody = next?.bodyHtml ?? (next?.body ? plainToHtml(next.body) : '');
      // Append the saved signature for new messages and replies, but NOT when
      // editing a saved draft - that body already contains whatever signature
      // it was composed with, so re-appending would duplicate it.
      const isDraftEdit = Boolean(next?.draftMessageId);
      const isReply = Boolean(next?.isReply || next?.inReplyToMessageId);
      const acct = accountRef.current;
      // New mail and replies/forwards each have their own default signature.
      const sigId = isReply ? acct?.replySignatureId : acct?.newSignatureId;
      const sig = (sigId && acct?.signatures.find((s) => s.id === sigId)?.html) || '';
      const initialHtml =
        sig && !isDraftEdit
          ? // For replies, "before quote" puts the signature above the quoted
            // text (with a blank line to type into); otherwise it trails it.
            // New mail has no quote, so the signature simply follows the body.
            isReply && acct?.signatureBeforeQuote
            ? `<p><br></p>${sig}${seededBody}`
            : `${seededBody}<p><br></p>${sig}`
          : seededBody;
      initialHtmlRef.current = initialHtml;
      bodyHtmlRef.current = initialHtml;
      bodyTextRef.current = next?.body ?? '';
      setAttachments(next?.attachments ?? []);
      setDraftId(next?.draftMessageId ?? null);
      lastSaved.current = snapshot(next?.to, next?.cc, next?.subject, next?.body);
      setEditorResetKey(`open-${Date.now()}`);
    }
  }, [open, prefill]);

  const reset = () => {
    setTo('');
    setCc('');
    setSubject('');
    bodyHtmlRef.current = '';
    bodyTextRef.current = '';
    setAttachments([]);
    setDraftId(null);
    initialHtmlRef.current = '';
    lastSaved.current = '';
  };

  // Stable callback identity: keeps the MailEditor effect dependencies
  // shallow so the underlying Tiptap instance doesn't get reconfigured on
  // every parent render.
  const handleEditorChange = useCallback((next: { html: string; text: string }) => {
    bodyHtmlRef.current = next.html;
    bodyTextRef.current = next.text;
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const toList = splitEmails(to);
    const ccList = splitEmails(cc);
    const bodyHtml = bodyHtmlRef.current;
    const bodyText = bodyTextRef.current;

    if (toList.length === 0) {
      toastErrorMessage('Add at least one recipient');
      return;
    }
    if (!subject.trim() && !bodyText.trim() && attachments.length === 0) {
      toastErrorMessage('Add a subject, body, or attachment before sending');
      return;
    }

    const input: SendMailMessageInput = {
      accountId,
      to: toList,
      ...(ccList.length > 0 ? { cc: ccList } : {}),
      subject: subject.trim(),
      bodyText,
      ...(bodyHtml.trim() ? { bodyHtml } : {}),
      ...(prefill?.inReplyToMessageId ? { inReplyToMessageId: prefill.inReplyToMessageId } : {}),
      ...(attachments.length > 0 ? { attachmentFileObjectIds: attachments.map((a) => a.id) } : {}),
      ...(draftId ? { replacesDraftId: draftId } : {}),
    };

    try {
      await send.mutateAsync(input);
      reset();
      onOpenChange(false);
      onSent?.();
    } catch {
      // Toast surfaced by mutation onError
    }
  };

  const handleSaveDraft = async () => {
    const toList = splitEmails(to);
    const ccList = splitEmails(cc);
    const bodyHtml = bodyHtmlRef.current;
    const bodyText = bodyTextRef.current;
    try {
      const result = await saveDraft.mutateAsync({
        accountId,
        ...(toList.length > 0 ? { to: toList } : {}),
        ...(ccList.length > 0 ? { cc: ccList } : {}),
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        bodyText,
        ...(bodyHtml.trim() ? { bodyHtml } : {}),
        ...(prefill?.inReplyToMessageId ? { inReplyToMessageId: prefill.inReplyToMessageId } : {}),
        // Carry attachments into the draft so reopening the saved draft
        // still surfaces the files. Same shape and 20-cap as the send
        // path on the other side of the API.
        ...(attachments.length > 0
          ? { attachmentFileObjectIds: attachments.map((a) => a.id) }
          : {}),
        ...(draftId ? { replacesDraftId: draftId } : {}),
      });
      setDraftId(result.draftMessageId);
      lastSaved.current = snapshot(to, cc, subject, bodyText);
      toast.success('Draft saved.');
    } catch (err) {
      toastError(err, "Couldn't save draft");
    }
  };

  const handleDiscard = async () => {
    if (!draftId) {
      reset();
      onOpenChange(false);
      return;
    }
    try {
      await discardDraft.mutateAsync(draftId);
      toast.success('Draft discarded.');
      reset();
      onOpenChange(false);
    } catch (err) {
      toastError(err, "Couldn't discard draft");
    }
  };

  const handlePickFile = () => fileInputRef.current?.click();

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Upload sequentially to keep the toast story sensible and avoid
    // hammering the S3 PUT endpoint with parallel uploads from one user.
    for (const file of Array.from(files)) {
      try {
        const uploaded = await upload.mutateAsync(file);
        setAttachments((prev) => [...prev, uploaded]);
      } catch (err) {
        toastError(err, `Couldn't upload ${file.name}`);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {prefill?.inReplyToMessageId
              ? 'Reply'
              : prefill?.draftMessageId
                ? 'Edit draft'
                : 'New message'}
          </DialogTitle>
          <DialogDescription className="text-ink-muted text-xs">
            From <span className="font-mono">{fromLabel}</span>
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-3" onSubmit={submit} noValidate>
          <Field label="To" htmlFor="mc-to" required>
            <RecipientInput
              id="mc-to"
              placeholder="recipient@example.com"
              value={to}
              onChange={setTo}
              suggestions={suggestionItems}
              autoFocus
            />
          </Field>

          <Field label="Cc" htmlFor="mc-cc">
            <RecipientInput
              id="mc-cc"
              placeholder="optional, comma separated"
              value={cc}
              onChange={setCc}
              suggestions={suggestionItems}
            />
          </Field>

          <Field label="Subject" htmlFor="mc-subject">
            <Input
              id="mc-subject"
              autoComplete="off"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>

          <div className="space-y-1">
            <Label>Body</Label>
            <MailEditor
              initialHtml={initialHtmlRef.current}
              resetKey={editorResetKey}
              onChange={handleEditorChange}
              placeholder="Write your message…"
            />
          </div>

          {attachments.length > 0 || upload.isPending ? (
            <ul className="flex flex-wrap gap-2" aria-label="Attachments" role="list">
              {attachments.map((a) => (
                <li
                  key={a.id}
                  className="border-line bg-bg-subtle text-ink inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                >
                  <Paperclip className="text-ink-disabled h-3.5 w-3.5" />
                  <span className="max-w-[180px] truncate">{a.filename}</span>
                  <span className="text-ink-muted text-[10px]">
                    {formatBytes(Number(a.sizeBytes))}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.filename}`}
                    className="text-ink-disabled hover:bg-line hover:text-ink rounded p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
              {upload.isPending ? (
                <li className="border-line bg-bg-subtle text-ink-muted inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Uploading…
                </li>
              ) : null}
            </ul>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />

          <DialogFooter className="flex flex-row flex-wrap items-center gap-2 sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handlePickFile}
                disabled={upload.isPending || send.isPending}
                aria-label="Attach files"
              >
                <Paperclip className="h-4 w-4" />
                Attach
              </Button>
              {draftId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleDiscard}
                  disabled={discardDraft.isPending || send.isPending}
                  aria-label="Discard draft"
                >
                  <Trash2 className="h-4 w-4" />
                  Discard
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={handleSaveDraft}
                disabled={saveDraft.isPending || send.isPending}
              >
                {saveDraft.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Saving...
                  </>
                ) : (
                  <>
                    <FileText className="h-4 w-4" /> Save draft
                  </>
                )}
              </Button>
              <Button type="submit" disabled={send.isPending || saveDraft.isPending}>
                {send.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" /> Send
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Address input with token-aware autocomplete. Unlike a native <datalist>
 * (which matches its options against the WHOLE field value and therefore stops
 * suggesting once the value contains a comma), this filters the suggestion list
 * against only the current token - the text after the last comma/semicolon - so
 * Cc and multi-recipient To fields keep suggesting after every separator.
 */
function RecipientInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  suggestions: string[];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Everything up to and including the last separator is "committed"; the tail
  // is the token currently being typed and the only thing we filter on.
  const lastSep = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'));
  const head = value.slice(0, lastSep + 1);
  const currentToken = value
    .slice(lastSep + 1)
    .trim()
    .toLowerCase();

  // Addresses already committed in the field - don't re-suggest them.
  const chosen = new Set(
    head
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  const matches = suggestions
    .filter((addr) => !chosen.has(addr.toLowerCase()))
    .filter((addr) => (currentToken ? addr.toLowerCase().includes(currentToken) : true))
    .slice(0, 8);

  const showList = open && matches.length > 0;
  const activeIndex = Math.min(highlight, matches.length - 1);

  const choose = (addr: string) => {
    const committed = head.replace(/\s*$/, '');
    onChange(committed ? `${committed} ${addr}, ` : `${addr}, `);
    setOpen(false);
    setHighlight(0);
    // Keep focus so the user can keep adding recipients.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div className="relative">
      <Input
        id={id}
        ref={inputRef}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so a click on a suggestion registers before the list closes.
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => (h + 1) % matches.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => (h - 1 + matches.length) % matches.length);
          } else if (e.key === 'Enter') {
            // Accept the highlighted suggestion instead of submitting the form.
            e.preventDefault();
            choose(matches[activeIndex]!);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {showList ? (
        <ul
          role="listbox"
          className="border-line bg-bg-surface absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-md border py-1 shadow-md"
        >
          {matches.map((addr, i) => (
            <li key={addr}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => {
                  // Prevent the input's blur from firing before the click.
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                }}
                onClick={() => choose(addr)}
                className={cn(
                  'text-ink block w-full truncate px-3 py-1.5 text-left text-sm',
                  i === activeIndex ? 'bg-bg-subtle' : 'hover:bg-bg-subtle',
                )}
              >
                {addr}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="text-state-error ml-1" aria-label="required">
            *
          </span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

function snapshot(
  to: string | undefined,
  cc: string | undefined,
  subject: string | undefined,
  body: string | undefined,
): string {
  return JSON.stringify({ to: to ?? '', cc: cc ?? '', subject: subject ?? '', body: body ?? '' });
}

function splitEmails(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const v = part.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function plainToHtml(text: string): string {
  // Replies arrive with quoted plain-text bodies; turn newlines into <br> so
  // the editor preserves the existing line breaks instead of collapsing them.
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? line : '&nbsp;'))
    .map((line) => `<p>${line}</p>`)
    .join('');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
