'use client';

import { EditorContent, useEditor } from '@tiptap/react';
import { ImagePlus, MoreHorizontal, Pencil, Send, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Comment, CreateCommentInput } from '@botss/shared-types';

import { CustomImage } from '@/components/editor/custom-image';
import { baseExtensions } from '@/components/editor/extensions-base';
import { useImageUpload } from '@/components/editor/use-image-upload';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { Tooltip } from '@/components/ui/tooltip';
import { useSessionContext } from '@/components/auth/session-gate';
import {
  useCreateComment,
  useDeleteComment,
  useTaskComments,
  useUpdateComment,
} from '@/hooks/use-comments';
import { cn } from '@/lib/utils';
import { absoluteTime, relativeTime } from '@/lib/time';
import { toastError, toastErrorMessage } from '@/lib/toast';

interface TaskCommentsProps {
  taskId: string;
}

/** Read-only base extension set used by the rendered comment bubbles. The
 *  composer adds its own image+upload glue on top. */
const READ_ONLY_EXTENSIONS = baseExtensions({ includeImage: true, placeholder: '' });

export function TaskComments({ taskId }: TaskCommentsProps) {
  const session = useSessionContext();
  const user = session.data?.user;
  const list = useTaskComments(taskId);

  const items = list.data?.items ?? [];

  return (
    <section aria-label="Comments" className="border-line space-y-4 border-t pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-ink-muted text-xs font-semibold uppercase tracking-wide">
          Comments {items.length > 0 ? `(${items.length})` : null}
        </h3>
      </div>

      <ul className="space-y-3" role="list">
        {list.isLoading ? (
          <li className="flex items-center gap-2 py-2">
            <Loader size="xs" label="Loading comments" />
          </li>
        ) : list.isError && !list.data ? (
          <li>
            <QueryError
              compact
              message="Couldn't load comments."
              onRetry={() => void list.refetch()}
            />
          </li>
        ) : items.length === 0 ? (
          <li className="text-ink-disabled text-sm">No comments yet.</li>
        ) : (
          items.map((c) => (
            <li key={c.id}>
              <CommentItem comment={c} taskId={taskId} currentUserId={user?.id ?? null} />
            </li>
          ))
        )}
      </ul>

      {user ? (
        <CommentComposer
          taskId={taskId}
          author={{
            id: user.id,
            name: user.name ?? user.email ?? '-',
            email: user.email,
            image: user.image ?? null,
          }}
        />
      ) : null}
    </section>
  );
}

interface CommentItemProps {
  comment: Comment;
  taskId: string;
  currentUserId: string | null;
}

function CommentItem({ comment, taskId, currentUserId }: CommentItemProps) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateComment(taskId);
  const remove = useDeleteComment(taskId);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMine = comment.authorId === currentUserId;

  const editor = useEditor(
    {
      extensions: READ_ONLY_EXTENSIONS,
      editable: false,
      // Read-only renderer. Re-mount on content changes so server-pushed edits
      // and rollbacks are reflected immediately.
      content: comment.content as object,
      immediatelyRender: false,
    },
    [JSON.stringify(comment.content)],
  );

  if (editing) {
    return (
      <CommentEditor
        initialContent={comment.content}
        initialAttachmentIds={comment.attachments.map((a) => a.fileObjectId)}
        author={comment.author}
        timestamp={comment.createdAt}
        edited={!!comment.editedAt}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={async (input) => {
          await update.mutateAsync({ id: comment.id, input });
          setEditing(false);
        }}
      />
    );
  }

  return (
    <article className="flex gap-3">
      <UserAvatar
        size="sm"
        name={comment.author.name || comment.author.email}
        image={comment.author.image}
      />
      <div className="min-w-0 flex-1">
        <header className="flex items-center gap-2 text-xs">
          <span className="text-ink font-medium">
            {comment.author.name || comment.author.email}
          </span>
          <Tooltip content={absoluteTime(comment.createdAt)}>
            <span className="text-ink-muted">{relativeTime(comment.createdAt)}</span>
          </Tooltip>
          {comment.editedAt ? <span className="text-ink-disabled">· edited</span> : null}
          {isMine ? (
            <div className="relative ml-auto">
              <button
                type="button"
                aria-label="Comment actions"
                onClick={() => setMenuOpen((o) => !o)}
                onBlur={() => setTimeout(() => setMenuOpen(false), 100)}
                className="text-ink-disabled hover:bg-bg-subtle hover:text-ink focus-visible:shadow-focus rounded p-1 focus-visible:outline-none focus-visible:ring-2"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
              {menuOpen ? (
                <div className="border-line absolute right-0 z-10 mt-1 w-max min-w-[8rem] rounded-md border bg-white py-1 shadow-md">
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setMenuOpen(false);
                      setEditing(true);
                    }}
                    className="text-ink hover:bg-bg-subtle flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setMenuOpen(false);
                      remove.mutate(comment.id);
                    }}
                    className="text-state-error hover:bg-tint-error flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </header>
        <div className="prose prose-sm text-ink mt-1 max-w-none">
          <EditorContent editor={editor} />
        </div>
      </div>
    </article>
  );
}

interface CommentComposerProps {
  taskId: string;
  author: { id: string; name: string; email: string; image: string | null };
}

function CommentComposer({ taskId, author }: CommentComposerProps) {
  const create = useCreateComment(taskId, author);
  return (
    <CommentEditor
      initialContent={null}
      initialAttachmentIds={[]}
      author={author}
      submitLabel="Send"
      onSubmit={async (input) => {
        await create.mutateAsync(input);
      }}
      resetOnSubmit
    />
  );
}

interface CommentEditorProps {
  initialContent: unknown;
  initialAttachmentIds: string[];
  author: { id: string; name: string; email: string; image: string | null };
  timestamp?: Date;
  edited?: boolean;
  submitLabel: string;
  onSubmit: (input: CreateCommentInput) => Promise<void>;
  onCancel?: () => void;
  resetOnSubmit?: boolean;
}

const EMPTY_DOC = { type: 'doc', content: [] };

function CommentEditor({
  initialContent,
  initialAttachmentIds,
  author,
  submitLabel,
  onSubmit,
  onCancel,
  resetOnSubmit,
}: CommentEditorProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadImage = useImageUpload();
  // Track which file ids the editor has dropped into its content. Used as the
  // canonical attachment list at submit time. Rebuilt every render from the
  // editor's current document, so removing an image node removes it from the
  // attachments without manual bookkeeping.
  const seedIds = useMemo(() => new Set(initialAttachmentIds), [initialAttachmentIds]);
  const fileIdsRef = useRef<Set<string>>(new Set(seedIds));

  const editor = useEditor({
    extensions: [
      ...baseExtensions({ includeImage: false, placeholder: 'Add a comment…' }),
      CustomImage,
    ],
    content: (initialContent as object | null) ?? EMPTY_DOC,
    editable: true,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn('prose prose-sm max-w-none focus:outline-none min-h-[60px] px-3 py-2'),
      },
      handlePaste: (_view, event) => handlePastedFiles(event.clipboardData?.files),
      handleDrop: (_view, event) => {
        if (event.dataTransfer && event.dataTransfer.files.length > 0) {
          event.preventDefault();
          return handlePastedFiles(event.dataTransfer.files);
        }
        return false;
      },
    },
  });

  function handlePastedFiles(files: FileList | null | undefined): boolean {
    if (!files || files.length === 0) return false;
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return false;
    for (const file of images) void uploadAndInsert(file);
    return true;
  }

  async function uploadAndInsert(file: File): Promise<void> {
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
      // Patch the placeholder node with the permanent URL and track the file id.
      const { state } = editor;
      let pos: number | null = null;
      state.doc.descendants((node, p) => {
        if (node.type.name === 'image' && node.attrs.uploadId === uploadId) {
          pos = p;
          return false;
        }
        return true;
      });
      if (pos != null) {
        editor
          .chain()
          .setNodeSelection(pos)
          .updateAttributes('image', {
            src: result.src,
            uploading: false,
            uploadId: null,
          })
          .setMeta('addToHistory', false)
          .run();
      }
      fileIdsRef.current.add(result.file.id);
    } catch (err) {
      // Remove the failed placeholder node.
      const { state } = editor;
      let pos: number | null = null;
      let size = 0;
      state.doc.descendants((node, p) => {
        if (node.type.name === 'image' && node.attrs.uploadId === uploadId) {
          pos = p;
          size = node.nodeSize;
          return false;
        }
        return true;
      });
      if (pos != null) {
        editor
          .chain()
          .focus()
          .deleteRange({ from: pos, to: pos + size })
          .run();
      }
      toastError(err, "Couldn't upload image");
    } finally {
      URL.revokeObjectURL(localUrl);
    }
  }

  // Submit handler - extracts plain text + JSON from the editor.
  async function submit() {
    if (!editor) return;
    const json = editor.getJSON();
    const text = editor.getText().trim();
    if (text.length === 0 && fileIdsRef.current.size === 0) {
      toastErrorMessage('Comment is empty');
      return;
    }
    const input: CreateCommentInput = {
      content: json as unknown,
      contentText: text,
      fileObjectIds: Array.from(fileIdsRef.current),
    };
    try {
      await onSubmit(input);
      if (resetOnSubmit) {
        editor.commands.clearContent();
        fileIdsRef.current = new Set();
      }
    } catch {
      // Toast surfaced by the mutation's onError.
    }
  }

  useEffect(() => {
    const node = editor?.view.dom;
    if (!node) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    };
    node.addEventListener('keydown', onKey);
    return () => node.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return (
    <div className="flex gap-3">
      <UserAvatar size="sm" name={author.name || author.email} image={author.image} />
      <div className="border-line min-w-0 flex-1 rounded-md border bg-white">
        <EditorContent editor={editor} />
        <div className="border-line flex items-center justify-between gap-2 border-t px-2 py-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Attach image"
              onClick={() => fileInputRef.current?.click()}
              className="text-ink-muted hover:bg-bg-subtle hover:text-ink focus-visible:shadow-focus inline-flex h-7 w-7 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2"
            >
              <ImagePlus className="h-4 w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadAndInsert(file);
                e.target.value = '';
              }}
            />
            <span className="text-ink-disabled hidden text-[10px] sm:inline">
              Ctrl/Cmd+Enter to send
            </span>
          </div>
          <div className="flex items-center gap-2">
            {onCancel ? (
              <Button variant="ghost" size="sm" onClick={onCancel}>
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            ) : null}
            <Button size="sm" onClick={submit}>
              <Send className="h-3.5 w-3.5" />
              {submitLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
