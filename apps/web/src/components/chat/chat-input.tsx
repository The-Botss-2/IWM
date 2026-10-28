'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bold,
  Code2,
  ImagePlus,
  Italic,
  Link2,
  List,
  Mic,
  Send,
  Square,
  Strikethrough,
  X,
} from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import dynamic from 'next/dynamic';
import type { ChatAttachmentInput, ChatRoomMessage } from '@botss/shared-types';

import { ChatComposer, type StagedItem } from '@/components/chat/chat-composer';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  appendIncomingRoomMessage,
  insertOptimisticRoomMessage,
  removeRoomMessage,
  useEditMessage,
} from '@/hooks/use-chat';
import { useFileUpload } from '@/hooks/use-file-upload';
import { getApi } from '@/lib/api';
import { getChatSocket } from '@/lib/chat-socket';
import { promptDialog } from '@/lib/prompt';
import { toastErrorMessage, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

// Canvas-based image editor - only needed when the user edits a staged image.
const ImageEditorDialog = dynamic(
  () =>
    import('@/components/chat/image-editor-dialog').then((m) => ({
      default: m.ImageEditorDialog,
    })),
  { ssr: false },
);

/**
 * In-flight attachment uploads keyed by the optimistic message nonce. The
 * in-thread cancel (X) lives in a different component (chat-window) than the
 * sender, so it reaches the AbortController through this module-level map.
 */
const attachmentUploadAborters = new Map<string, AbortController>();
export function abortChatAttachmentUpload(nonce: string): void {
  attachmentUploadAborters.get(nonce)?.abort();
}

/** presign -> PUT (abortable) -> confirm, threading an AbortSignal so
 *  cancelling actually stops the transfer. */
async function uploadFileAbortable(file: File, signal: AbortSignal): Promise<ChatAttachmentInput> {
  const confirmed = await getApi().files.upload(file, { signal });
  return {
    fileUrl: confirmed.url ?? '',
    fileType: confirmed.mimeType,
    fileName: confirmed.filename,
    fileSize: Number(confirmed.sizeBytes),
  };
}

interface ReplyTarget {
  id: string;
  senderName: string;
  content: string | null;
}

interface Props {
  roomId: string;
  currentUserId: string;
  replyTo?: ReplyTarget | null;
  onClearReply?: () => void;
  /** When set, the composer is in edit mode for this message id; submitting
   *  saves the edit instead of sending a new message. */
  editing?: { id: string; content: string } | null;
  onClearEdit?: () => void;
}

const TYPING_PING_INTERVAL_MS = 2_500;

/** Imperative surface so chat-window's pane-level drag-and-drop can stage
 *  dropped files into this composer. */
export interface ChatInputHandle {
  addFiles: (files: FileList | File[]) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  { roomId, currentUserId, replyTo, onClearReply, editing, onClearEdit },
  ref,
) {
  const [value, setValue] = useState('');
  // Staged attachments awaiting send (drag-drop or the attach button). When
  // non-empty the full-screen ChatComposer overlay takes over; `value`
  // doubles as the caption. Object URLs in `previewUrl` are revoked on
  // remove / discard / after a successful send.
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sendingAttachments, setSendingAttachments] = useState(false);
  const qc = useQueryClient();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const typingActiveRef = useRef(false);
  const lastPingRef = useRef(0);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editMessage = useEditMessage();

  useEffect(() => {
    if (replyTo) taRef.current?.focus();
  }, [replyTo]);

  // Entering edit mode prefills the box with the existing body and focuses it.
  // Keyed on the message id so re-selecting the same target re-seeds the text.
  useEffect(() => {
    if (editing) {
      setValue(editing.content);
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  // Auto-grow the message box up to ~8 lines, then scroll. Reset to `auto`
  // first so it also SHRINKS back down as text is deleted. The 200px cap
  // (~8 lines at this box's line-height) is mirrored by `max-h-[200px]` on
  // the textarea so growth and the scroll boundary stay in sync.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  // Expose staging to chat-window so a file dropped anywhere on the
  // conversation pane lands in this composer. `addFiles` is a hoisted
  // declaration below; it only closes over the stable `setStaged`.
  useImperativeHandle(ref, () => ({ addFiles }));

  // Mirror staged into a ref so the unmount cleanup can revoke object URLs
  // without re-subscribing the effect on every staging change.
  const stagedRef = useRef<StagedItem[]>([]);
  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);
  useEffect(
    () => () => {
      for (const it of stagedRef.current) URL.revokeObjectURL(it.previewUrl);
    },
    [],
  );

  // Switching rooms abandons any half-composed attachments.
  useEffect(() => {
    setEditingId(null);
    setStaged((prev) => {
      for (const it of prev) URL.revokeObjectURL(it.previewUrl);
      return [];
    });
  }, [roomId]);

  const sendMutation = useMutation({
    mutationFn: ({
      content,
      nonce,
      parentMessageId,
      attachments,
    }: {
      content?: string;
      nonce: string;
      parentMessageId?: string;
      attachments?: ChatAttachmentInput[];
    }) =>
      getApi().chat.sendMessage(roomId, {
        ...(content ? { content } : {}),
        clientNonce: nonce,
        ...(parentMessageId ? { parentMessageId } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }),
    onSuccess: (res, vars) => {
      appendIncomingRoomMessage(qc, roomId, {
        ...res.message,
        clientNonce: vars.nonce,
      });
      taRef.current?.focus();
    },
    // The toast comes from meta.errorTitle (global mutation handler).
    onError: (err) => {
      console.error('[chat] send failed:', err);
    },
    meta: { errorTitle: "Couldn't send message" },
  });
  const pending = sendMutation.isPending;
  const upload = useFileUpload();

  // Voice-note recording state. Kept in refs (and one piece of state for the
  // UI flip) because MediaRecorder events fire synchronously and the React
  // state batcher would otherwise drop chunks before we get to read them.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartedAtRef = useRef<number>(0);
  // Set when the user cancels mid-recording so the `stop` handler knows to
  // throw the bytes away instead of uploading them.
  const recordCancelledRef = useRef(false);

  const stopRecorderHardware = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    const stream = recordStreamRef.current;
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
    }
    recordStreamRef.current = null;
    setRecording(false);
    setRecordSeconds(0);
  };

  async function startRecording(): Promise<void> {
    if (recording || pending) return;
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toastErrorMessage("Couldn't start recording", {
        description: 'This browser cannot record audio. Try a recent Chrome, Edge or Safari.',
      });
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      toastErrorMessage("Couldn't start recording", {
        description: 'This browser cannot record audio. Try a recent Chrome, Edge or Safari.',
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Pick whichever audio format the browser actually supports. Chrome /
      // Firefox prefer webm/opus; Safari only ships mp4/aac. Falling through
      // to the default `MediaRecorder()` shape lets each browser write the
      // codec it knows; we then send the resulting MIME upstream so the
      // playback `<audio>` tag picks the right decoder.
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      const mimeType = candidates.find(
        (m) =>
          typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(m),
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recordChunksRef.current = [];
      recordCancelledRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const chunks = recordChunksRef.current;
        recordChunksRef.current = [];
        stopRecorderHardware();
        if (recordCancelledRef.current || chunks.length === 0) return;
        const blobType = chunks[0]?.type || mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type: blobType });
        // Send the voice note as a chat attachment. We bypass the optimistic
        // text-only render because the timestamp + status tick rendering
        // already covers the "in-flight" UI for attachments-only messages.
        try {
          const ext = blobType.includes('mp4') ? 'm4a' : blobType.includes('ogg') ? 'ogg' : 'webm';
          const filename = `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
          const file = new File([blob], filename, { type: blobType });
          const fileObj = await upload.mutateAsync(file);
          const nonce = `tmp:${crypto.randomUUID()}`;
          sendMutation.mutate({
            nonce,
            attachments: [
              {
                fileUrl: fileObj.url ?? '',
                fileType: fileObj.mimeType,
                fileName: fileObj.filename,
                fileSize: Number(fileObj.sizeBytes),
              },
            ],
            ...(replyTo ? { parentMessageId: replyTo.id } : {}),
          });
          onClearReply?.();
        } catch (err) {
          console.error('[chat] voice send failed:', err);
          toastError(err, "Couldn't send voice note");
        }
      };
      recordStreamRef.current = stream;
      recorderRef.current = recorder;
      recordStartedAtRef.current = Date.now();
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartedAtRef.current) / 1000);
        setRecordSeconds(elapsed);
        // Hard cap at 2 minutes - voice notes longer than that belong in
        // a proper call. Auto-stops and uploads what we have.
        if (elapsed >= 120) {
          recorder.stop();
        }
      }, 250);
    } catch (err) {
      console.error('[chat] mic access failed:', err);
      const name = (err as { name?: unknown } | null)?.name;
      toastErrorMessage("Couldn't start recording", {
        description:
          name === 'NotFoundError'
            ? 'No microphone was found. Plug one in and try again.'
            : name === 'NotAllowedError' || name === 'SecurityError'
              ? 'Microphone access is blocked. Allow it in your browser or system settings.'
              : 'The microphone could not be opened. Another app may be using it.',
      });
      stopRecorderHardware();
    }
  }

  function stopRecording(send: boolean): void {
    const recorder = recorderRef.current;
    if (!recorder) {
      stopRecorderHardware();
      return;
    }
    recordCancelledRef.current = !send;
    if (recorder.state === 'recording') {
      try {
        recorder.stop();
      } catch (err) {
        console.error('[chat] recorder stop failed:', err);
        // `onstop` never fires, so the clip is lost - tell the user if they
        // were trying to send it.
        if (send) toastError(err, "Couldn't finish the voice note");
        stopRecorderHardware();
      }
    } else {
      stopRecorderHardware();
    }
  }

  // Tear down the recorder if the room changes mid-recording or component
  // unmounts. We don't auto-send a half-recorded clip on unmount because
  // the user navigated away on purpose.
  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        recordCancelledRef.current = true;
        try {
          recorderRef.current.stop();
        } catch {
          /* hardware cleanup happens in stopRecorderHardware below */
        }
      }
      stopRecorderHardware();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    };
  }, [roomId]);

  useEffect(() => {
    return () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      if (typingActiveRef.current) {
        getChatSocket().emit('typing_stop', { roomId });
        typingActiveRef.current = false;
      }
    };
  }, [roomId]);

  function notifyTyping(): void {
    const now = Date.now();
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      lastPingRef.current = now;
      getChatSocket().emit('typing_start', { roomId });
    } else if (now - lastPingRef.current > TYPING_PING_INTERVAL_MS) {
      lastPingRef.current = now;
      getChatSocket().emit('typing_start', { roomId });
    }
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = setTimeout(() => {
      typingActiveRef.current = false;
      getChatSocket().emit('typing_stop', { roomId });
    }, 3_000);
  }

  function stopTypingNow(): void {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      getChatSocket().emit('typing_stop', { roomId });
    }
  }

  const filePickerRef = useRef<HTMLInputElement>(null);

  /** Stage files for the composer (any MIME type). Images become editable. */
  function addFiles(files: FileList | File[]): void {
    const items = Array.from(files).map<StagedItem>((file) => ({
      id: `st:${crypto.randomUUID()}`,
      file,
      kind: file.type.startsWith('image/') ? 'image' : 'file',
      previewUrl: URL.createObjectURL(file),
    }));
    if (items.length === 0) return;
    setStaged((prev) => [...prev, ...items]);
  }

  function removeStaged(id: string): void {
    setStaged((prev) => {
      const it = prev.find((x) => x.id === id);
      if (it) URL.revokeObjectURL(it.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  }

  /** Discard the whole compose tray (revoking previews). */
  function discardStaged(): void {
    setStaged((prev) => {
      for (const it of prev) URL.revokeObjectURL(it.previewUrl);
      return [];
    });
  }

  const editingItem = staged.find((s) => s.id === editingId) ?? null;

  /** Replace a staged image with its edited (cropped/annotated) version. */
  function onEditorConfirm(edited: File): void {
    setStaged((prev) =>
      prev.map((s) => {
        if (s.id !== editingId) return s;
        URL.revokeObjectURL(s.previewUrl);
        return { ...s, file: edited, kind: 'image', previewUrl: URL.createObjectURL(edited) };
      }),
    );
    setEditingId(null);
  }

  /**
   * Send all staged attachments as one message with an optional caption,
   * WhatsApp-style: the bubble appears IMMEDIATELY with the local previews and
   * an uploading overlay (loader + cancel X, rendered by chat-window), then
   * swaps to the real message once every file finishes uploading. Cancelling
   * aborts the in-flight transfer and removes the bubble.
   */
  async function sendStaged(): Promise<void> {
    if (staged.length === 0 || sendingAttachments) return;
    const snapshot = staged;
    const caption = normalisePastedWhitespace(value);
    const nonce = `tmp:${crypto.randomUUID()}`;
    const controller = new AbortController();
    attachmentUploadAborters.set(nonce, controller);

    const optimistic = {
      id: nonce,
      roomId,
      senderId: currentUserId,
      content: caption || null,
      status: 'SENT' as const,
      createdAt: new Date(),
      editedAt: null,
      deletedAt: null,
      attachments: snapshot.map((it, idx) => ({
        id: `${nonce}:att:${idx}`,
        messageId: nonce,
        fileUrl: it.previewUrl,
        fileType: it.file.type || 'application/octet-stream',
        fileName: it.file.name,
        fileSize: it.file.size,
      })),
      reactions: [],
      parentMessageId: replyTo?.id ?? null,
      parentMessage: replyTo
        ? {
            id: replyTo.id,
            senderId: '',
            content: replyTo.content,
            createdAt: new Date(),
            deletedAt: null,
          }
        : null,
      clientNonce: nonce,
      // Transient flag read by chat-window to show the uploading overlay.
      __uploading: true,
    };
    insertOptimisticRoomMessage(
      qc,
      roomId,
      optimistic as unknown as ChatRoomMessage & { clientNonce: string },
    );

    // Close the composer WITHOUT revoking previews - the optimistic bubble is
    // still showing them. They're revoked in `finally` once the send settles.
    setStaged([]);
    setValue('');
    setSendingAttachments(true);
    stopTypingNow();
    onClearReply?.();

    try {
      const attachments: ChatAttachmentInput[] = [];
      for (const it of snapshot) {
        attachments.push(await uploadFileAbortable(it.file, controller.signal));
      }
      const res = await getApi().chat.sendMessage(roomId, {
        ...(caption ? { content: caption } : {}),
        clientNonce: nonce,
        attachments,
        ...(replyTo ? { parentMessageId: replyTo.id } : {}),
      });
      appendIncomingRoomMessage(qc, roomId, { ...res.message, clientNonce: nonce });
    } catch (err) {
      // Cancel or failure: drop the optimistic bubble. Stay quiet on an
      // explicit cancel; surface real failures.
      removeRoomMessage(qc, roomId, nonce);
      const aborted =
        controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
      if (!aborted) {
        console.error('[chat] attachment send failed:', err);
        toastError(err, "Couldn't send attachment");
      }
    } finally {
      attachmentUploadAborters.delete(nonce);
      setSendingAttachments(false);
      for (const it of snapshot) URL.revokeObjectURL(it.previewUrl);
    }
  }

  /**
   * Clean text arriving via copy/paste. Chat is a flat-text surface - we
   * don't preserve code-block indentation here. The previous "shared
   * minimum dedent" left per-line drift whenever the pasted text had
   * uneven leading whitespace (think wrapped base64 from a doc or
   * inconsistently-indented prose). Strip leading whitespace on every
   * line so each line of the bubble starts at the same x-position.
   *
   * Also normalises CRLF + collapses tabs to single spaces + collapses
   * runs of 3+ blank lines to one, so a paste of a tab-indented table
   * doesn't blow up the bubble vertically.
   */
  function normalisePastedWhitespace(raw: string): string {
    return (
      raw
        // Normalise line endings.
        .replace(/\r\n?/g, '\n')
        // Strip BOM and zero-width characters that some copy sources inject.
        .replace(/[﻿​-‍⁠]/g, '')
        // Split into lines, strip leading whitespace per line, collapse any
        // run of internal tabs/multiple spaces to a single space (preserves
        // intentional single spaces between words).
        .split('\n')
        .map((line) =>
          line
            .replace(/^[ \t]+/, '')
            .replace(/[ \t]+/g, ' ')
            .trimEnd(),
        )
        .join('\n')
        // Collapse runs of 3+ blank lines down to a single blank line so
        // pasted prose doesn't blow up the bubble vertically.
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  }

  function send(): void {
    const text = normalisePastedWhitespace(value);
    if (!text) return;
    // Edit mode: save the existing message body rather than sending a new one.
    if (editing) {
      if (editMessage.isPending) return;
      // No-op if unchanged - just close the editor.
      if (text === normalisePastedWhitespace(editing.content)) {
        setValue('');
        onClearEdit?.();
        return;
      }
      editMessage.mutate(
        { messageId: editing.id, content: text },
        {
          onSuccess: () => {
            setValue('');
            stopTypingNow();
            onClearEdit?.();
          },
        },
      );
      return;
    }
    if (pending) return;
    const nonce = `tmp:${crypto.randomUUID()}`;
    const optimistic: ChatRoomMessage & { clientNonce: string } = {
      id: nonce,
      roomId,
      senderId: currentUserId,
      content: text,
      status: 'SENT',
      createdAt: new Date(),
      editedAt: null,
      deletedAt: null,
      attachments: [],
      reactions: [],
      parentMessageId: replyTo?.id ?? null,
      parentMessage: replyTo
        ? {
            id: replyTo.id,
            senderId: '',
            content: replyTo.content,
            createdAt: new Date(),
            deletedAt: null,
          }
        : null,
      clientNonce: nonce,
    };
    insertOptimisticRoomMessage(qc, roomId, optimistic);
    setValue('');
    stopTypingNow();
    sendMutation.mutate({
      content: text,
      nonce,
      ...(replyTo ? { parentMessageId: replyTo.id } : {}),
    });
    onClearReply?.();
  }

  function formatRecordSeconds(s: number): string {
    const mm = Math.floor(s / 60)
      .toString()
      .padStart(1, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Formatting shortcuts. Italic is deliberately a *asterisk* marker, not an
    // underscore, so typed underscores never turn into italics.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        surround('**');
        return;
      }
      if (k === 'i') {
        e.preventDefault();
        surround('*');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape' && editing) {
      e.preventDefault();
      setValue('');
      onClearEdit?.();
    }
  }

  /** Wrap the current textarea selection with markdown markers (Slack /
   *  WhatsApp style). With no selection, inserts the markers around a caret. */
  function surround(marker: string): void {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const sel = value.slice(start, end);
    const next = value.slice(0, start) + marker + sel + marker + value.slice(end);
    setValue(next);
    notifyTyping();
    requestAnimationFrame(() => {
      ta.focus();
      const innerStart = start + marker.length;
      ta.selectionStart = innerStart;
      ta.selectionEnd = innerStart + sel.length;
    });
  }

  function insertLinkMarkdown(): void {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const label = value.slice(start, end) || 'text';
    // window.prompt is a no-op in the Electron desktop shell, so URL entry
    // goes through the in-app prompt dialog instead.
    void promptDialog({
      title: 'Insert link',
      description: 'Enter the web address to link to.',
      defaultValue: 'https://',
      placeholder: 'https://example.com',
      confirmLabel: 'Insert',
      inputType: 'url',
    }).then((url) => {
      if (!url || !url.trim()) return;
      const md = `[${label}](${url.trim()})`;
      const next = value.slice(0, start) + md + value.slice(end);
      setValue(next);
      notifyTyping();
      requestAnimationFrame(() => {
        ta.focus();
        const caret = start + md.length;
        ta.selectionStart = ta.selectionEnd = caret;
      });
    });
  }

  /** Prefix each line of the selection with "- " to make a bullet list. */
  function bulletSelection(): void {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const nl = value.indexOf('\n', end);
    const lineEnd = nl === -1 ? value.length : nl;
    const block = value.slice(lineStart, lineEnd);
    const bulleted = block
      .split('\n')
      .map((l) => (/^\s*-\s/.test(l) ? l : `- ${l}`))
      .join('\n');
    const next = value.slice(0, lineStart) + bulleted + value.slice(lineEnd);
    setValue(next);
    notifyTyping();
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = lineStart;
      ta.selectionEnd = lineStart + bulleted.length;
    });
  }

  /** Wrap the selection in a fenced code block (```). Nothing inside is
   *  formatted, so it's the right tool for code, paths, or any text with
   *  underscores / asterisks that shouldn't turn into emphasis. */
  function insertCodeBlock(): void {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const sel = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);
    // Keep the fences on their own lines so the block parses cleanly even when
    // the caret sits mid-line.
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const trail = after && !after.startsWith('\n') ? '\n' : '';
    const next = `${before}${lead}\`\`\`\n${sel}\n\`\`\`${trail}${after}`;
    setValue(next);
    notifyTyping();
    requestAnimationFrame(() => {
      ta.focus();
      // Caret lands on the (possibly empty) content line, inside the fences.
      const caret = before.length + lead.length + 4; // past "```\n"
      ta.selectionStart = caret;
      ta.selectionEnd = caret + sel.length;
    });
  }

  return (
    <>
      <div className="border-line dark:bg-ink border-t bg-white p-3 dark:border-slate-700">
        {editing ? (
          <div className="border-brand-purple bg-bg-subtle mb-2 flex items-start gap-2 rounded-md border-l-2 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-brand-gradient text-[11px] font-semibold">Editing message</div>
              <div className="text-ink-muted line-clamp-2 text-xs">
                Enter to save · Esc to cancel
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Cancel edit"
              onClick={() => {
                setValue('');
                onClearEdit?.();
              }}
              className="text-ink-muted h-6 w-6"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
        {replyTo && !editing ? (
          <div className="border-brand-purple bg-bg-subtle mb-2 flex items-start gap-2 rounded-md border-l-2 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-brand-gradient text-[11px] font-semibold">
                Replying to {replyTo.senderName}
              </div>
              <div className="text-ink-muted line-clamp-2 text-xs">
                {replyTo.content ?? '(no text)'}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Cancel reply"
              onClick={onClearReply}
              className="text-ink-muted h-6 w-6"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
        {!recording ? (
          <div className="mb-1.5 flex items-center gap-0.5">
            <FormatButton label="Bold (Ctrl+B)" onClick={() => surround('**')}>
              <Bold className="h-3.5 w-3.5" />
            </FormatButton>
            <FormatButton label="Italic (Ctrl+I)" onClick={() => surround('*')}>
              <Italic className="h-3.5 w-3.5" />
            </FormatButton>
            <FormatButton label="Strikethrough" onClick={() => surround('~')}>
              <Strikethrough className="h-3.5 w-3.5" />
            </FormatButton>
            <FormatButton label="Code block" onClick={insertCodeBlock}>
              <Code2 className="h-3.5 w-3.5" />
            </FormatButton>
            <FormatButton label="Bulleted list" onClick={bulletSelection}>
              <List className="h-3.5 w-3.5" />
            </FormatButton>
            <FormatButton label="Insert link" onClick={insertLinkMarkdown}>
              <Link2 className="h-3.5 w-3.5" />
            </FormatButton>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          {recording ? (
            // Recording mode: hide the textarea entirely and show a single
            // live-status pill plus cancel/send controls. WhatsApp-style;
            // keeps the affordance unambiguous so the user can't accidentally
            // type while a recording is in flight.
            <div
              role="status"
              aria-live="polite"
              className="bg-tint-error text-state-error ring-state-error/30 flex h-10 flex-1 items-center gap-3 rounded-full px-4 text-sm ring-1"
            >
              <span aria-hidden className="bg-state-error h-2 w-2 animate-pulse rounded-full" />
              <span className="font-mono tabular-nums">{formatRecordSeconds(recordSeconds)}</span>
              <span className="text-state-error/80 text-xs">Recording…</span>
            </div>
          ) : (
            <Textarea
              ref={taRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (e.target.value.length > 0) notifyTyping();
                else stopTypingNow();
              }}
              onPaste={(e) => {
                // Ctrl+V of an image (screenshot / copied picture) stages it as
                // an attachment - same path as the attach button and drag-drop -
                // instead of dropping nothing useful into the text box.
                const pastedImages = e.clipboardData
                  ? Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
                  : [];
                if (pastedImages.length > 0) {
                  e.preventDefault();
                  addFiles(pastedImages);
                  return;
                }
                // Intercept paste so the preview text in the box matches what
                // gets sent. Without this the user pastes "    weird indent",
                // hits Enter, and only on send does normalisation kick in -
                // the inflight render in the bubble can still look skewed
                // before the optimistic message gets replaced.
                const raw = e.clipboardData?.getData('text');
                if (!raw) return;
                e.preventDefault();
                const ta = e.currentTarget;
                const cleaned = normalisePastedWhitespace(raw);
                const start = ta.selectionStart ?? value.length;
                const end = ta.selectionEnd ?? value.length;
                const nextValue = value.slice(0, start) + cleaned + value.slice(end);
                setValue(nextValue);
                if (nextValue.length > 0) notifyTyping();
                // Restore cursor immediately after the inserted snippet.
                requestAnimationFrame(() => {
                  ta.selectionStart = ta.selectionEnd = start + cleaned.length;
                });
              }}
              onBlur={stopTypingNow}
              onKeyDown={onKeyDown}
              placeholder="Message - Enter to send, Shift+Enter for newline."
              rows={1}
              className="bg-bg-surface text-ink max-h-[200px] min-h-[40px] flex-1 resize-none overflow-y-auto rounded-2xl px-4 py-2"
            />
          )}

          {recording ? (
            <>
              <Button
                type="button"
                onClick={() => stopRecording(false)}
                aria-label="Cancel recording"
                variant="ghost"
                className="text-ink-muted hover:text-ink h-10 w-10 rounded-full p-0"
              >
                <X className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                onClick={() => stopRecording(true)}
                aria-label="Stop and send recording"
                disabled={upload.isPending || pending}
                className="bg-brand-gradient shadow-soft hover:shadow-soft-lg h-10 min-h-0 w-10 min-w-0 rounded-full p-0"
              >
                <Square className="h-4 w-4" fill="currentColor" />
              </Button>
            </>
          ) : value.trim() ? (
            <>
              <ImageUploadButton
                pickerRef={filePickerRef}
                onSelect={addFiles}
                disabled={pending || upload.isPending}
              />
              <Button
                type="button"
                onClick={send}
                disabled={!value.trim() || pending}
                aria-label="Send message"
                className="bg-brand-gradient shadow-soft hover:shadow-soft-lg h-10 min-h-0 w-10 min-w-0 rounded-full p-0"
              >
                <Send className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <ImageUploadButton
                pickerRef={filePickerRef}
                onSelect={addFiles}
                disabled={pending || upload.isPending}
              />
              <Button
                type="button"
                onClick={startRecording}
                disabled={pending || upload.isPending}
                aria-label="Record voice note"
                variant="ghost"
                className={cn(
                  'h-10 min-h-0 w-10 min-w-0 rounded-full p-0',
                  'text-ink-muted hover:bg-bg-subtle hover:text-ink',
                )}
              >
                <Mic className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {staged.length > 0 ? (
        <ChatComposer
          items={staged}
          caption={value}
          onCaptionChange={setValue}
          onAddMore={addFiles}
          onRemove={removeStaged}
          onEditImage={(id) => setEditingId(id)}
          onSend={() => void sendStaged()}
          onClose={discardStaged}
          sending={sendingAttachments}
          suspended={editingItem !== null}
        />
      ) : null}

      {editingItem ? (
        <ImageEditorDialog
          file={editingItem.file}
          onCancel={() => setEditingId(null)}
          onConfirm={onEditorConfirm}
        />
      ) : null}
    </>
  );
});

function FormatButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // Keep the textarea selection: prevent the button from stealing focus
      // before the handler reads selectionStart/End.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'text-ink-muted grid h-7 w-7 place-items-center rounded',
        'hover:bg-bg-subtle hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

function ImageUploadButton({
  pickerRef,
  onSelect,
  disabled,
}: {
  pickerRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (files: FileList | File[]) => void | Promise<void>;
  disabled?: boolean;
}) {
  return (
    <>
      {/* Hidden picker - accepts any file type now (images, PDFs, docs,
          audio, video, archives). The bubble renderer already branches
          on MIME type so images preview inline, audio gets a player,
          and everything else shows as a downloadable filename chip. */}
      <input
        ref={pickerRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            void onSelect(files);
          }
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        aria-label="Attach file"
        onClick={() => pickerRef.current?.click()}
        className={cn(
          'h-10 min-h-0 w-10 min-w-0 rounded-full p-0',
          'text-ink-muted hover:bg-bg-subtle hover:text-ink',
        )}
      >
        <ImagePlus className="h-4 w-4" />
      </Button>
    </>
  );
}
