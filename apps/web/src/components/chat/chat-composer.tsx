'use client';

import { FileText, Pencil, Plus, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A file staged for sending. `previewUrl` is a local object URL. */
export interface StagedItem {
  id: string;
  file: File;
  kind: 'image' | 'file';
  previewUrl: string;
}

/**
 * WhatsApp-style attachment composer. Shown as a full-screen overlay when the
 * user has staged one or more files (via the attach button or drag-and-drop).
 * Big preview of the selected item, a caption box (capped at ~8 lines), a
 * thumbnail strip to add more / remove / re-select, and Send.
 *
 * Only IMAGES are editable (the Edit pencil opens the crop/draw/text editor);
 * documents render as a labelled file card showing name + type.
 */
export function ChatComposer({
  items,
  caption,
  onCaptionChange,
  onAddMore,
  onRemove,
  onEditImage,
  onSend,
  onClose,
  sending,
  suspended = false,
}: {
  items: StagedItem[];
  caption: string;
  onCaptionChange: (v: string) => void;
  onAddMore: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  onEditImage: (id: string) => void;
  onSend: () => void;
  onClose: () => void;
  sending: boolean;
  /** True while the crop/draw editor is stacked on top - the window-level
   *  shortcuts below stand down so Enter belongs to the dialog, not to us. */
  suspended?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const addRef = useRef<HTMLInputElement>(null);
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const itemCount = items.length;

  // Keep a valid selection as items are added/removed.
  useEffect(() => {
    if (items.length === 0) return;
    if (!selectedId || !items.some((i) => i.id === selectedId)) {
      setSelectedId(items[items.length - 1]!.id);
    }
  }, [items, selectedId]);

  // Caption grows up to ~8 lines, then scrolls.
  useEffect(() => {
    const ta = captionRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [caption]);

  // Land the caret in the caption box as soon as the overlay opens, so the
  // very first keystroke after dropping / pasting an image goes somewhere
  // useful - and so Enter sends without the user having to click first.
  useEffect(() => {
    if (suspended) return;
    captionRef.current?.focus();
  }, [suspended]);

  // Window-level shortcuts. The caption textarea has its own handler for the
  // focused case; this covers the rest of the overlay (thumbnail strip, Edit
  // button, or a click on the backdrop) so Enter / Ctrl+Enter always sends
  // and Escape always discards, wherever focus happens to be.
  //
  // A caption is NEVER required - an image on its own is a complete message.
  useEffect(() => {
    if (suspended) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!sending) onClose();
        return;
      }
      if (e.key !== 'Enter') return;
      // Shift+Enter is "newline" and belongs to the textarea. Anything else
      // (plain Enter, Ctrl+Enter, Cmd+Enter) sends.
      if (e.shiftKey) return;
      if (e.isComposing) return;
      // The textarea's own onKeyDown already handled it; bailing here stops
      // a double send.
      if (e.target === captionRef.current) return;
      // Enter on a focused control means "activate this control" (remove a
      // thumbnail, open the file picker). Let the button have it - otherwise
      // removing an attachment with the keyboard would also fire the send.
      const el = e.target as HTMLElement | null;
      if (el?.closest('button, a, input, [role="button"]')) return;
      e.preventDefault();
      if (!sending && itemCount > 0) onSend();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [suspended, sending, itemCount, onSend, onClose]);

  const selected = items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  return (
    <div className="bg-ink/95 fixed inset-0 z-50 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 text-white">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Discard attachments"
          onClick={onClose}
          disabled={sending}
          className="text-white hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </Button>
        <span className="text-sm font-medium">
          {items.length === 1 ? '1 file' : `${items.length} files`}
        </span>
        {selected?.kind === 'image' ? (
          <Button
            variant="ghost"
            onClick={() => onEditImage(selected.id)}
            disabled={sending}
            className="ml-auto text-white hover:bg-white/10"
          >
            <Pencil className="mr-1 h-4 w-4" /> Edit
          </Button>
        ) : null}
      </div>

      {/* Big preview of the selected item */}
      <div className="flex flex-1 items-center justify-center overflow-hidden px-4">
        {selected ? (
          selected.kind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={selected.previewUrl}
              alt={selected.file.name}
              className="max-h-[70vh] max-w-full object-contain"
            />
          ) : (
            <FileCard file={selected.file} large />
          )
        ) : null}
      </div>

      {/* Caption box */}
      <div className="px-4">
        <textarea
          ref={captionRef}
          value={caption}
          onChange={(e) => onCaptionChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter (and Ctrl/Cmd+Enter) sends the staged attachment(s), with
            // or without a caption - matching the main composer. Shift+Enter
            // inserts a newline. (IME composition Enter is ignored so it
            // doesn't fire mid-typing.)
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!sending) onSend();
            }
          }}
          rows={1}
          placeholder="Add a caption (optional) - Enter to send, Shift+Enter for newline"
          disabled={sending}
          className="mx-auto block max-h-[200px] w-full max-w-2xl resize-none overflow-y-auto rounded-2xl bg-black/40 px-4 py-2.5 text-sm text-white ring-1 ring-white/15 placeholder:text-white/60 focus:outline-none focus:ring-white/30"
        />
      </div>

      {/* Thumbnail strip + send */}
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="flex flex-1 items-center gap-2 overflow-x-auto">
          {items.map((it) => (
            <div
              key={it.id}
              className={cn(
                'relative h-14 w-14 shrink-0 overflow-hidden rounded-lg ring-2',
                it.id === selectedId ? 'ring-white' : 'ring-transparent',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setSelectedId(it.id);
                  captionRef.current?.focus();
                }}
                className="block h-full w-full"
                aria-label={`Select ${it.file.name}`}
              >
                {it.kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.previewUrl}
                    alt={it.file.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-white/10 text-white">
                    <FileText className="h-5 w-5" />
                  </span>
                )}
              </button>
              {!sending ? (
                <button
                  type="button"
                  onClick={() => onRemove(it.id)}
                  aria-label={`Remove ${it.file.name}`}
                  className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          ))}
          {/* Add more */}
          <input
            ref={addRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) onAddMore(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => addRef.current?.click()}
            disabled={sending}
            aria-label="Add more files"
            className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-white/10 text-white hover:bg-white/20"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>
        <Button
          type="button"
          onClick={onSend}
          disabled={sending || items.length === 0}
          aria-label="Send"
          className="bg-brand-gradient shadow-soft h-12 min-h-0 w-12 min-w-0 rounded-full p-0"
        >
          <Send className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}

/** A document rendered as a labelled rectangle: filename + type. */
export function FileCard({ file, large }: { file: File; large?: boolean }) {
  const ext = (file.name.split('.').pop() ?? '').toUpperCase().slice(0, 6) || 'FILE';
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl bg-white/10 px-4 py-3 text-white',
        large && 'min-w-[260px]',
      )}
    >
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-white/15">
        <FileText className="h-6 w-6" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="block text-xs text-white/60">
          {ext} · {formatBytes(file.size)}
        </span>
      </span>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
