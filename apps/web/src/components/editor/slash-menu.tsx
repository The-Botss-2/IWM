'use client';

import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import {
  AlertTriangle,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Info,
  List,
  ListOrdered,
  Minus,
  Quote,
  Table as TableIcon,
} from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useState, type ComponentType } from 'react';

export interface SlashItem {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  command: (props: { editor: Editor; range: Range }) => void;
}

/**
 * Block-level commands available from the `/` menu. Inline marks (bold, italic,
 * etc.) live in the BubbleMenu - they don't take an empty selection anyway.
 *
 * `image:openPicker` is dispatched as a DOM event because the slash command
 * runs inside the editor's plugin layer and doesn't have access to the React
 * file-picker ref. The toolbar listens for it and triggers a click on its
 * hidden `<input type="file">`.
 */
export function buildSlashItems(): SlashItem[] {
  return [
    {
      title: 'Heading 1',
      description: 'Large section heading',
      icon: Heading1,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
    },
    {
      title: 'Heading 2',
      description: 'Medium section heading',
      icon: Heading2,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
    },
    {
      title: 'Heading 3',
      description: 'Small section heading',
      icon: Heading3,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
    },
    {
      title: 'Bullet list',
      description: 'Bulleted list',
      icon: List,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      title: 'Numbered list',
      description: 'Numbered list',
      icon: ListOrdered,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      title: 'Checklist',
      description: 'To-do checkboxes',
      icon: CheckSquare,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleTaskList().run(),
    },
    {
      title: 'Quote',
      description: 'Blockquote',
      icon: Quote,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      title: 'Code block',
      description: 'Fenced code block with syntax highlighting',
      icon: Code,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      title: 'Divider',
      description: 'Horizontal rule',
      icon: Minus,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
    {
      title: 'Image',
      description: 'Upload an image from your computer',
      icon: ImageIcon,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();
        // The toolbar component listens for this event and triggers the file
        // picker. Decoupled because the slash plugin runs outside React.
        window.dispatchEvent(new CustomEvent('botss-editor:open-image-picker'));
      },
    },
    {
      title: 'Table',
      description: '3×3 table',
      icon: TableIcon,
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      title: 'Callout',
      description: 'Info / warning / success aside',
      icon: Info,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setCallout('info').run(),
    },
    {
      title: 'Warning callout',
      description: 'Highlight a risk or caveat',
      icon: AlertTriangle,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setCallout('warning').run(),
    },
    {
      title: 'Toggle',
      description: 'Collapsible block with summary',
      icon: ChevronRight,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setToggleBlock().run(),
    },
    {
      title: 'Date',
      description: 'Insert today as a date chip',
      icon: CalendarDays,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).insertDateChip().run(),
    },
  ];
}

interface SlashMenuListRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface SlashMenuListProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

export const SlashMenuList = forwardRef<SlashMenuListRef, SlashMenuListProps>(
  function SlashMenuList({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'ArrowUp') {
          setSelectedIndex((i) => (i + items.length - 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowDown') {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === 'Enter') {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="border-line text-ink-muted rounded-md border bg-white px-3 py-2 text-xs shadow-lg">
          No commands match.
        </div>
      );
    }

    return (
      <div className="border-line max-h-80 w-72 overflow-y-auto rounded-md border bg-white p-1 shadow-lg">
        {items.map((item, i) => {
          const Icon = item.icon;
          const active = i === selectedIndex;
          return (
            <button
              key={item.title}
              type="button"
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => command(item)}
              className={`flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                active ? 'bg-brand-50 text-brand-700' : 'text-ink hover:bg-bg-subtle'
              }`}
            >
              <Icon className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
              <span className="flex-1">
                <span className="block font-medium">{item.title}</span>
                <span className="text-ink-muted block text-xs">{item.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  },
);

interface SlashCommandOptions {
  suggestion: Omit<SuggestionOptions, 'editor'>;
}

/**
 * Tiptap extension that wires `@tiptap/suggestion` to fire on `/` and route
 * keystrokes into the React popover above. The popover itself is mounted by
 * the consumer via `render` - we just provide the plumbing.
 */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor;
          range: Range;
          props: { command: (params: { editor: Editor; range: Range }) => void };
        }) => {
          props.command({ editor, range });
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
