/**
 * Tiptap extension set used for SERVER-SIDE rendering (`generateHTML`) by the
 * public reader. Anything that depends on the browser (React node views, paste
 * handlers, slash-menu UI) is added separately inside `editor.tsx` for the
 * editable client. Keeping both lists in sync is essential - diverging schemas
 * would corrupt round-tripped content.
 */
import { Blockquote } from '@tiptap/extension-blockquote';
import { CharacterCount } from '@tiptap/extension-character-count';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { Typography } from '@tiptap/extension-typography';
import { Underline } from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { createLowlight, common } from 'lowlight';

import { Callout } from './extensions/callout';
import { DateChip } from './extensions/date-chip';
import { Mention } from './extensions/mention';
import { ToggleBlock, ToggleBody, ToggleSummary } from './extensions/toggle-block';

const lowlight = createLowlight(common);

interface BaseExtensionsOptions {
  placeholder?: string;
  /**
   * Whether to include the plain `Image` extension. The editable client passes
   * `false` and registers `CustomImage` (a React node view subclass) instead,
   * so we don't end up with two image schemas competing for the same node name.
   */
  includeImage?: boolean;
}

export function baseExtensions(options: BaseExtensionsOptions = {}) {
  const { placeholder, includeImage = true } = options;
  return [
    StarterKit.configure({
      // CodeBlockLowlight and Blockquote are configured explicitly below.
      codeBlock: false,
      blockquote: false,
      heading: { levels: [1, 2, 3] },
    }),
    Underline,
    Link.configure({
      // Surface clicks as navigation hints, not auto-followed by the editor.
      openOnClick: false,
      autolink: true,
      // Explicit scheme allowlist so a stored `javascript:`/`data:` href can
      // never survive into the public reader's generateHTML output, instead of
      // relying on Tiptap's implicit default sanitization.
      protocols: ['http', 'https', 'mailto', 'tel'],
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    }),
    ...(includeImage ? [Image.configure({ inline: false, allowBase64: false })] : []),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    CodeBlockLowlight.configure({
      lowlight,
      exitOnTripleEnter: false,
      exitOnArrowDown: false,
    }),
    Blockquote,
    CharacterCount,
    Typography,
    Placeholder.configure({
      placeholder: placeholder ?? 'Type "/" for commands or start writing…',
    }),
    // Phase 3 Step H - advanced block extensions. KaTeX (math), iframe embeds,
    // and the code-block-with-copy-button upgrade are deferred to a follow-up
    // step because they require new deps (`katex`, `@tiptap/extension-mention`
    // suggestion driver, etc).
    Callout,
    ToggleBlock,
    ToggleSummary,
    ToggleBody,
    DateChip,
    Mention,
  ];
}
