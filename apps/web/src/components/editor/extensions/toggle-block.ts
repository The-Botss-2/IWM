import { mergeAttributes, Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toggleBlock: {
      setToggleBlock: () => ReturnType;
    };
  }
}

/**
 * Collapsible block built on the native `<details>` element so it works in the
 * public reader's static HTML without any client-side logic. Tiptap stores
 * structure as `<details data-toggle><summary>…</summary><div>…</div></details>`.
 */
export const ToggleBlock = Node.create({
  name: 'toggleBlock',
  group: 'block',
  content: 'toggleSummary toggleBody',
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'details[data-toggle]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(HTMLAttributes, {
        'data-toggle': 'true',
        class: 'botss-toggle',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setToggleBlock:
        () =>
        ({ chain }) =>
          chain()
            .insertContent({
              type: 'toggleBlock',
              content: [
                { type: 'toggleSummary', content: [{ type: 'text', text: 'Toggle' }] },
                {
                  type: 'toggleBody',
                  content: [{ type: 'paragraph' }],
                },
              ],
            })
            .run(),
    };
  },
});

export const ToggleSummary = Node.create({
  name: 'toggleSummary',
  content: 'inline*',
  defining: true,

  parseHTML() {
    return [{ tag: 'summary' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['summary', mergeAttributes(HTMLAttributes, { class: 'botss-toggle-summary' }), 0];
  },
});

export const ToggleBody = Node.create({
  name: 'toggleBody',
  content: 'block+',
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-toggle-body]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-toggle-body': 'true',
        class: 'botss-toggle-body',
      }),
      0,
    ];
  },
});
