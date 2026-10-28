import { mergeAttributes, Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mention: {
      insertMention: (input: { userId: string; label: string }) => ReturnType;
    };
  }
}

/**
 * Inline @mention chip. Stores `userId` + the rendered display label. A full
 * `@`-typing UI (combobox driven by `@tiptap/suggestion`) is out of scope for
 * this step - the node itself is the durable artifact; the picker can be wired
 * later without touching public-reader rendering.
 *
 * Public reader renders the chip statically from `data-user-id` + the inner
 * text, so anonymous viewers see the mention without needing an active
 * Suggestion plugin.
 */
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      userId: {
        default: null as string | null,
        parseHTML: (el) => el.getAttribute('data-user-id'),
        renderHTML: (attrs) => (attrs.userId ? { 'data-user-id': attrs.userId as string } : {}),
      },
      label: {
        default: null as string | null,
        parseHTML: (el) => el.getAttribute('data-label') ?? el.textContent,
        renderHTML: (attrs) => (attrs.label ? { 'data-label': attrs.label as string } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = (node.attrs.label as string | null) ?? '@user';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-mention': 'true',
        class: 'botss-mention',
      }),
      `@${label}`,
    ];
  },

  addCommands() {
    return {
      insertMention:
        (input) =>
        ({ commands }) =>
          commands.insertContent([
            {
              type: this.name,
              attrs: { userId: input.userId, label: input.label },
            },
            { type: 'text', text: ' ' },
          ]),
    };
  },
});
