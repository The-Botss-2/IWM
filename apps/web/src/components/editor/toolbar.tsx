'use client';

import type { Editor } from '@tiptap/react';
import {
  CheckSquare,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Table as TableIcon,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, type ComponentType } from 'react';

import { cn } from '@/lib/utils';

interface Props {
  editor: Editor;
  onUploadImage: (file: File) => void;
}

/**
 * Sticky toolbar of block-level controls. Inline marks (B, I, U, S, code, link)
 * live in the BubbleMenu - they only make sense with an active selection.
 *
 * The hidden file `<input>` doubles as both the toolbar's image button and the
 * target of the slash-command "Image" entry (which dispatches a custom event).
 */
export function EditorToolbar({ editor, onUploadImage }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onOpen = (): void => fileInputRef.current?.click();
    window.addEventListener('botss-editor:open-image-picker', onOpen);
    return () => window.removeEventListener('botss-editor:open-image-picker', onOpen);
  }, []);

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-line bg-white/95 px-2 py-1.5 backdrop-blur">
      <ToolbarButton
        editor={editor}
        label="Undo"
        icon={Undo2}
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      />
      <ToolbarButton
        editor={editor}
        label="Redo"
        icon={Redo2}
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      />
      <Separator />
      <ToolbarButton
        editor={editor}
        label="Heading 1"
        icon={Heading1}
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      />
      <ToolbarButton
        editor={editor}
        label="Heading 2"
        icon={Heading2}
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <ToolbarButton
        editor={editor}
        label="Heading 3"
        icon={Heading3}
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <Separator />
      <ToolbarButton
        editor={editor}
        label="Bullet list"
        icon={List}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        editor={editor}
        label="Numbered list"
        icon={ListOrdered}
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton
        editor={editor}
        label="Checklist"
        icon={CheckSquare}
        active={editor.isActive('taskList')}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      />
      <ToolbarButton
        editor={editor}
        label="Quote"
        icon={Quote}
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <ToolbarButton
        editor={editor}
        label="Code block"
        icon={Code}
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      />
      <ToolbarButton
        editor={editor}
        label="Divider"
        icon={Minus}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      />
      <Separator />
      <ToolbarButton
        editor={editor}
        label="Insert table"
        icon={TableIcon}
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
      />
      <ToolbarButton
        editor={editor}
        label="Insert image"
        icon={ImageIcon}
        onClick={() => fileInputRef.current?.click()}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUploadImage(file);
          // Reset so picking the same file twice still fires a change event.
          e.target.value = '';
        }}
      />
    </div>
  );
}

interface ToolbarButtonProps {
  editor: Editor;
  label: string;
  icon: ComponentType<{ className?: string }>;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function ToolbarButton({
  editor,
  label,
  icon: Icon,
  active = false,
  disabled = false,
  onClick,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled || !editor.isEditable}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded text-ink-muted hover:bg-bg-subtle hover:text-ink',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'bg-brand-50 text-brand-700' : '',
      )}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function Separator() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-line" />;
}
