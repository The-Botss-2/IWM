import { mergeAttributes, Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    dateChip: {
      insertDateChip: (date?: Date) => ReturnType;
    };
  }
}

/**
 * Inline date chip. Stores the date as an ISO string in `data-date` so the
 * public reader can localize on the server. Currently displays the date as
 * `YYYY-MM-DD`; richer formatting (relative / via Intl) is a follow-up.
 */
export const DateChip = Node.create({
  name: 'dateChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      date: {
        default: null as string | null,
        parseHTML: (el) => el.getAttribute('data-date'),
        renderHTML: (attrs) => (attrs.date ? { 'data-date': attrs.date as string } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-date-chip]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const iso = (node.attrs.date as string | null) ?? '';
    const label = iso ? iso.slice(0, 10) : 'date';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-date-chip': 'true',
        class: 'botss-date-chip',
      }),
      label,
    ];
  },

  addCommands() {
    return {
      insertDateChip:
        (date) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { date: (date ?? new Date()).toISOString() },
          }),
    };
  },
});
