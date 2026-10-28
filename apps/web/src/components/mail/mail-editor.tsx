'use client';

import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  Underline as UnderlineIcon,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { CustomImage } from '@/components/editor/custom-image';
import { useFileUpload } from '@/hooks/use-file-upload';
import { promptDialog } from '@/lib/prompt';
import { toastError, toastErrorMessage } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface Props {
  /** Initial HTML content. Read once on mount - see contract below. */
  initialHtml: string;
  /** Fires on every edit with both HTML and a derived plain-text projection. */
  onChange: (next: { html: string; text: string }) => void;
  placeholder?: string;
  /** Reset signal: when this string changes the editor content is replaced
   *  with `initialHtml`. Use to hydrate the compose dialog from a draft or
   *  reply prefill without remounting the whole dialog. */
  resetKey?: string;
}

/**
 * Compose-window rich-text editor. Smaller-footprint cousin of the document
 * editor - no slash menu, no images-by-upload, no tables. Just the inline
 * formatting people expect when writing email.
 */
export function MailEditor({ initialHtml, onChange, placeholder, resetKey }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Mail uses inline-only structure; drop heavy block nodes the toolbar
        // doesn't expose anyway.
        heading: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      }),
      // Resizable image node view (drag handle + width presets + alignment),
      // shared with the document editor so signature and compose images can be
      // sized just like everywhere else images are inserted between text.
      CustomImage,
      Placeholder.configure({ placeholder: placeholder ?? 'Write your message…' }),
    ],
    content: initialHtml || '',
    editorProps: {
      attributes: {
        // Tailwind preflight strips list-style + padding from ul/ol, so the
        // bullet / numbered list toolbar buttons toggle the node but render
        // visually identical to plain paragraphs. Restore the markers via
        // arbitrary child selectors so toggling lists is actually visible.
        class:
          'min-h-[200px] max-h-[420px] overflow-y-auto rounded-md border border-line bg-white px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-brand-500/30 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5 [&_li>p]:m-0 [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-ink-muted [&_a]:text-brand-700 [&_a]:underline [&_img]:max-w-full [&_img]:rounded [&_img]:my-1',
      },
    },
    onUpdate({ editor }) {
      onChange({ html: editor.getHTML(), text: editor.getText() });
    },
    // Tiptap v2 sometimes warns about SSR hydration; suppressing per docs is
    // safe in a 'use client' module.
    immediatelyRender: false,
  });

  useEffect(() => {
    if (!editor) return;
    if (resetKey === undefined) return;
    editor.commands.setContent(initialHtml || '', false);
    // We intentionally key on resetKey only - initialHtml is captured once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, editor]);

  // URL entry goes through an in-app dialog (promptDialog) rather than
  // window.prompt: the desktop (Electron) shell does not implement
  // window.prompt, so it silently returns null and links/images could never
  // be inserted there.
  const setLink = useCallback(async () => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = await promptDialog({
      title: 'Insert link',
      description: 'Enter the web address to link to.',
      defaultValue: prev ?? 'https://',
      placeholder: 'https://example.com',
      confirmLabel: 'Insert',
      clearLabel: 'Remove link',
      inputType: 'url',
    });
    if (url === null) return;
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  }, [editor]);

  // Image insertion - by upload (to object storage) or by pasting a URL.
  const [imgMenu, setImgMenu] = useState(false);
  const imgFileRef = useRef<HTMLInputElement>(null);
  const upload = useFileUpload();

  const insertImage = useCallback(
    (src: string) => {
      if (!editor || !src) return;
      editor.chain().focus().setImage({ src }).run();
    },
    [editor],
  );

  const insertImageFromUrl = useCallback(async () => {
    setImgMenu(false);
    const url = await promptDialog({
      title: 'Insert image from URL',
      description: 'Paste a direct image URL.',
      defaultValue: 'https://',
      placeholder: 'https://example.com/image.png',
      confirmLabel: 'Insert',
      inputType: 'url',
    });
    if (url) insertImage(url.trim());
  }, [insertImage]);

  const onPickImageFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        const obj = await upload.mutateAsync(file);
        if (obj.url) insertImage(obj.url);
        else
          toastErrorMessage(`Couldn't insert ${file.name}`, {
            description: 'The upload finished but the server returned no link. Try again.',
          });
      } catch (err) {
        toastError(err, `Couldn't upload ${file.name}`);
      }
    },
    [upload, insertImage],
  );

  if (!editor) {
    return (
      <div className="border-line bg-bg-subtle flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-md border px-3 py-2">
        <Loader size="sm" label="Loading editor" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="border-line bg-bg-subtle flex flex-wrap items-center gap-0.5 rounded-md border px-1 py-1">
        <ToolButton
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          label="Bold"
        >
          <Bold className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          label="Italic"
        >
          <Italic className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          label="Underline"
        >
          <UnderlineIcon className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          label="Strikethrough"
        >
          <Strikethrough className="h-4 w-4" />
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-slate-300" aria-hidden />
        <ToolButton
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          label="Bulleted list"
        >
          <List className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          label="Numbered list"
        >
          <ListOrdered className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          label="Quote"
        >
          <Quote className="h-4 w-4" />
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-slate-300" aria-hidden />
        <ToolButton
          active={editor.isActive('link')}
          onClick={() => void setLink()}
          label="Insert link"
        >
          <LinkIcon className="h-4 w-4" />
        </ToolButton>
        <div className="relative">
          <ToolButton
            active={imgMenu}
            onClick={() => setImgMenu((v) => !v)}
            onBlur={() => setTimeout(() => setImgMenu(false), 150)}
            label="Insert image"
          >
            <ImagePlus className="h-4 w-4" />
          </ToolButton>
          {imgMenu ? (
            <div className="border-line absolute left-0 z-10 mt-1 w-max min-w-[10rem] rounded-md border bg-white py-1 shadow-md">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setImgMenu(false);
                  imgFileRef.current?.click();
                }}
                disabled={upload.isPending}
                className="text-ink hover:bg-bg-subtle flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                {upload.isPending ? 'Uploading…' : 'Upload…'}
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void insertImageFromUrl()}
                className="text-ink hover:bg-bg-subtle flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
              >
                <LinkIcon className="h-3.5 w-3.5" />
                From URL…
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <input
        ref={imgFileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void onPickImageFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <EditorContent editor={editor} />
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  onBlur,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  onBlur?: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      onBlur={onBlur}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'text-ink-muted hover:text-ink h-7 w-7 rounded',
        active && 'text-brand-700 bg-white shadow-sm',
      )}
    >
      {children}
    </Button>
  );
}
