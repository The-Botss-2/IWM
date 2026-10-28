'use client';

import { BubbleMenu, type Editor } from '@tiptap/react';
import {
  Bold,
  Code,
  Italic,
  Link as LinkIcon,
  Strikethrough,
  Underline as UnderlineIcon,
  Unlink,
} from 'lucide-react';

import { promptDialog } from '@/lib/prompt';
import { cn } from '@/lib/utils';

interface Props {
  editor: Editor;
}

/**
 * Floating toolbar shown above the current text selection. Only inline marks
 * appear here - block-level controls live in the fixed top toolbar where they
 * stay reachable without a selection.
 */
export function InlineBubbleMenu({ editor }: Props) {
  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={{ duration: 80, placement: 'top' }}
      shouldShow={({ editor: e, from, to }) => {
        if (!e.isEditable) return false;
        // Hide on collapsed selection or when the cursor is inside an image
        // node-view (the resize handle would otherwise collide with this menu).
        if (from === to) return false;
        if (e.isActive('image')) return false;
        return true;
      }}
      className="border-line flex items-center gap-0.5 rounded-md border bg-white p-1 shadow-lg"
    >
      <MarkButton
        editor={editor}
        label="Bold"
        icon={Bold}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <MarkButton
        editor={editor}
        label="Italic"
        icon={Italic}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <MarkButton
        editor={editor}
        label="Underline"
        icon={UnderlineIcon}
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <MarkButton
        editor={editor}
        label="Strikethrough"
        icon={Strikethrough}
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <MarkButton
        editor={editor}
        label="Inline code"
        icon={Code}
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
      <MarkButton
        editor={editor}
        label={editor.isActive('link') ? 'Remove link' : 'Add link'}
        icon={editor.isActive('link') ? Unlink : LinkIcon}
        active={editor.isActive('link')}
        onClick={() => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
            return;
          }
          const prev = editor.getAttributes('link').href as string | undefined;
          // window.prompt is a no-op in the Electron desktop shell, so URL
          // entry goes through the in-app prompt dialog instead.
          void promptDialog({
            title: 'Add link',
            description: 'Enter the web address to link to.',
            defaultValue: prev ?? 'https://',
            placeholder: 'https://example.com',
            confirmLabel: 'Add link',
            inputType: 'url',
          }).then((input) => {
            if (input === null) return;
            const url = input.trim();
            if (url.length === 0) {
              editor.chain().focus().unsetLink().run();
              return;
            }
            editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
          });
        }}
      />
    </BubbleMenu>
  );
}

interface MarkButtonProps {
  editor: Editor;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  onClick: () => void;
}

function MarkButton({ editor, label, icon: Icon, active = false, onClick }: MarkButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={!editor.isEditable}
      onClick={onClick}
      title={label}
      className={cn(
        'text-ink-muted hover:bg-bg-subtle hover:text-ink inline-flex h-8 w-8 items-center justify-center rounded',
        'focus-visible:shadow-focus focus-visible:outline-none focus-visible:ring-2',
        active ? 'bg-brand-50 text-brand-700' : '',
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
