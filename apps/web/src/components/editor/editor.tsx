'use client';

import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Loader } from '@/components/ui/loader';
import { cn } from '@/lib/utils';
import { toastError } from '@/lib/toast';

import { CustomImage } from './custom-image';
import { baseExtensions } from './extensions-base';
import { InlineBubbleMenu } from './inline-bubble-menu';
import { buildSlashItems, SlashCommand, SlashMenuList, type SlashItem } from './slash-menu';
import { EditorToolbar } from './toolbar';
import { useImageUpload } from './use-image-upload';

const SAVE_DEBOUNCE_MS = 1000;
const EMPTY_DOC = { type: 'doc', content: [] };

export interface DocumentEditorProps {
  /** Initial document content. Read once on mount - see component contract. */
  value: unknown;
  /** Called after a debounce window when the editor's JSON content has changed. */
  onChange: (next: unknown) => void;
  editable?: boolean;
}

/**
 * Full-featured Tiptap editor.
 *
 * Mount-time contract (carried forward from the original placeholder editor;
 * it prevents the "documents editor save loop", where a refetch overwrites the
 * editor and re-triggers a save):
 *   - This component is the source of truth for the document while mounted.
 *   - `value` is read once on mount. Subsequent changes are ignored.
 *   - The PARENT must remount via `key={doc.id}` when switching documents.
 *   - `onChange` fires only after SAVE_DEBOUNCE_MS of idle time AND only when
 *     the JSON has actually changed since the last value we surfaced. This
 *     prevents the mutation → refetch → onUpdate save loop.
 */
export function DocumentEditor({ value, onChange, editable = true }: DocumentEditorProps) {
  const [initialContent] = useState<object>(() => (value as object | null) ?? EMPTY_DOC);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const lastEmittedRef = useRef<string>(JSON.stringify(initialContent));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const slash = useSlashController();

  // Stable extension array - recreating on every render would force Tiptap to
  // rebuild its schema, blow away cursor state, and re-render every node view.
  const extensions = useMemo(
    () => [
      ...baseExtensions({ includeImage: false }),
      CustomImage,
      SlashCommand.configure({
        suggestion: {
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          items: ({ query }) =>
            buildSlashItems().filter(
              (item) =>
                item.title.toLowerCase().includes(query.toLowerCase()) ||
                item.description.toLowerCase().includes(query.toLowerCase()),
            ),
          render: () => slash.renderHandlers,
          command: ({ editor, range, props }) => {
            const item = props as SlashItem;
            item.command({ editor, range });
          },
        },
      }),
    ],
    [slash.renderHandlers],
  );

  const editor = useEditor({
    extensions,
    content: initialContent,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn(
          'prose prose-sm max-w-none focus:outline-none',
          'prose-headings:font-semibold prose-headings:tracking-tight',
          'prose-pre:bg-ink prose-pre:text-slate-100 prose-pre:text-xs prose-pre:rounded-md',
          'prose-code:before:content-none prose-code:after:content-none',
          'prose-table:border prose-th:border prose-td:border prose-th:p-2 prose-td:p-2',
          'prose-img:rounded-md',
          'min-h-[320px] p-6',
        ),
      },
      handlePaste: (_view, event) => handleFiles(event.clipboardData?.files),
      handleDrop: (_view, event) => {
        if (event.dataTransfer && event.dataTransfer.files.length > 0) {
          event.preventDefault();
          return handleFiles(event.dataTransfer.files);
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const json = e.getJSON();
        const serialized = JSON.stringify(json);
        if (serialized === lastEmittedRef.current) return;
        lastEmittedRef.current = serialized;
        onChangeRef.current(json);
      }, SAVE_DEBOUNCE_MS);
    },
  });

  const uploadImage = useImageUpload();

  // Inserts an image with an optimistic placeholder, kicks off the upload, and
  // swaps src into the placeholder node once confirm() returns.
  const handleUploadImage = useCallback(
    async (file: File) => {
      if (!editor) return;
      const uploadId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `upl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const localUrl = URL.createObjectURL(file);

      editor
        .chain()
        .focus()
        .insertContent({
          type: 'image',
          attrs: { src: localUrl, uploading: true, uploadId, width: 100 },
        })
        .run();

      try {
        const result = await uploadImage(file);
        replaceImageById(editor, uploadId, {
          src: result.src,
          uploading: false,
          uploadId: null,
        });
      } catch (err) {
        removeImageById(editor, uploadId);
        toastError(err, "Couldn't upload image");
      } finally {
        URL.revokeObjectURL(localUrl);
      }
    },
    [editor, uploadImage],
  );

  function handleFiles(files: FileList | null | undefined): boolean {
    if (!files || files.length === 0) return false;
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return false;
    for (const file of images) void handleUploadImage(file);
    return true;
  }

  if (!editor) {
    return (
      <div className="card overflow-visible">
        <div className="border-line bg-bg-subtle h-12 border-b" aria-hidden />
        <div className="flex min-h-[320px] items-center justify-center p-6">
          <Loader label="Loading editor" />
        </div>
      </div>
    );
  }

  return (
    <div className="card overflow-visible">
      {editable ? <EditorToolbar editor={editor} onUploadImage={handleUploadImage} /> : null}
      <EditorContent editor={editor} />
      {editable ? <InlineBubbleMenu editor={editor} /> : null}
      {slash.popover}
      <FooterBar editor={editor} />
    </div>
  );
}

function FooterBar({ editor }: { editor: Editor }) {
  // Tiptap's `characters()` returns 0 until the editor finishes its first
  // transaction; gracefully render "-" before that to avoid layout jitter.
  const characters = editor.storage.characterCount?.characters?.() ?? 0;
  const words = editor.storage.characterCount?.words?.() ?? 0;
  return (
    <div className="border-line bg-bg-subtle/50 text-ink-muted flex items-center justify-end gap-3 border-t px-3 py-1.5 text-[11px]">
      <span>{words.toLocaleString()} words</span>
      <span>{characters.toLocaleString()} characters</span>
    </div>
  );
}

interface SlashPopoverState {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  rect: DOMRect;
}

interface SlashController {
  popover: ReactElement | null;
  renderHandlers: {
    onStart: (props: SlashRenderProps) => void;
    onUpdate: (props: SlashRenderProps) => void;
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
    onExit: () => void;
  };
}

interface SlashRenderProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  clientRect?: (() => DOMRect | null) | null;
}

/**
 * Drives the slash-menu popover from outside the suggestion plugin: the plugin
 * pushes lifecycle events into React state via `renderHandlers`, and the React
 * tree renders a positioned popover bound to a forwardRef so the plugin can
 * still forward key events into the list's keyboard navigation.
 */
function useSlashController(): SlashController {
  const [state, setState] = useState<SlashPopoverState | null>(null);
  const listRef = useRef<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>(null);

  const renderHandlers = useMemo(
    () => ({
      onStart: (props: SlashRenderProps) => {
        const rect = props.clientRect?.();
        if (!rect) return;
        setState({ items: props.items, command: props.command, rect });
      },
      onUpdate: (props: SlashRenderProps) => {
        const rect = props.clientRect?.();
        if (!rect) {
          setState(null);
          return;
        }
        setState({ items: props.items, command: props.command, rect });
      },
      onKeyDown: ({ event }: { event: KeyboardEvent }): boolean => {
        if (event.key === 'Escape') {
          setState(null);
          return true;
        }
        return listRef.current?.onKeyDown(event) ?? false;
      },
      onExit: () => setState(null),
    }),
    [],
  );

  // Position the popover just below the caret. `clientRect()` from Suggestion
  // is viewport-relative - adding window.scrollY pins it to the document so it
  // doesn't drift when the page scrolls during the open state.
  const popover = state ? (
    <div
      style={{
        position: 'fixed',
        top: state.rect.bottom + 6,
        left: state.rect.left,
        zIndex: 60,
      }}
    >
      <SlashMenuList ref={listRef} items={state.items} command={state.command} />
    </div>
  ) : null;

  return { popover, renderHandlers };
}

function replaceImageById(
  editor: Editor,
  uploadId: string,
  attrs: { src: string; uploading: boolean; uploadId: string | null },
): void {
  const { state } = editor;
  let pos: number | null = null;
  state.doc.descendants((node, nodePos) => {
    if (node.type.name === 'image' && node.attrs.uploadId === uploadId) {
      pos = nodePos;
      return false;
    }
    return true;
  });

  if (pos == null) return;

  // Use a single transaction to update attributes and clear the upload ID.
  // We disable history for this step so 'undo' takes the user back to before the image was dropped,
  // rather than to the 'uploading' state.
  editor
    .chain()
    .setNodeSelection(pos)
    .updateAttributes('image', attrs)
    .setMeta('addToHistory', false)
    .run();
}

function removeImageById(editor: Editor, uploadId: string): void {
  const { state } = editor;
  let pos: number | null = null;
  let size = 0;
  state.doc.descendants((node, nodePos) => {
    if (node.type.name === 'image' && node.attrs.uploadId === uploadId) {
      pos = nodePos;
      size = node.nodeSize;
      return false;
    }
    return true;
  });
  if (pos == null) return;
  editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: pos + size })
    .run();
}
